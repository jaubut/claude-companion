import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BRAIN_THREAD } from "../lib/brain"
import { companionDbPath } from "../lib/db-path"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { type BudgetAlertState, type BudgetResponse, budgetTick, buildBudget } from "../lib/token-budget"
import { tursoQuery } from "../lib/turso"
import { gauge } from "./gauge"
import { orchEmit } from "./orchestrator"

const TICK_MS = 10 * 60_000

export function weeklyBudgetUsd(): number | null {
  const v = Number(process.env.COMPANION_WEEKLY_BUDGET_USD)
  return Number.isFinite(v) && v > 0 ? v : null
}

export const tokenBudget = (): Promise<BudgetResponse> =>
  buildBudget(tursoQuery, { account: () => gauge.snapshot().account, weeklyBudgetUsd: weeklyBudgetUsd() })

const statePath = (): string => join(dirname(companionDbPath()), "token-budget.json")

function readState(): BudgetAlertState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8")) as BudgetAlertState
  } catch {
    return { day: "", week: "", fired: [] }
  }
}

/** Role `worker`: the brain thread shows the line, but only `orchestrator` turns wake the brain. */
export function startTokenBudgetPosts(): void {
  const tick = async (): Promise<void> => {
    try {
      const { posts, state } = budgetTick(await tokenBudget(), readState(), Date.now())
      writeFileSync(statePath(), JSON.stringify(state))
      for (const text of posts) orchEmit(appendTurn("worker", text, null, BRAIN_THREAD))
    } catch (err) {
      companionLog(`[token-budget] tick failed: ${(err as Error)?.message ?? err}`)
    }
  }
  setInterval(() => void tick(), TICK_MS).unref?.()
  void tick()
}
