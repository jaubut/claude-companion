import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDesignStateService,
  defaultCliRunner,
  formatDesignStatePrompt,
  parseFigcraftInfoOutput,
  parseThemeCssTokens,
  withDesignStatePrompt,
} from "./design-state"
import { createDesignStateRoute } from "../routes/design-state"
import { BadJsonBody } from "./json-body"

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test("parseFigcraftInfoOutput parses numeric frame IDs and ignores invalid JSON", () => {
  expect(parseFigcraftInfoOutput("{bad json", "/tmp/a.figcraft", 100)).toBeNull()
  const parsed = parseFigcraftInfoOutput(JSON.stringify({
    name: "Launch Kit\nEvil",
    pages: [{
      id: 2,
      name: "Landing",
      frames: [
        { id: 5, name: "Hero\tDesktop", width: 1440, height: 900 },
        { id: "frame-2", name: "Mobile", width: 390, height: 844 },
      ],
    }],
  }), "/Users/test/launch.figcraft", 1234)
  expect(parsed).toEqual({
    path: "/Users/test/launch.figcraft",
    name: "Launch Kit Evil",
    mtimeMs: 1234,
    pages: [{ id: "2", name: "Landing", frameCount: 2 }],
    frames: [
      { id: "5", name: "Hero Desktop", pageId: "2", pageName: "Landing", width: 1440, height: 900, file: "/Users/test/launch.figcraft" },
      { id: "frame-2", name: "Mobile", pageId: "2", pageName: "Landing", width: 390, height: 844, file: "/Users/test/launch.figcraft" },
    ],
  })
})

test("parseThemeCssTokens resolves light and dark CSS variables", () => {
  const css = `
:root {
  --neutral-0: #ffffff;
  --neutral-200: #e5e5e5;
  --neutral-900: #171717;
  --neutral-950: #0a0a0a;
  --chart-3: #2563eb;
  --radius: 10px;
  --background: var(--neutral-0);
  --primary: var(--neutral-900);
}
.dark {
  --background: var(--neutral-950);
  --primary: var(--neutral-200);
}
`
  expect(parseThemeCssTokens(css, "light", "/x/theme.css")).toEqual({
    primary: "#171717",
    background: "#ffffff",
    foreground: undefined,
    radius: "10px",
    accent: "#2563eb",
    themeCssPath: "/x/theme.css",
  })
  expect(parseThemeCssTokens(css, "dark", "/x/theme.css")).toEqual({
    primary: "#e5e5e5",
    background: "#0a0a0a",
    foreground: undefined,
    radius: "10px",
    accent: "#2563eb",
    themeCssPath: "/x/theme.css",
  })
})

test("designStateService discovers files, persists updates, caches previews, and formats prompts", async () => {
  const home = makeTempDir("cc-ds-home-")
  const stateDir = join(home, ".claude-companion")
  const designDir = join(home, "tls-design-system", "design")
  const cssPath = join(home, "tls-design-system", "web", "src", "theme.css")
  const exportScript = join(home, "tls-design-system", "scripts", "export-tokens.sh")
  mkdirSync(designDir, { recursive: true })
  mkdirSync(join(home, "tls-design-system", "web", "src"), { recursive: true })
  mkdirSync(join(home, "tls-design-system", "scripts"), { recursive: true })
  const figA = join(designDir, "a.figcraft")
  const figB = join(designDir, "b.figcraft")
  writeFileSync(figA, "figcraft-a")
  writeFileSync(figB, "figcraft-b")
  writeFileSync(cssPath, `:root { --primary: #111111; --radius: 8px; }\n.dark { --primary: #fafafa; }\n`)
  writeFileSync(exportScript, "#!/bin/sh\necho exported\n")

  const cliCalls: Array<{ cmd: string; args: string[] }> = []
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const svc = createDesignStateService({
    home,
    stateDir,
    roots: [designDir],
    themeCssPath: cssPath,
    exportScriptPath: exportScript,
    now: () => 5555,
    probeMcp: async () => true,
    runCli: async (cmd, args) => {
      cliCalls.push({ cmd, args })
      if (cmd === "figcraft-cli" && args[0] === "info") {
        const name = args[1]!.endsWith("b.figcraft") ? "Beta Kit" : "Alpha Kit"
        return {
          ok: true,
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ name, pages: [{ id: 1, name: "Home", frames: [{ id: 10, name: "Hero", width: 1280, height: 720 }] }] }),
        }
      }
      if (cmd === "figcraft-cli" && (args[0] === "export" || args[0] === "render")) {
        const outIdx = args.indexOf("-o")
        writeFileSync(args[outIdx + 1]!, fakePng)
        return { ok: true, code: 0, stdout: "", stderr: "" }
      }
      if (cmd === "bash") return { ok: true, code: 0, stdout: "tokens ok", stderr: "" }
      return { ok: false, code: 1, stdout: "", stderr: "unexpected" }
    },
  })

  const events: number[] = []
  const stopListen = svc.onChange(() => events.push(events.length + 1))

  const snap1 = await svc.refresh({ probeMcp: true })
  expect(snap1.activeFile?.endsWith("/a.figcraft")).toBe(true)
  expect(snap1.activeFileName).toBe("Alpha Kit")
  expect(snap1.availableFiles.length).toBe(2)
  expect(snap1.mcpAttached).toBe(true)
  expect(snap1.tokens.primary).toBe("#111111")

  // Rejection of traversal / outside-home paths and non-figcraft extensions
  await expect(svc.update({ activeFile: "/etc/passwd" })).rejects.toThrow("invalid_file")
  await expect(svc.update({ activeFile: join(designDir, "not-fig.txt") })).rejects.toThrow("invalid_file")

  const snap2 = await svc.update({ activeFile: figB, activeFrameId: "10", brand: "client-x", themeMode: "dark" })
  expect(snap2.activeFileName).toBe("Beta Kit")
  expect(snap2.activeFrameName).toBe("Hero")
  expect(snap2.themeMode).toBe("dark")
  expect(snap2.tokens.primary).toBe("#fafafa")

  const snap3 = await svc.syncCanvasPick({ id: "prev-1", kind: "preview", ref: "http://example/dir", data: { direction: "brutalist-editorial", pickedAt: 777 } })
  expect(snap3.pickedDirection).toBe("brutalist-editorial")
  expect(snap3.pickedNodeId).toBe("prev-1")

  const promptLine = formatDesignStatePrompt(snap3)
  expect(promptLine).toContain("[Active Design State]")
  expect(promptLine).toContain("file=Beta Kit")
  expect(promptLine).toContain('frame="Hero"#10')
  expect(promptLine).toContain("brand=client-x theme=dark")
  expect(promptLine).toContain('picked_direction="brutalist-editorial"')
  expect(promptLine).toContain("figcraft_mcp=:7979")

  expect(withDesignStatePrompt("/clear", snap3)).toBe("/clear")
  expect(withDesignStatePrompt("Build hero section", snap3)).toContain("picked_direction=\"brutalist-editorial\"")

  // Preview rendering + cache hit + invalid node guard
  const badNode = await svc.renderPreview({ nodeId: "-malicious" })
  expect(badNode).toEqual({ ok: false, status: 400, error: "invalid_node" })
  const exportCallsBefore = cliCalls.filter((c) => c.args[0] === "export").length
  const r1 = await svc.renderPreview({ nodeId: "10", scale: 2 })
  const r2 = await svc.renderPreview({ nodeId: "10", scale: 2 })
  expect(r1.ok && r2.ok).toBe(true)
  expect(cliCalls.filter((c) => c.args[0] === "export").length).toBe(exportCallsBefore + 1)

  // Updating file mtime invalidates preview cache & info cache
  utimesSync(figB, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  const r3 = await svc.renderPreview({ nodeId: "10", scale: 2 })
  expect(r3.ok).toBe(true)
  expect(cliCalls.filter((c) => c.args[0] === "export").length).toBe(exportCallsBefore + 2)

  // Persisted reload test in new service instance
  const svcReload = createDesignStateService({ home, stateDir, roots: [designDir], themeCssPath: cssPath })
  expect(svcReload.snapshot().pickedDirection).toBe("brutalist-editorial")
  expect(svcReload.snapshot().themeMode).toBe("dark")

  const exp = await svc.exportTokens()
  expect(exp.ok).toBe(true)
  expect(exp.output).toBe("tokens ok")
  expect(events.length).toBeGreaterThanOrEqual(3)
  stopListen()
})

