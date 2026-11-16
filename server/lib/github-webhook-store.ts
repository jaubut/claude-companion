import type { Database } from "bun:sqlite"
import type { GithubIssueDispatch } from "./github-webhook"

export interface GithubWebhookJob {
  taskId: string
  req: GithubIssueDispatch
  generation: number
  state: "queued" | "starting" | "dispatched" | "uncertain"
  reason: string
  brainReceipt: boolean
  issueReceipt: boolean
}

interface JobRow { task_id: string; payload: string; generation: number; state: GithubWebhookJob["state"]; reason: string; brain_receipt: number; issue_receipt: number }

/** One durable inbox per receiver. Delivery and issue reservation commit together, before HTTP acknowledgment. */
export function createGithubWebhookStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS github_webhook_deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS github_webhook_jobs (
      task_id TEXT PRIMARY KEY, payload TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT 'accepted',
      brain_receipt INTEGER NOT NULL DEFAULT 0, issue_receipt INTEGER NOT NULL DEFAULT 0
    )`)
  // A corrupt payload reads as no job: drain skips it and the next accepted delivery overwrites it.
  const decode = (r: JobRow): GithubWebhookJob | null => {
    let req: GithubIssueDispatch
    try { req = JSON.parse(r.payload) as GithubIssueDispatch } catch { return null }
    return { taskId: r.task_id, req, generation: r.generation, state: r.state, reason: r.reason, brainReceipt: r.brain_receipt === 1, issueReceipt: r.issue_receipt === 1 }
  }
  const get = (id: string): GithubWebhookJob | null => {
    const row = db.query("SELECT * FROM github_webhook_jobs WHERE task_id = ?").get(id) as JobRow | null
    return row ? decode(row) : null
  }
  return {
    get,
    jobs: (): GithubWebhookJob[] => (db.query("SELECT * FROM github_webhook_jobs ORDER BY rowid").all() as JobRow[]).flatMap((r) => decode(r) ?? []),
    accept: db.transaction((delivery: string, req?: GithubIssueDispatch): "duplicate_delivery" | "already_dispatched" | "queued" | "recorded" => {
      if (db.query("SELECT 1 FROM github_webhook_deliveries WHERE id = ?").get(delivery)) return "duplicate_delivery"
      db.query("INSERT INTO github_webhook_deliveries VALUES (?, ?)").run(delivery, Date.now())
      if (!req) return "recorded"
      const old = get(req.taskId)
      if (old && (!req.forceRedispatch || old.state === "queued" || old.state === "starting" || old.state === "uncertain")) return "already_dispatched"
      db.query("INSERT INTO github_webhook_jobs (task_id, payload) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET " +
        "payload = excluded.payload, generation = generation + 1, state = 'queued', reason = 'redispatch', brain_receipt = 0, issue_receipt = 0")
        .run(req.taskId, JSON.stringify(req))
      return "queued"
    }),
    state(id: string, state: GithubWebhookJob["state"], reason: string): void {
      db.query("UPDATE github_webhook_jobs SET state = ?, reason = ?, brain_receipt = 0, issue_receipt = 0 WHERE task_id = ? AND (state <> ? OR reason <> ?)")
        .run(state, reason, id, state, reason)
    },
    brainReceipt(id: string): void { db.query("UPDATE github_webhook_jobs SET brain_receipt = 1 WHERE task_id = ?").run(id) },
    issueReceipt(id: string): void { db.query("UPDATE github_webhook_jobs SET issue_receipt = 1 WHERE task_id = ?").run(id) },
  }
}

export type GithubWebhookStore = ReturnType<typeof createGithubWebhookStore>
