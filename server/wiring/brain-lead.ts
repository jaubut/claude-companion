import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BRAIN_THREAD } from "../lib/brain"
import { realHerdr } from "../lib/herdr"
import { type LeadAction, type LeadEvent, type LeadQueue, LEAD_REPOS, applyEvent, emptyQueue, enqueue, leadName, nextAction } from "../lib/lead-loop"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { type Session, listSessions } from "../lib/sessions"
import { spawnInHerdr } from "../lib/spawn-session"
import { type GhFn, realGh } from "../lib/triage-pr"
import { realAutoCompactDeps } from "./auto-compact"
import { brainLiveness } from "./brain-workers"
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

export interface LeadDeps {
  dir: string
  gh: GhFn
  now(): number
  line(repo: string, text: string): void
  /** Is the herdr agent up? */
  running(name: string): Promise<boolean>
  spawn(repo: string, name: string): Promise<{ ok: boolean; error?: string }>
  sessions(): Pick<Session, "key" | "taskId">[]
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
      return out.ok ? { ok: true, name, state: "started" } : { ok: false, name, state: "down", error: out.error }
    } finally {
      starting.delete(repo)
    }
  }

  /** Open dispatch/* PRs on GitHub: the per-repo limit counts what is really open. */
  async function openPrs(repo: string): Promise<number> {
    const r = await deps.gh(["pr", "list", "--repo", LEAD_REPOS[repo]!, "--state", "open", "--limit", "100", "--json", "headRefName"])
    if (r.code !== 0) throw new Error("gh_failed")
    try {
      return (JSON.parse(r.stdout) as Array<{ headRefName?: string }>).filter((p) => p.headRefName?.startsWith("dispatch/")).length
    } catch {
      throw new Error("gh_failed")
    }
  }

  const woken = new Map<string, number>()

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

    async next(repo: string): Promise<LeadAction> {
      return nextAction(load(repo), await openPrs(repo), deps.now())
    },

    event(repo: string, e: LeadEvent): void {
      const q = load(repo)
      const line = applyEvent(q, e, deps.now())
      save(repo, q)
      if (line) deps.line(repo, line)
    },

    /** Every repo with work gets a live lead; an idle one is woken when there is news. */
    async tick(): Promise<void> {
      for (const repo of Object.keys(LEAD_REPOS)) {
        try {
          const q = load(repo)
          if (!q.tasks.length) continue
          const e = await ensure(repo)
          if (!e.ok) { companionLog(`[lead] ${repo}: ${e.error ?? "spawn failed"}`); continue }
          const key = deps.sessions().find((s) => s.taskId === e.name)?.key
          const last = woken.get(repo) ?? 0
          if (!key || (q.updatedAt <= last && deps.now() - last < WAKE_MS) || !await deps.idle(key)) continue
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
  now: Date.now,
  line: (repo, text) => orchEmit(appendTurn("orchestrator", `${leadName(repo)}: ${text}`, null, BRAIN_THREAD)),
  running: async (name) => (await brainLiveness.agentOf(name)).kind !== "absent",
  spawn: (repo, name) => spawnInHerdr(join(homedir(), repo), "claude", { COMPANION_TASK_ID: name }, realHerdr, {
    name, args: ["--remote-control", name, "--permission-mode", "auto"],
  }),
  sessions: listSessions,
  idle: async (key) => await realAutoCompactDeps.agentStatus(key) === "idle",
  inject: async (key, text) => (await realAutoCompactDeps.inject(key, text)).ok,
})
