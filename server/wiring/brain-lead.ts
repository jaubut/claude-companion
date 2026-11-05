import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BRAIN_THREAD } from "../lib/brain"
import { envValue } from "../lib/brain-workers"
import { processEnvEntries } from "../lib/discover"
import { realHerdr } from "../lib/herdr"
import { type LeadAction, type LeadEvent, type LeadQueue, type OpenPr, LEAD_REPOS, adopt, applyEvent, emptyQueue, enqueue, leadName, nextAction, spentHeads } from "../lib/lead-loop"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type Session, getSessionByKey, listSessions, recordSession } from "../lib/sessions"
import { spawnInHerdr } from "../lib/spawn-session"
import { type GhFn, realGh } from "../lib/triage-pr"
import type { ExecFn } from "../lib/turso"
import { realAutoCompactDeps } from "./auto-compact"
import { brainLiveness } from "./brain-workers"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// Repo leads (brain-v2 P2, docs/brain-api.md § Repo leads): the queue of each
// repo in a JSON file, one `lead-<repo>` herdr session per repo with work, and
// a level-triggered tick that (re)starts it and wakes it while work is left.
// ponytail: no idle reap yet, a lead stays up until closed; add it to brain-workers when a second repo lights up.

const TICK_MS = 60_000
/** A lead with work and no news this long is woken to poll its PRs. */
const WAKE_MS = 5 * 60_000
const LEADS_DIR = process.env.COMPANION_LEADS_DIR?.trim() || join(homedir(), ".claude-companion", "leads")
const LEAD_BRIEF = join(import.meta.dir, "..", "..", "brain", "LEAD.md")
/** Plan mode is off: nobody answers ExitPlanMode's approval in a lead's pane, and a waiting lead never reads as idle, so it would stall for good. */
export const leadArgs = (name: string): string[] => ["--remote-control", name, "--permission-mode", "auto", "--disallowedTools", "EnterPlanMode", "ExitPlanMode"]
/** claude-config tools/pr-shepherd-park.ts: what the shepherd cannot finish, and its one line for the brain. */
const HANDOFF_ACTION = "pr:handoff"
const BRAIN_EVENT_ACTION = "pr:brain-event"
const ACTIVITY_BATCH = 50

export interface LeadDeps {
  dir: string
  gh: GhFn
  exec: ExecFn
  now(): number
  line(repo: string, text: string): void
  /** One line in the brain thread, by the gates' event path. */
  event(text: string): void
  /** Is the herdr agent up? */
  running(name: string): Promise<boolean>
  spawn(repo: string, name: string): Promise<{ ok: boolean; error?: string }>
  /** Clears the herdr record a dead lead left behind (the spawn answered name_taken). */
  stop(name: string): Promise<void>
  sessions(): Pick<Session, "key" | "taskId" | "sessionId" | "herdrPane" | "pid">[]
  /** The herdr pane of that agent, "" when unknown. */
  agentPane(name: string): Promise<string>
  envOf(pid: string): Promise<string[] | null>
  tag(key: string, name: string): boolean
  idle(key: string): Promise<boolean>
  inject(key: string, text: string): Promise<boolean>
}

export const repoSlug = (repo: string): string | null => Object.hasOwn(LEAD_REPOS, repo) ? LEAD_REPOS[repo]! : null

