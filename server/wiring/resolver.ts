import type { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BODY_CHANNEL, buildComponentDetail } from "../lib/body"
import { type InvestigationResult, localBodyHost, routeFor } from "../lib/body-investigate"
import { knownPaths, runInvestigatorCli } from "../lib/body-investigator"
import { type DispatchWiring } from "../lib/dispatch-poller"
import { getDispatchTask, getTaskActivity } from "../lib/dispatch-tasks"
import { isDir, parseRepoMap, readRepoMapSource, repoForNote } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { appendTurn, createProposal, getTask, listProposals } from "../lib/orchestrator-chat"
import { getChannel } from "../lib/orchestrator-channels"
import { GENERAL_CHANNEL, db as companionDb } from "../lib/orchestrator-db"
import { QUICK_LOOK_ALLOWED, QUICK_LOOK_DISALLOWED } from "../lib/quick-look"
import { type ReadonlySpec, readonlyCwd, runReadonlyClaude } from "../lib/readonly-claude"
import { RESOLVER_SLUG, type ResolverConfig, isSensitivePr, resolverConfig, routable, sensitivePaths } from "../lib/resolver"
import { type ResolverEngine, createResolverEngine, maybeDigest } from "../lib/resolver-engine"
import { type ShFn, realSh, runPrFix } from "../lib/resolver-fix"
import type { EvidenceBlock, ResolverContext } from "../lib/resolver-prompt"
import { buildBodyResolverPrompt } from "../lib/resolver-prompt"
import { type ResolverStore, createResolverStore } from "../lib/resolver-store"
import { type WorkSeams, createResolverWork } from "../lib/resolver-work"
import type { SourceItem, TriageAction, TriageOption } from "../lib/triage"
import type { ExecOutcome } from "../lib/triage-engine"
import type { GhFn } from "../lib/triage-pr"
import { tursoQuery } from "../lib/turso"
import type { QueryFn } from "../lib/turso"
import { bodyReportApplier, investigationStore } from "./body-investigate"
import { emitTask, orchEmit } from "./orchestrator"
import { rejectProposal } from "./proposals"

// The Opus resolver, live (docs/orchestrator-triage-api.md#opus-resolver):
// the engine (lib/resolver-engine.ts) + the work (lib/resolver-work.ts) wired
// to Turso (evidence, read-only; agent_activity rows), `gh` (read-only review,
// comments), the read-only Opus runner, the PR fix run, the triage executor
// (every write through the existing guarded paths) and #General / #Body turns.
// Store host only (wiring/triage.ts decides).

const SYSTEM =
  "You are Opus, the read-only resolver in Jeremie's work queue. You may only read files and run the allowlisted read-only commands; " +
  "anything else is denied. Never edit, write, commit, push, merge, close, comment or delete anything — the server acts on your JSON, " +
  "within its policy. Never print secrets or token values. Finish with ONE JSON object and nothing after it."

export const RESOLVER_ALLOWED: readonly string[] = [
  ...QUICK_LOOK_ALLOWED,
  "Bash(gh pr view *)", "Bash(gh pr diff *)", "Bash(gh pr checks *)", "Bash(gh pr list *)", "Bash(gh pr status*)", "Bash(gh run view *)",
]
export const RESOLVER_DISALLOWED: readonly string[] = [...QUICK_LOOK_DISALLOWED, "Bash(gh * --web*)"]

export function resolverSpec(model: string, addDirs: string[]): ReadonlySpec {
  return { model, system: SYSTEM, settingSources: "", tools: "Read,Grep,Glob,Bash", addDirs, allowed: RESOLVER_ALLOWED, disallowed: RESOLVER_DISALLOWED }
}

