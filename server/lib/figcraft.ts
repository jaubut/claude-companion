import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"

// FigCraft headless adapter + CSS token extractor: discovers .figcraft files, parses
// `figcraft-cli info --json` metadata, validates file paths inside allowed roots, and
// extracts brand tokens from tls-design-system/web/src/theme.css.

export interface FigcraftFrameSummary {
  id: string
  name: string
  pageId: string
  pageName: string
  width: number
  height: number
  file: string
}

export interface FigcraftPageSummary {
  id: string
  name: string
  frameCount: number
}

export interface FigcraftFileEntry {
  path: string
  name: string
  mtimeMs: number
  pages: FigcraftPageSummary[]
  frames: FigcraftFrameSummary[]
}

export interface DesignBrandTokens {
  primary?: string
  background?: string
  foreground?: string
  radius?: string
  accent?: string
  themeCssPath?: string
}

export interface CliResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export type CliRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
) => Promise<CliResult>

export const FRAME_LIMIT = 250
export const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g

export function sanitizeDesignText(raw: string, maxLen = 120): string {
  return raw.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxLen)
}

export function safeRealpath(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

export function resolveAllowedFigcraftPath(rawPath: string, home: string, roots: string[]): string | null {
  const trimmed = rawPath.trim()
  const expanded = trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : resolve(trimmed)
  if (!expanded.toLowerCase().endsWith(".figcraft")) return null
  const real = safeRealpath(expanded)
  if (!real) return null
  const allowed = [home, ...roots].map(safeRealpath).filter((r): r is string => Boolean(r))
  for (const base of allowed) {
    if (real === base || real.startsWith(base.endsWith("/") ? base : `${base}/`)) return real
  }
  return null
}

export async function defaultCliRunner(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
): Promise<CliResult> {
  return new Promise((resolveDone) => {
    let stdout = "", stderr = "", done = false
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, FIGCRAFT_NO_SYSTEM_FONTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill("SIGKILL") } catch { /* already dead */ }
      resolveDone({ ok: false, code: null, stdout, stderr: stderr || "timeout" })
    }, opts.timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding("utf8").on("data", (d: string) => { if (stdout.length < 2_000_000) stdout += d })
    child.stderr?.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < 200_000) stderr += d })
    child.on("error", (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveDone({ ok: false, code: null, stdout, stderr: err.message })
    })
    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveDone({ ok: code === 0, code, stdout, stderr })
    })
  })
}

export function parseFigcraftInfoOutput(stdout: string, filePath: string, mtimeMs: number): FigcraftFileEntry | null {
  let parsed: unknown = null
  try { parsed = JSON.parse(stdout) as unknown } catch { return null }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as { name?: unknown; pages?: unknown }
  const pages: FigcraftPageSummary[] = []
  const frames: FigcraftFrameSummary[] = []
  if (Array.isArray(obj.pages)) {
    for (const rawPage of obj.pages) {
      if (!rawPage || typeof rawPage !== "object") continue
      const p = rawPage as { id?: unknown; name?: unknown; frames?: unknown }
      const pageId = p.id !== undefined && p.id !== null ? String(p.id) : ""
      const pageName = typeof p.name === "string" && p.name.trim() ? sanitizeDesignText(p.name, 80) : "Page"
      const rawFrames = Array.isArray(p.frames) ? p.frames : []
      pages.push({ id: pageId, name: pageName, frameCount: rawFrames.length })
      for (const rawFrame of rawFrames) {
        if (!rawFrame || typeof rawFrame !== "object") continue
        const f = rawFrame as { id?: unknown; name?: unknown; width?: unknown; height?: unknown }
        if (f.id === undefined || f.id === null || frames.length >= FRAME_LIMIT) continue
        frames.push({
          id: String(f.id),
          name: typeof f.name === "string" && f.name.trim() ? sanitizeDesignText(f.name, 80) : `Frame ${f.id}`,
          pageId,
          pageName,
          width: typeof f.width === "number" && Number.isFinite(f.width) ? f.width : 0,
          height: typeof f.height === "number" && Number.isFinite(f.height) ? f.height : 0,
          file: filePath,
        })
      }
    }
  }
  const fileName = typeof obj.name === "string" && obj.name.trim() ? sanitizeDesignText(obj.name, 80) : basename(filePath)
  return { path: filePath, name: fileName, mtimeMs, pages, frames }
}

function parseCssBlockVars(css: string, selector: ":root" | ".dark"): Map<string, string> {
  const vars = new Map<string, string>()
  const idx = css.indexOf(selector)
  if (idx < 0) return vars
  const start = css.indexOf("{", idx)
  const end = start >= 0 ? css.indexOf("}", start) : -1
  if (start < 0 || end <= start) return vars
  for (const m of css.slice(start + 1, end).matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1]!, m[2]!.trim())
  }
  return vars
}

function resolveCssVar(vars: Map<string, string>, name: string, depth = 0): string | undefined {
  const val = vars.get(name)
  if (!val || depth > 5) return val
  const m = val.match(/^var\((--[a-zA-Z0-9_-]+)\)$/)
  return m ? resolveCssVar(vars, m[1]!, depth + 1) ?? val : val
}

export function parseThemeCssTokens(css: string, themeMode: "light" | "dark", themeCssPath?: string): DesignBrandTokens {
  const merged = parseCssBlockVars(css, ":root")
  if (themeMode === "dark") {
    for (const [k, v] of parseCssBlockVars(css, ".dark")) merged.set(k, v)
  }
  return {
    primary: resolveCssVar(merged, "--primary"),
    background: resolveCssVar(merged, "--background"),
    foreground: resolveCssVar(merged, "--foreground"),
    radius: resolveCssVar(merged, "--radius"),
    accent: resolveCssVar(merged, "--chart-3") ?? resolveCssVar(merged, "--accent"),
    ...(themeCssPath ? { themeCssPath } : {}),
  }
}

export function discoverFigcraftFiles(home: string, roots: string[], activeFile: string | null): Array<{ path: string; mtimeMs: number }> {
  const seen = new Set<string>()
  const found: Array<{ path: string; mtimeMs: number }> = []
  const addFile = (p: string): void => {
    const real = resolveAllowedFigcraftPath(p, home, roots)
    if (!real || seen.has(real)) return
    try {
      const st = statSync(real)
      if (!st.isFile()) return
      seen.add(real)
      found.push({ path: real, mtimeMs: st.mtimeMs })
    } catch { /* skip unreadable */ }
  }
  if (activeFile) addFile(activeFile)
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      for (const name of readdirSync(root)) {
        if (name.toLowerCase().endsWith(".figcraft")) addFile(join(root, name))
      }
    } catch { /* skip unreadable dir */ }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

export function readThemeCssCached(
  themeCssPath: string,
  themeMode: "light" | "dark",
  cache: { mtime: number; text: string },
): DesignBrandTokens {
  if (!existsSync(themeCssPath)) return {}
  try {
    const st = statSync(themeCssPath)
    if (st.mtimeMs !== cache.mtime) {
      cache.text = readFileSync(themeCssPath, "utf8")
      cache.mtime = st.mtimeMs
    }
    return parseThemeCssTokens(cache.text, themeMode, themeCssPath)
  } catch {
    return {}
  }
}