export function createBrainLead(deps: LeadDeps) {
  const file = (repo: string) => join(deps.dir, `${repo}.json`)
  /** An unreadable queue throws: starting from empty would overwrite it and lose the repo's work. */
  function load(repo: string): LeadQueue {
    if (!existsSync(file(repo))) return emptyQueue()
    try {
      return { ...emptyQueue(), ...JSON.parse(readFileSync(file(repo), "utf8")) as LeadQueue }
    } catch {
      throw new Error("queue_unreadable")
    }
  }
  function save(repo: string, q: LeadQueue): void {
    mkdirSync(dirname(file(repo)), { recursive: true })
    writeFileSync(`${file(repo)}.tmp`, JSON.stringify(q, null, 1))
    renameSync(`${file(repo)}.tmp`, file(repo))
  }

  const starting = new Set<string>()
  async function ensure(repo: string): Promise<{ ok: boolean; name: string; state: string; error?: string }> {
    const name = leadName(repo)
    if (await deps.running(name)) return { ok: true, name, state: "running" }
    if (starting.has(repo)) return { ok: true, name, state: "starting" }
    starting.add(repo)
    try {
      const out = await deps.spawn(repo, name)
      if (out.error?.startsWith("name_taken")) await deps.stop(name)
      return out.ok ? { ok: true, name, state: "started" } : { ok: false, name, state: "down", error: out.error }
    } finally {
      starting.delete(repo)
    }
  }

  /** The repo's open PRs on GitHub: the per-repo limit and `gone` read what is really there. */
  async function openPrs(repo: string): Promise<OpenPr[]> {
    const r = await deps.gh(["pr", "list", "--repo", LEAD_REPOS[repo]!, "--state", "open", "--limit", "100", "--json", "number,headRefName"])
    if (r.code !== 0) throw new Error("gh_failed")
    try {
      return JSON.parse(r.stdout) as OpenPr[]
    } catch {
      throw new Error("gh_failed")
    }
  }

  const next = async (repo: string): Promise<LeadAction> => nextAction(load(repo), await openPrs(repo), deps.now())

  /**
   * This pid is the lead: its own env names the task and the pane herdr holds for that agent.
   * The session registry is not proof, any loopback caller can write to it.
   * ponytail: a same-user process can still forge its env; bind to the pane's foreground group if builders become hostile.
   */
  async function verified(name: string, pid: string): Promise<boolean> {
    const pane = await deps.agentPane(name)
    if (!pane) return false
    const env = await deps.envOf(pid)
    return envValue(env, "COMPANION_TASK_ID") === name && envValue(env, "HERDR_PANE_ID") === pane
  }

  /** The lead's session. Discovery re-registers it with no taskId after a restart; tagging gives back the lead's name. */
  async function leadKey(name: string): Promise<string | null> {
    const hit = deps.sessions().find((s) => s.taskId === name)
    if (hit) return hit.key
    const pane = await deps.agentPane(name)
    const s = pane ? deps.sessions().find((x) => !x.taskId && !!x.sessionId && x.herdrPane === pane) : null
    if (!s || !await verified(name, s.pid)) return null
    return deps.tag(s.key, name) ? s.key : null
  }

  const cursorFile = join(deps.dir, ".activity-cursor")

  async function headOf(repo: string, pr: number): Promise<string> {
    const r = await deps.gh(["pr", "view", String(pr), "--repo", LEAD_REPOS[repo]!, "--json", "headRefName"])
    if (r.code !== 0) throw new Error("gh_failed")
    try {
      return String((JSON.parse(r.stdout) as { headRefName?: unknown }).headRefName ?? "")
    } catch {
      throw new Error("gh_failed")
    }
  }

  /** A `pr:handoff` to the manager lands in its repo's queue. Other handoffs have their own brain line. */
  async function handoff(meta: Record<string, unknown>): Promise<void> {
    const { repo, pr, url, reason, findings } = meta
    if (meta.to !== "manager" || typeof repo !== "string" || !repoSlug(repo) || typeof pr !== "number" || !Number.isInteger(pr)) return
    const why = typeof reason === "string" ? reason : "handed over by the shepherd"
    const list = Array.isArray(findings) ? findings.filter((f): f is string => typeof f === "string") : []
    const head = load(repo).tasks.some((t) => t.pr === pr) ? "" : await headOf(repo, pr)
    const q = load(repo)
    adopt(q, pr, head, `PR #${pr}: ${why}`.slice(0, 120), `Finish or replace PR #${pr}`, `handoff:${String(url)}`, list.length ? list : [why], deps.now())
    save(repo, q)
  }

  /** The shepherd's rows since the cursor. The first read starts at the newest row: history is not replayed. */
  async function readActivity(): Promise<void> {
    const actions = [HANDOFF_ACTION, BRAIN_EVENT_ACTION]
    if (!existsSync(cursorFile)) {
      const { rows } = await deps.exec("SELECT COALESCE(MAX(id), 0) AS n FROM agent_activity WHERE action IN (?, ?)", actions)
      mkdirSync(deps.dir, { recursive: true })
      writeFileSync(cursorFile, String(rows[0]?.n ?? 0))
      return
    }
    let cursor = Number(readFileSync(cursorFile, "utf8")) || 0
    const { rows } = await deps.exec("SELECT id, action, summary, meta FROM agent_activity WHERE action IN (?, ?) AND id > ? ORDER BY id LIMIT ?", [...actions, cursor, ACTIVITY_BATCH])
    try {
      for (const row of rows) {
        if (row.action === BRAIN_EVENT_ACTION) deps.event(redactSecrets(String(row.summary ?? "").split("\n")[0]!))
        else {
          let meta: Record<string, unknown> = {}
          try { meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown> } catch { /* unreadable → ignored */ }
          await handoff(meta)
        }
        cursor = Number(row.id)
      }
    } finally {
      writeFileSync(cursorFile, String(cursor))
    }
  }

  const woken = new Map<string, number>()
  let ticking = false

  return {
    ensure,

    /** The brain hands a repo work: queued, and the lead is up. */
    async send(repo: string, title: string, prompt: string, seed: string): Promise<{ ok: boolean; taskId: string; lead: string; state: string }> {
      const q = load(repo)
      const t = enqueue(q, title, prompt, seed, deps.now())
      save(repo, q)
      const e = await ensure(repo)
      return { ok: e.ok, taskId: t.id, lead: e.name, state: e.state }
    },

    next,
    verified,

    /** bin/pr-close's evidence: unreadable counts as not spent, the gate then refuses. */
    spent(repo: string, pr: number): string[] {
      try {
        return spentHeads(load(repo), pr)
      } catch {
        return []
      }
    },

    event(repo: string, e: LeadEvent): void {
      const q = load(repo)
      const line = applyEvent(q, e, deps.now())
      save(repo, q)
      if (line) deps.line(repo, redactSecrets(line))
    },

    /** Every repo with work gets a live lead; an idle one is woken when there is news. */
    async tick(): Promise<void> {
      // One at a time: a slow tick must not read the same cursor twice.
      if (ticking) return
      ticking = true
      try {
        await this.sweep()
      } finally {
        ticking = false
      }
    },

    async sweep(): Promise<void> {
      await readActivity().catch((err: unknown) => companionLog(`[lead] activity read failed: ${(err as Error)?.message ?? String(err)}`))
      for (const repo of Object.keys(LEAD_REPOS)) {
        try {
          const q = load(repo)
          if (!q.tasks.length) continue
          const e = await ensure(repo)
          if (!e.ok) { companionLog(`[lead] ${repo}: ${e.error ?? "spawn failed"}`); continue }
          const key = await leadKey(e.name)
          const last = woken.get(repo) ?? 0
          if (!key || (q.updatedAt <= last && deps.now() - last < WAKE_MS) || !await deps.idle(key)) continue
          // Only blocked or held work left: nothing to do, so no turn to pay for.
          if ((await next(repo)).kind === "idle") { woken.set(repo, deps.now()); continue }
          if (await deps.inject(key, `Read ${LEAD_BRIEF} if you have not, then STATE.md, then run your loop for ${repo}.`)) woken.set(repo, deps.now())
        } catch (err) {
          companionLog(`[lead] ${repo} tick failed: ${(err as Error)?.message ?? String(err)}`)
        }
      }
    },

    start(): void {
      setInterval(() => void this.tick(), TICK_MS).unref?.()
    },
  }
}

