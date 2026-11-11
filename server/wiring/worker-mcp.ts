import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { realSh } from "../lib/live-repo"
import { ensureFolderTrusted } from "../lib/spawn-session"
import { createWorkerMcpHandler } from "../lib/worker-mcp"
import { createWorkerSupervisor } from "../lib/worker-supervisor"
import { HOST_INFO } from "../state"
import { builderJobs } from "./builder-jobs"

// Live Inverted MCP worker supervisor & handler wired to Companion's BuilderJobStore.
export const workerSupervisor = createWorkerSupervisor({
  host: HOST_INFO.name,
  home: homedir(),
  now: Date.now,
  uuid: randomUUID,
  sh: realSh,
  trust: (dir) => ensureFolderTrusted(dir),
  reportJob: (r) => builderJobs.report(r),
})

export const workerMcp = createWorkerMcpHandler({
  supervisor: workerSupervisor,
  localHost: HOST_INFO.name,
})