test("design-state routes validate body, serve previews, and pass patches", async () => {
  const state = {
    activeFile: "/tmp/f.figcraft",
    activeFileName: "Kit",
    activeFrameId: "5",
    activeFrameName: "Hero",
    activePageName: "Main",
    brand: "tls",
    themeMode: "light" as const,
    pickedDirection: null,
    pickedNodeId: null,
    pickedAt: null,
    mcpAttached: false,
    updatedAt: 1,
    availableFiles: [],
    frames: [],
    tokens: {},
  }
  const route = createDesignStateRoute({
    getSnapshot: () => state,
    refresh: async () => state,
    update: async (p) => ({ ...state, ...p }),
    renderPreview: async () => ({ ok: true, path: "/x.png", bytes: new Uint8Array([1, 2, 3, 4]) }),
    exportTokens: async () => ({ ok: true, status: 200, output: "done", state }),
  })

  const getRes = await route(new Request("http://localhost/api/canvas/design-state"), new URL("http://localhost/api/canvas/design-state"))
  expect(getRes?.status).toBe(200)

  const badTheme = await route(
    new Request("http://localhost/api/canvas/design-state", { method: "POST", body: JSON.stringify({ themeMode: "sepia" }) }),
    new URL("http://localhost/api/canvas/design-state"),
  )
  expect(badTheme?.status).toBe(400)

  await expect(route(
    new Request("http://localhost/api/canvas/design-state", { method: "POST", body: "null" }),
    new URL("http://localhost/api/canvas/design-state"),
  )).rejects.toThrow(BadJsonBody)

  const okPatch = await route(
    new Request("http://localhost/api/canvas/design-state", { method: "POST", body: JSON.stringify({ themeMode: "dark", brand: "acme" }) }),
    new URL("http://localhost/api/canvas/design-state"),
  )
  expect(okPatch?.status).toBe(200)
  expect(await okPatch?.json()).toMatchObject({ ok: true, state: { themeMode: "dark", brand: "acme" } })

  const pngRes = await route(
    new Request("http://localhost/api/canvas/figcraft/preview?node=5&scale=2"),
    new URL("http://localhost/api/canvas/figcraft/preview?node=5&scale=2"),
  )
  expect(pngRes?.status).toBe(200)
  expect(pngRes?.headers.get("content-type")).toBe("image/png")
})

test("smoke: real figcraft-cli info + export when ~/tls-design-system is present", async () => {
  const sample = join(process.env.HOME || "", "tls-design-system", "design", "launch-ui.figcraft")
  const which = await defaultCliRunner("which", ["figcraft-cli"], { timeoutMs: 2_000 })
  if (!which.ok) return
  const info = await defaultCliRunner("figcraft-cli", ["info", sample, "--json"], { timeoutMs: 10_000 })
  if (!info.ok) return
  const parsed = parseFigcraftInfoOutput(info.stdout, sample, 1)
  expect(parsed).not.toBeNull()
  expect(parsed!.frames.length).toBeGreaterThan(0)
})