export type BrainLead = ReturnType<typeof createBrainLead>

export const brainLead = createBrainLead({
  dir: LEADS_DIR,
  gh: realGh,
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  now: Date.now,
  line: (repo, text) => orchEmit(appendTurn("orchestrator", `${leadName(repo)}: ${text}`, null, BRAIN_THREAD)),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
  // alive(), not the agent record: herdr can keep the record of a claude that exited.
  running: (name) => brainLiveness.alive(name),
  spawn: (repo, name) => spawnInHerdr(join(homedir(), repo), "claude", { COMPANION_TASK_ID: name }, realHerdr, {
    name, args: leadArgs(name),
  }),
  stop: async (name) => {
    const a = await brainLiveness.agentOf(name)
    if (a.kind !== "present") return
    await realHerdr.call(["agent", "stop", name]).catch(() => undefined)
    if (a.ref.workspaceId) await realHerdr.call(["workspace", "close", a.ref.workspaceId]).catch(() => undefined)
    brainLiveness.forget(name)
  },
  sessions: listSessions,
  agentPane: async (name) => {
    const a = await brainLiveness.agentOf(name)
    return a.kind === "present" ? a.ref.pane : ""
  },
  envOf: (pid) => processEnvEntries(pid),
  tag: (key, name) => { const s = getSessionByKey(key); return !!s && recordSession({ ...s, taskId: name })?.key === key },
  idle: async (key) => await realAutoCompactDeps.agentStatus(key) === "idle",
  inject: async (key, text) => (await realAutoCompactDeps.inject(key, text)).ok,
})
