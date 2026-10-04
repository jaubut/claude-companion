// One-shot Body investigation, outside the server: reads the component from
// Turso, runs the read-only investigator once and prints what it produced.
// No sqlite record, no #Body turn, no proposal, no Turso write, no push.
//   bun scripts/body-investigate.ts <component_id> [--prompt-only] [--model <m>]
import { buildComponentDetail } from "../server/lib/body"
import { buildInvestigationPrompt, investigateModel, investigatorArgs, knownPaths, runInvestigatorCli } from "../server/lib/body-investigator"
import { tursoQuery } from "../server/lib/turso"

const args = process.argv.slice(2)
const id = args.find((a) => !a.startsWith("--"))
const modelIdx = args.indexOf("--model")
const model = modelIdx >= 0 ? args[modelIdx + 1] : investigateModel()
if (!id) {
  console.error("usage: bun scripts/body-investigate.ts <component_id> [--prompt-only] [--model <m>]")
  process.exit(2)
}

const detail = await buildComponentDetail(tursoQuery, id)
if (!detail) {
  console.error(`no such component: ${id}`)
  process.exit(1)
}
const paths = knownPaths(detail.component)
const prompt = buildInvestigationPrompt({ detail, paths })
console.error(`component ${id} · state ${detail.vitals?.state ?? "unknown"} · model ${model}`)
console.error(`paths: ${JSON.stringify(paths)}`)
console.error(`argv: claude ${investigatorArgs("", model ?? "sonnet").slice(1).join(" ").slice(0, 400)}…`)
if (args.includes("--prompt-only")) {
  console.log(prompt)
  process.exit(0)
}
const t0 = Date.now()
const out = await runInvestigatorCli(prompt, { model })
console.error(`finished in ${Math.round((Date.now() - t0) / 1000)} s`)
console.log(JSON.stringify(out.ok ? { ok: true, result: out.result } : out, null, 2))
process.exit(out.ok ? 0 : 1)