/** Jeremie's memory files (standing rules / decisions), readable by the run. */
export function memoryDirs(home: string = process.env.HOME || homedir(), env: Record<string, string | undefined> = process.env, dirOk: (p: string) => boolean = isDir): string[] {
  const listed = env.COMPANION_RESOLVER_MEMORY_DIRS?.split(":").map((d) => d.trim()).filter(Boolean)
  const base = join(home, ".claude", "projects")
  const candidates = listed?.length ? listed : [join(base, "-Users-jeremieaubut", "memory"), join(base, home.replace(/[/.]/g, "-"), "memory")]
  return [...new Set(candidates)].filter(dirOk)
}

// ── evidence ─────────────────────────────────────────────────────────────────

const PR_JSON = "title,body,state,isDraft,headRefName,baseRefName,files,mergeable,mergeStateStatus,updatedAt,createdAt,statusCheckRollup"
const DIFF_MAX = 60_000

interface PrView { title?: string; body?: string; headRefName?: string; baseRefName?: string; files?: { path: string; additions: number; deletions: number }[] }

/** A local checkout of `owner/repo`: the note's REPO_MAP entry first, then any mapped path whose origin matches. */
async function localRepoFor(slug: string, hay: string, sh: ShFn): Promise<string | null> {
  const source = readRepoMapSource()
  if (!source) return null
  const entries = parseRepoMap(source)
  const ordered = [...entries.filter((e) => e.match.test(hay)), ...entries.filter((e) => !e.match.test(hay))]
  const seen = new Set<string>()
  for (const e of ordered) {
    if (seen.has(e.path) || !isDir(e.path)) continue
    seen.add(e.path)
    const r = await sh("git", ["-C", e.path, "remote", "get-url", "origin"], { cwd: e.path, timeoutMs: 10_000 })
    if (r.ok && r.out.trim().toLowerCase().replace(/\.git$/, "").endsWith(slug.toLowerCase())) return e.path
  }
  return null
}

async function noteBlock(q: QueryFn, noteId: string | null | undefined): Promise<{ block: EvidenceBlock | null; title: string | null }> {
  if (!noteId) return { block: null, title: null }
  const [n] = await q("SELECT title, body FROM notes WHERE id = ?", [noteId]).catch(() => [])
  if (!n) return { block: null, title: null }
  const title = String(n.title ?? "") || null
  const body = String(n.body ?? "").trim()
  return { block: body ? { label: `Project note ${noteId} (${title ?? ""})`, text: body.slice(0, 6000) } : null, title }
}

function stateBlock(repo: string | null): EvidenceBlock[] {
  return repo && existsSync(join(repo, "STATE.md")) ? [{ label: "STATE.md", text: `${join(repo, "STATE.md")} — read its Active Decisions before deciding.` }] : []
}

export interface LiveResolverOpts {
  dispatch: DispatchWiring
  gh: GhFn
  /** The triage executor (wiring/triage.ts). */
  execute: (src: SourceItem, option: TriageOption, text: string | null, by: string) => Promise<ExecOutcome>
  store: ResolverStore
  sh?: ShFn
}

