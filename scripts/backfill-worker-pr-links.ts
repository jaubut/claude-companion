#!/usr/bin/env bun
// One-off: links open bin/worker PRs whose Turso task row has no dispatch_pr_url (the shepherd parks them as origin
// unknown), through the same checks as a live "PR ready" (server/lib/worker-pr-link.ts backfillWorkerPrLinks).
// Dry-run unless --apply. Only tasks whose handoff claim verifies: one dispatched without a claim never links.
//   bun scripts/backfill-worker-pr-links.ts [--apply] [--state <file>]
import { homedir } from "node:os"
import { realGh } from "../server/lib/triage-pr"
import { tursoExec } from "../server/lib/turso"
import { backfillWorkerPrLinks } from "../server/lib/worker-pr-link"
import { workerStateFile } from "../server/lib/worker-supervisor"

const args = process.argv.slice(2)
const at = args.indexOf("--state")
const file = at >= 0 ? args[at + 1]! : workerStateFile(homedir())
const write = args.includes("--apply")
const done = await backfillWorkerPrLinks({ gh: realGh, exec: tursoExec, log: (l) => console.log(l) }, file, { write })
console.log(`${done.length} PR(s) checked${write ? "" : " (dry run; --apply to write)"}`)
