import { agentFromHeaders, hookPassthroughResponse } from "./hook-common"
import { processEnvEntries } from "./discover"
import { isDispatchWorkerHook } from "./dispatch-worker"

// How the marker is read from a hook's agent pid (a seam for tests; production reads the process env).
let envReader: typeof processEnvEntries = processEnvEntries
export function setWorkerEnvReaderForTests(fn: typeof processEnvEntries | null): void {
  envReader = fn ?? processEnvEntries
}

// First stop of every /hooks/* request. `is`: the caller is a worker. `early`: the whole answer, for the
// hooks where a worker has nothing to register, push or ask. PreToolUse is handled by its own route (the
// auto-judge still answers, so the worker stays unblocked), which reads `is`.
export async function workerHookGate(req: Request, url: URL): Promise<{ is: boolean; early: Response | null }> {
  const p = url.pathname
  if (!p.startsWith("/hooks/") || p === "/hooks/dispatch-event" || req.method !== "POST") return { is: false, early: null }
  if (!(await isDispatchWorkerHook(req.headers, envReader))) return { is: false, early: null }
  if (p === "/hooks/post-tool-use" || p === "/hooks/user-prompt-submit" || p === "/hooks/stop") return { is: true, early: Response.json({}) }
  if (p === "/hooks/session-start" || p === "/hooks/session-end") return { is: true, early: Response.json({ ok: true }) }
  // PermissionRequest only fires on a real dialog; with no phone round-trip the dialog stays for the runner's
  // blocked-grace timeout (herdr runner, 600 s) to end the run.
  if (p === "/hooks/permission-request") return { is: true, early: hookPassthroughResponse(agentFromHeaders(req.headers)) }
  return { is: true, early: null }
}
