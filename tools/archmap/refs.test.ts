import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const cli = join(import.meta.dir, "cli.ts")
const run = (...a: string[]) => Bun.spawnSync(["bun", "run", cli, ...a, "--quiet"])

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "archmap-refs-"))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
  return root
}

describe("refs on a host without the sibling", () => {
  test("regenerates from the committed snapshot: same map, same contracts, --check fresh", () => {
    const sibling = repo({
      "architecture.json": JSON.stringify({
        generatedAt: "2026-10-01", repo: "ios", intent: "", refs: [],
        targets: [{ name: "ios", adapter: "swiftui", root: "App", cap: 600, fanIn: {}, modules: [
          { path: "WS.swift", lines: 9, kind: "lib", exports: [], state: [], emits: [], consumes: ["ping"], endpoints: [], apiCalls: ["/api/ping"], imports: [], listeners: [], sheets: 0 },
        ] }],
      }),
    })
    const root = repo({
      "archmap.json": JSON.stringify({ repo: "srv", targets: [{ name: "server", adapter: "bun-server", root: "server" }], refs: [{ name: "ios", repo: sibling }] }),
      "server/ws.ts": `export function hi(ws: { send(s: string): void }) { ws.send(JSON.stringify({ type: "ping" })) }\n`,
    })
    expect(run(root).exitCode).toBe(0)
    const md = readFileSync(join(root, "architecture.md"), "utf-8")
    const json = readFileSync(join(root, "architecture.json"), "utf-8")
    expect(md).toContain("ios:ios/WS.swift")

    rmSync(sibling, { recursive: true })   // e.g. CI or Zettlab: the iOS repo is not checked out
    const r = run(root)
    expect(r.stderr.toString()).not.toContain("refusing")
    expect(r.exitCode).toBe(0)
    expect(readFileSync(join(root, "architecture.md"), "utf-8")).toBe(md)
    expect(readFileSync(join(root, "architecture.json"), "utf-8")).toBe(json)
    expect(run(root, "--check").exitCode).toBe(0)
  })
})
