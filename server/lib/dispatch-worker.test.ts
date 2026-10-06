import { test, expect, beforeEach } from "bun:test"
import { envHasDispatchWorker, isDispatchWorkerHook, isDispatchWorkerPid, resetDispatchWorkerCache } from "./dispatch-worker"

beforeEach(resetDispatchWorkerCache)

test("envHasDispatchWorker: exact DISPATCH_WORKER=1 entry only", () => {
  expect(envHasDispatchWorker(["PATH=/bin", "DISPATCH_WORKER=1", "DISPATCH_TASK_ID=abc"])).toBe(true)
  expect(envHasDispatchWorker(["DISPATCH_WORKER=", "DISPATCH_WORKER=0", "MY_DISPATCH_WORKER=1", "X=DISPATCH_WORKER=1", "DISPATCH_TASK_ID=abc"])).toBe(false)
  expect(envHasDispatchWorker([])).toBe(false)
})

test("isDispatchWorkerPid: reads the env once per pid, never caches an unreadable env, ignores junk pids", async () => {
  let calls = 0
  const envOf = async (pid: string) => { calls++; return pid === "7" ? ["DISPATCH_WORKER=1"] : pid === "8" ? ["HOME=/h"] : null }
  expect(await isDispatchWorkerPid("7", envOf)).toBe(true)
  expect(await isDispatchWorkerPid("7", envOf)).toBe(true)
  expect(calls).toBe(1)
  expect(await isDispatchWorkerPid("8", envOf)).toBe(false)
  expect(await isDispatchWorkerPid("9", envOf)).toBe(false)
  expect(await isDispatchWorkerPid("9", envOf)).toBe(false)
  expect(calls).toBe(4) // 9 was unreadable twice: asked again
  expect(await isDispatchWorkerPid("", envOf)).toBe(false)
  expect(await isDispatchWorkerPid("12; rm", envOf)).toBe(false)
  expect(calls).toBe(4)
  // cache expires
  expect(await isDispatchWorkerPid("7", envOf, Date.now() + 10 * 60_000)).toBe(true)
  expect(calls).toBe(5)
})

test("isDispatchWorkerHook: from X-Companion-Pid; a codex hook is never a worker", async () => {
  const envOf = async () => ["DISPATCH_WORKER=1"]
  expect(await isDispatchWorkerHook(new Headers({ "x-companion-pid": "5" }), envOf)).toBe(true)
  expect(await isDispatchWorkerHook(new Headers({ "x-companion-pid": "5", "x-companion-agent": "codex" }), envOf)).toBe(false)
  expect(await isDispatchWorkerHook(new Headers(), envOf)).toBe(false)
})
