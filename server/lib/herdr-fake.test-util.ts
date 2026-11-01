import type { Herdr } from "./herdr"

// A fake herdr: records every argv, answers from `reply` (throw to fail).
export function fakeHerdr(opts: {
  gate?: string | null
  taken?: string[]
  reply?: (args: string[]) => Record<string, unknown>
} = {}) {
  const calls: string[][] = []
  const h: Herdr = {
    async gate() { return opts.gate ?? null },
    async read() { return "pane text" },
    async call(args) {
      calls.push(args)
      if (args[0] === "agent" && args[1] === "get" && !(opts.taken ?? []).includes(args[2]!)) {
        throw Object.assign(new Error("agent_not_found"), { code: "agent_not_found" })
      }
      if (opts.reply) return opts.reply(args)
      if (args[0] === "workspace" && args[1] === "create") {
        return { workspace: { workspace_id: "w7" }, root_pane: { pane_id: "w7:p1" } }
      }
      return {}
    },
  }
  return { h, calls, verbs: () => calls.map((a) => a.slice(0, 2).join(" ")) }
}

