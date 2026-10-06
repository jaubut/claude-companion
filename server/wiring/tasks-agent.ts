import { companionLog } from "../lib/log"
import { runBrainCall } from "../lib/orchestrator-brain"
import { appendTurn } from "../lib/orchestrator-chat"
import { db } from "../lib/orchestrator-db"
import { createTasksAgent, parseSplit, splitPrompt } from "../lib/tasks-agent"
import { createTasksChat, tasksChatModel } from "../lib/tasks-agent-chat"
import { createCalendarBusy } from "../lib/tasks-agent-load"
import { loadAssignRules } from "../lib/tasks-agent-rules"
import { createTasksAgentStore } from "../lib/tasks-agent-store"
import { tursoExec, tursoQuery, tursoTx } from "../lib/turso"
import { broadcast } from "../state"
import { orchEmit } from "./orchestrator"

// Live Tasks agent (PRJ-CT4M WP5): Turso, companion.db, the read-only Google
// Calendar, Haiku for subtask drafts, Opus for the chat tool.

const SPLIT_MODEL = process.env.COMPANION_TASKS_SPLIT_MODEL || "claude-haiku-4-5"
const calendar = createCalendarBusy({ log: companionLog })

export const tasksAgent = createTasksAgent({
  query: tursoQuery,
  exec: tursoExec,
  tx: tursoTx,
  store: createTasksAgentStore(db),
  busy: (days, tz) => calendar.busy(days, tz),
  splitter: async (task) => parseSplit(await runBrainCall(SPLIT_MODEL, splitPrompt(task))),
  rules: () => loadAssignRules(),
})

export const tasksChat = createTasksChat({
  query: tursoQuery,
  exec: tursoExec,
  tx: tursoTx,
  plan: (prompt) => runBrainCall(tasksChatModel(), prompt),
  emitTurn: (text, channelId) => orchEmit(appendTurn("orchestrator", text, null, channelId)),
  notify: (frame) => {
    if (frame.type === "tasks_changed") tasksAgent.invalidate()
    broadcast(frame)
  },
})