export function liveSeams(o: LiveResolverOpts): WorkSeams {
  const q = o.dispatch.query
  const sh = o.sh ?? realSh
  const bodyPaths = new Map<string, { state: string; cwd: string | null; repo: boolean }>()

  async function gatherTask(taskId: string, blocks: EvidenceBlock[]): Promise<{ repo: string | null; text: string; noteTitle: string | null; noteId: string | null }> {
    const found = await getDispatchTask(q, await o.dispatch.columns(), taskId)
    if (!found) return { repo: null, text: "", noteTitle: null, noteId: null }
    blocks.push({ label: "Task description (the worker's brief; earlier answers appear as [unblock …] lines)", text: found.description || "(empty)" })
    const acts = await getTaskActivity(q, taskId).catch(() => [])
    if (acts.length) blocks.push({ label: "Task activity (newest first)", text: acts.map((a) => `${a.ts} ${a.action}: ${a.summary ?? ""}`).join("\n") })
    const note = await noteBlock(q, found.task.noteId)
    if (note.block) blocks.push(note.block)
    return { repo: repoForNote(found.task.noteId, note.title ?? found.task.projectTitle), text: found.task.title, noteTitle: note.title, noteId: found.task.noteId }
  }

  async function gh(args: string[]): Promise<string> {
    const r = await o.gh(args).catch(() => null)
    return r ? (r.stdout || r.stderr).trim() : ""
  }

  async function gather(src: SourceItem): Promise<ResolverContext> {
    const blocks: EvidenceBlock[] = []
    const ctx: ResolverContext = { repo: null, readableDirs: memoryDirs(), blocks, sensitivePaths: [], sensitive: false, rescuedBefore: false }
    const ref = src.ref
    if (ref.source === "task") {
      ctx.repo = (await gatherTask(ref.taskId, blocks)).repo
    } else if (ref.source === "pr") {
      const t = await gatherTask(ref.taskId, blocks)
      const raw = await gh(["pr", "view", ref.prUrl, "--json", PR_JSON])
      let view: PrView = {}
      try { view = JSON.parse(raw) as PrView } catch { blocks.push({ label: "gh pr view (unparsed)", text: raw.slice(0, 4000) }) }
      const paths = (view.files ?? []).map((f) => f.path)
      ctx.sensitivePaths = sensitivePaths(paths)
      ctx.sensitive = isSensitivePr(paths, src.facts.reason ?? "")
      ctx.rescuedBefore = o.store.hadAction(`pr:${src.refId}`, "fix")
      if (raw) blocks.push({ label: "gh pr view --json", text: raw.slice(0, 8000) })
      const checks = await gh(["pr", "checks", ref.prUrl])
      if (checks) blocks.push({ label: "gh pr checks", text: checks.slice(0, 4000) })
      const diff = await gh(["pr", "diff", ref.prUrl])
      if (diff) blocks.push({ label: "gh pr diff", text: diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n…(diff truncated — use gh pr diff for the rest)` : diff })
      ctx.repo = t.repo && (await sh("git", ["-C", t.repo, "remote", "get-url", "origin"], { cwd: t.repo, timeoutMs: 10_000 })).out.toLowerCase().includes(ref.repo.toLowerCase())
        ? t.repo : await localRepoFor(ref.repo, `${t.noteId ?? ""} ${t.noteTitle ?? ""}`, sh)
      ctx.pr = { head: view.headRefName ?? "", base: view.baseRefName ?? "main", number: ref.number, title: view.title ?? src.title, taskText: t.text }
    } else if (ref.source === "proposal") {
      const t = getTask(ref.taskId)
      if (t) {
        blocks.push({ label: "Proposed worker prompt", text: t.prompt }, { label: "Why the brain proposed it", text: t.reasoning ?? "" })
        const others = listProposals().filter((p) => p.taskId !== t.taskId)
        if (others.length) blocks.push({ label: "Other pending proposals", text: others.map((p) => `- [${p.taskId}] ${(p.title || p.prompt).replace(/\s+/g, " ").slice(0, 200)}`).join("\n") })
        const noteId = t.noteId ?? getChannel(t.threadId)?.noteId ?? null
        const note = await noteBlock(q, noteId)
        if (note.block) blocks.push(note.block)
        if (noteId) {
          const rows = await q("SELECT text, dispatch_status, done, updated_at FROM tasks WHERE note_id = ? ORDER BY updated_at DESC LIMIT 25", [noteId]).catch(() => [])
          if (rows.length) blocks.push({ label: "Recent tasks of this project", text: rows.map((r) => `- ${r.done ? "done" : r.dispatch_status ?? "open"} · ${String(r.updated_at ?? "")} · ${String(r.text ?? "").slice(0, 160)}`).join("\n") })
          ctx.repo = repoForNote(noteId, note.title)
        }
        ctx.repo ??= isDir(t.cwd) ? t.cwd : null
      }
    }
    blocks.push(...stateBlock(ctx.repo))
    return ctx
  }

  function channelOf(src: SourceItem): { channel: string; taskId: string | null } {
    const ref = src.ref
    if (ref.source === "task") return { channel: ref.channel ?? GENERAL_CHANNEL, taskId: ref.taskId }
    if (ref.source === "pr") {
      const cached = o.dispatch.cached(ref.taskId)
      return { channel: cached ? o.dispatch.threadIdFor(cached) : GENERAL_CHANNEL, taskId: ref.taskId }
    }
    if (ref.source === "proposal") return { channel: getTask(ref.taskId)?.threadId ?? GENERAL_CHANNEL, taskId: ref.taskId }
    return { channel: BODY_CHANNEL, taskId: null }
  }

  function target(src: SourceItem): [string, string] {
    const ref = src.ref
    if (ref.source === "task" || ref.source === "pr") return ["task", ref.taskId]
    if (ref.source === "proposal") return ["proposal", ref.taskId]
    if (ref.source === "body") return ["body", ref.componentId]
    return ["trip", src.refId]
  }

  return {
    gather,
    analyze: (prompt, ctx, model, timeoutMs) =>
      runReadonlyClaude(prompt, resolverSpec(model, ctx.readableDirs), { timeoutMs, cwd: ctx.repo ?? readonlyCwd() }),
    async investigate(src, model, timeoutMs) {
      if (src.ref.source !== "body") return { ok: false, error: "not a body item" }
      const detail = await buildComponentDetail(tursoQuery, src.ref.componentId).catch(() => null)
      if (!detail) return { ok: false, error: "component record unavailable (Turso)" }
      const paths = knownPaths(detail.component)
      bodyPaths.set(src.ref.componentId, { state: detail.vitals?.state ?? "unknown", cwd: paths.repo ?? paths.cwd, repo: !!paths.repo })
      const out = await runInvestigatorCli(buildBodyResolverPrompt(detail, paths, [src.facts.error ?? ""].filter(Boolean)), { timeoutMs, model })
      return out.ok ? { ok: true, result: out.result } : { ok: false, error: out.error }
    },
    async applyBody(src, result: InvestigationResult) {
      if (src.ref.source !== "body") return null
      const store = investigationStore()
      const p = bodyPaths.get(src.ref.componentId) ?? { state: "unknown", cwd: null, repo: false }
      const host = localBodyHost()
      const t = Date.now()
      const rec = store.insert({ componentId: src.ref.componentId, host, state: p.state, trigger: "resolver", status: "running", runOn: host, attempt: 1, startedAt: t }, t)
      const done = store.update(rec.id, { status: "done", finishedAt: Date.now(), result, error: null })!
      const proposalId = await bodyReportApplier()({
        id: rec.id, componentId: rec.componentId, host, state: p.state, status: "done", attempt: 1, startedAt: t, finishedAt: done.finishedAt ?? Date.now(),
        runOn: host, result, error: null, cwd: p.cwd, repo: p.repo,
      }, done)
      store.update(rec.id, { reported: true, proposalId: proposalId ?? undefined })
      if (proposalId) o.store.markCreated(proposalId, Date.now())
      return proposalId
    },
    execute: (src, action: TriageAction, by) => o.execute(src, { id: "resolver", label: action.kind, action }, null, by),
    async comment(src, body) {
      if (src.ref.source !== "pr") return false
      const r = await o.gh(["pr", "comment", src.ref.prUrl, "--body", body]).catch(() => null)
      return r?.code === 0
    },
    async fix(src, ctx, instructions, model, timeoutMs) {
      if (src.ref.source !== "pr" || !ctx.pr) return { kind: "failed", error: "not a PR" }
      if (!ctx.repo) return { kind: "failed", error: `no local checkout of ${src.ref.repo} on this host` }
      return runPrFix({
        prUrl: src.ref.prUrl, number: ctx.pr.number, title: ctx.pr.title, repo: ctx.repo, head: ctx.pr.head, base: ctx.pr.base,
        instructions, taskText: ctx.pr.taskText, model, timeoutMs,
      }, { sh })
    },
    async unpark(src, reason) {
      if (src.ref.source !== "pr") return
      await o.dispatch.exec(
        "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, 'pr:unpark', 'task', ?, ?, ?)",
        [RESOLVER_SLUG, src.ref.taskId, `${src.ref.repo}#${src.ref.number} handed back by Opus: ${reason}`.slice(0, 200), JSON.stringify({ url: src.ref.prUrl, by: RESOLVER_SLUG, reason })],
      )
    },
    async revise(src, title, prompt, why) {
      if (src.ref.source !== "proposal") return null
      const old = getTask(src.ref.taskId)
      if (!old || old.status !== "proposed") return null
      const res = rejectProposal(old, o.dispatch)
      if (!res.ok) return null
      const next = createProposal(prompt, old.cwd, `Opus rescoped [${old.taskId}]: ${why}`.slice(0, 500), old.threadId, {
        noteId: old.noteId ?? null, agent: old.agent ?? null, title: title || old.title || null,
      })
      o.store.markCreated(next.taskId, Date.now())
      emitTask(next.taskId)
      orchEmit(appendTurn("orchestrator", `🤖 Opus rescoped [${old.taskId}] → proposal [${next.taskId}]: ${title || prompt.slice(0, 120)}`, next.taskId, old.threadId))
      return next.taskId
    },
    async record(src, action, summary, meta) {
      const [kind, id] = target(src)
      await o.dispatch.exec(
        "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
        [RESOLVER_SLUG, action, kind, id, summary.slice(0, 200), JSON.stringify({ source: "companion", ...meta })],
      ).catch((err) => companionLog(`[resolver] activity row failed (${(err as Error)?.message ?? "error"})`))
    },
    turn(src, text) {
      const { channel, taskId } = channelOf(src)
      orchEmit(appendTurn("orchestrator", text, taskId, channel))
    },
    now: Date.now,
    log: companionLog,
  }
}

/** A Body component this host can investigate itself (Mac components stay with the normal card on Zettlab). */
function bodyLocal(src: SourceItem): boolean {
  return routeFor(src.facts.host ?? null, localBodyHost()) === "local"
}

export interface LiveResolver { engine: ResolverEngine; store: ResolverStore }

/** Test / smoke knobs for the live resolver. */
export interface ResolverLiveOpts {
  db?: Database
  config?: () => ResolverConfig
  /** Replace some live seams (a mock model, a fake fix run). */
  overrides?: Partial<WorkSeams>
}

export function createLiveResolver(o: Omit<LiveResolverOpts, "store"> & ResolverLiveOpts & { onChange: (finished: boolean) => void }): LiveResolver {
  const store = createResolverStore(o.db ?? companionDb)
  const work = createResolverWork({ ...liveSeams({ ...o, store }), ...o.overrides })
  const engine = createResolverEngine({
    store, work,
    config: o.config ?? (() => resolverConfig()),
    routable: (src) => routable(src, { createdByResolver: (id) => store.isCreated(id), bodyLocal: () => bodyLocal(src) }),
    refKey: (src) => `${src.source}:${src.refId}`,
    onChange: o.onChange,
    log: companionLog,
  })
  const closed = engine.recover()
  if (closed) companionLog(`[resolver] ${closed} run(s) a restart interrupted fall through to cards`)
  return { engine, store }
}

// ── daily digest ─────────────────────────────────────────────────────────────

export const DIGEST_TICK_MS = 10 * 60_000
export const DIGEST_HOUR = 21

export function startResolverDigest(store: ResolverStore): () => void {
  const hour = Number(process.env.COMPANION_RESOLVER_DIGEST_HOUR ?? DIGEST_HOUR)
  const tick = () => {
    try {
      maybeDigest(store, Date.now(), Number.isFinite(hour) ? hour : DIGEST_HOUR, (text) => orchEmit(appendTurn("orchestrator", text, null, GENERAL_CHANNEL)))
    } catch (err) {
      companionLog(`[resolver] digest failed: ${(err as Error)?.message ?? err}`)
    }
  }
  const t = setInterval(tick, DIGEST_TICK_MS)
  ;(t as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(t)
}
