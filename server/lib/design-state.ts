import { createHash } from "node:crypto"
import { type FSWatcher, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  CONTROL_CHARS_RE,
  type CliRunner,
  type DesignBrandTokens,
  type FigcraftFileEntry,
  type FigcraftFrameSummary,
  defaultCliRunner,
  discoverFigcraftFiles,
  parseFigcraftInfoOutput,
  parseThemeCssTokens,
  readThemeCssCached,
  resolveAllowedFigcraftPath,
  sanitizeDesignText,
} from "./figcraft"

export { defaultCliRunner, parseFigcraftInfoOutput, parseThemeCssTokens }
export type { CliResult, CliRunner, DesignBrandTokens, FigcraftFileEntry, FigcraftFrameSummary, FigcraftPageSummary } from "./figcraft"

// Design State Engine: tracks active .figcraft design files, frames, TLS brand/theme
// tokens, and picked /prototype directions so Canvas V2 (Mac + iPad) and every agent
// turn (hooks, headless workers, agy) share live design context without manual edge wiring.

export interface DesignStateSnapshot {
  activeFile: string | null
  activeFileName: string | null
  activeFrameId: string | null
  activeFrameName: string | null
  activePageName: string | null
  brand: string
  themeMode: "light" | "dark"
  pickedDirection: string | null
  pickedNodeId: string | null
  pickedAt: number | null
  mcpAttached: boolean
  updatedAt: number
  availableFiles: FigcraftFileEntry[]
  frames: FigcraftFrameSummary[]
  tokens: DesignBrandTokens
}

export interface DesignStatePatch {
  activeFile?: string | null
  activeFrameId?: string | null
  brand?: string
  themeMode?: "light" | "dark"
  pickedDirection?: string | null
  pickedNodeId?: string | null
  pickedAt?: number | null
}

export interface DesignStateDeps {
  home?: string
  stateDir?: string
  roots?: string[]
  themeCssPath?: string
  exportScriptPath?: string
  now?: () => number
  runCli?: CliRunner
  probeMcp?: () => Promise<boolean>
}

interface PersistedDesignSelection {
  activeFile: string | null
  activeFrameId: string | null
  brand: string
  themeMode: "light" | "dark"
  pickedDirection: string | null
  pickedNodeId: string | null
  pickedAt: number | null
  updatedAt: number
}

const SWEEP_MS = 5_000
const WATCH_DEBOUNCE_MS = 300
const INFO_TIMEOUT_MS = 15_000
const EXPORT_TIMEOUT_MS = 25_000
const ALLOWED_SCALES = new Set([0.5, 1, 2])

async function defaultProbeMcp(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:7979/mcp", { method: "GET", signal: AbortSignal.timeout(800) })
    return res.status < 500
  } catch {
    return false
  }
}

export function formatDesignStatePrompt(s: DesignStateSnapshot, maxChars = 420): string {
  const hasMeaningful = Boolean(s.activeFile || s.activeFrameId || s.pickedDirection || s.availableFiles.length > 0)
  if (!hasMeaningful) return ""
  const parts: string[] = ["[Active Design State]"]
  if (s.activeFile) parts.push(`file=${sanitizeDesignText(s.activeFileName || basename(s.activeFile), 60)} (${s.activeFile})`)
  if (s.activeFrameId || s.activeFrameName) {
    const fLabel = s.activeFrameName ? `"${sanitizeDesignText(s.activeFrameName, 60)}"` : "frame"
    parts.push(`frame=${fLabel}${s.activeFrameId ? `#${sanitizeDesignText(s.activeFrameId, 40)}` : ""}`)
  }
  parts.push(`brand=${sanitizeDesignText(s.brand || "tls", 30)} theme=${s.themeMode}`)
  if (s.pickedDirection) parts.push(`picked_direction="${sanitizeDesignText(s.pickedDirection, 80)}"`)
  if (s.tokens.primary) parts.push(`primary=${sanitizeDesignText(s.tokens.primary, 24)}`)
  if (s.mcpAttached) parts.push("figcraft_mcp=:7979")
  const line = parts.join(" ")
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line
}

export function withDesignStatePrompt(prompt: string, s: DesignStateSnapshot, maxChars = 420): string {
  const trimmed = prompt.trim()
  if (!trimmed || trimmed.startsWith("/")) return prompt
  const ctx = formatDesignStatePrompt(s, maxChars)
  return ctx ? `${trimmed}\n\n${ctx}` : prompt
}

export function createDesignStateService(deps: DesignStateDeps = {}) {
  const home = deps.home ?? homedir()
  const stateDir = deps.stateDir ?? join(home, ".claude-companion")
  const stateFile = join(stateDir, "design-state.json")
  const cacheDir = join(stateDir, "figcraft-cache")
  const roots = deps.roots ?? [join(home, "tls-design-system", "design"), join(home, "intent-profiler")]
  const themeCssPath = deps.themeCssPath ?? join(home, "tls-design-system", "web", "src", "theme.css")
  const exportScriptPath = deps.exportScriptPath ?? join(home, "tls-design-system", "scripts", "export-tokens.sh")
  const now = deps.now ?? Date.now
  const runCli = deps.runCli ?? defaultCliRunner
  const probeMcp = deps.probeMcp ?? defaultProbeMcp

  const fileCache = new Map<string, FigcraftFileEntry>()
  const inflightRenders = new Map<string, Promise<{ ok: true; path: string; bytes: Uint8Array } | { ok: false; status: number; error: string }>>()
  const listeners = new Set<(s: DesignStateSnapshot) => void>()
  const watchers: FSWatcher[] = []
  const cssCache = { mtime: -1, text: "" }
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let refreshInFlight: Promise<DesignStateSnapshot> | null = null
  let lastEmittedHash = ""

  let selection: PersistedDesignSelection = loadPersisted()
  let mcpAttached = false

  function loadPersisted(): PersistedDesignSelection {
    const empty: PersistedDesignSelection = {
      activeFile: null, activeFrameId: null, brand: "tls", themeMode: "light",
      pickedDirection: null, pickedNodeId: null, pickedAt: null, updatedAt: 0,
    }
    if (!existsSync(stateFile)) return empty
    let parsed: unknown = null
    try { parsed = JSON.parse(readFileSync(stateFile, "utf8")) as unknown } catch { return empty }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty
    const o = parsed as Partial<PersistedDesignSelection>
    const validFile = typeof o.activeFile === "string" ? resolveAllowedFigcraftPath(o.activeFile, home, roots) : null
    return {
      activeFile: validFile,
      activeFrameId: typeof o.activeFrameId === "string" && o.activeFrameId.trim() ? sanitizeDesignText(o.activeFrameId, 60) : null,
      brand: typeof o.brand === "string" && o.brand.trim() ? sanitizeDesignText(o.brand, 30) : "tls",
      themeMode: o.themeMode === "dark" ? "dark" : "light",
      pickedDirection: typeof o.pickedDirection === "string" && o.pickedDirection.trim() ? sanitizeDesignText(o.pickedDirection, 80) : null,
      pickedNodeId: typeof o.pickedNodeId === "string" && o.pickedNodeId.trim() ? sanitizeDesignText(o.pickedNodeId, 60) : null,
      pickedAt: typeof o.pickedAt === "number" && Number.isFinite(o.pickedAt) ? o.pickedAt : null,
      updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
    }
  }

  function savePersisted(): void {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`
      writeFileSync(tmp, JSON.stringify(selection, null, 2))
      renameSync(tmp, stateFile)
    } catch { /* best-effort persistence */ }
  }

  function buildSnapshot(): DesignStateSnapshot {
    const entries = [...fileCache.entries()].filter(([p]) => existsSync(p)).map(([, e]) => e).sort((a, b) => a.path.localeCompare(b.path))
    const activeEntry = entries.find((e) => e.path === selection.activeFile) ?? entries[0] ?? null
    const effectiveFile = selection.activeFile && existsSync(selection.activeFile) ? selection.activeFile : activeEntry?.path ?? null
    const frames = activeEntry?.frames ?? []
    const activeFrame = frames.find((f) => f.id === selection.activeFrameId) ?? null
    return {
      activeFile: effectiveFile,
      activeFileName: activeEntry?.name ?? (effectiveFile ? basename(effectiveFile) : null),
      activeFrameId: activeFrame?.id ?? selection.activeFrameId,
      activeFrameName: activeFrame?.name ?? null,
      activePageName: activeFrame?.pageName ?? null,
      brand: selection.brand,
      themeMode: selection.themeMode,
      pickedDirection: selection.pickedDirection,
      pickedNodeId: selection.pickedNodeId,
      pickedAt: selection.pickedAt,
      mcpAttached,
      updatedAt: selection.updatedAt,
      availableFiles: entries,
      frames,
      tokens: readThemeCssCached(themeCssPath, selection.themeMode, cssCache),
    }
  }

  function emitIfChanged(force = false): DesignStateSnapshot {
    const snap = buildSnapshot()
    const hash = JSON.stringify({
      activeFile: snap.activeFile, activeFrameId: snap.activeFrameId, brand: snap.brand, themeMode: snap.themeMode,
      pickedDirection: snap.pickedDirection, pickedNodeId: snap.pickedNodeId, mcpAttached: snap.mcpAttached,
      files: snap.availableFiles.map((f) => `${f.path}:${f.mtimeMs}`), tokens: snap.tokens,
    })
    if (force || hash !== lastEmittedHash) {
      lastEmittedHash = hash
      for (const fn of listeners) {
        try { fn(snap) } catch { /* listener error isolated */ }
      }
    }
    return snap
  }

  async function inspectFile(file: string, mtimeMs: number): Promise<void> {
    const cached = fileCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs) return
    const res = await runCli("figcraft-cli", ["info", file, "--json"], { timeoutMs: INFO_TIMEOUT_MS })
    if (!res.ok) {
      if (!cached) fileCache.set(file, { path: file, name: basename(file), mtimeMs, pages: [], frames: [] })
      return
    }
    const parsed = parseFigcraftInfoOutput(res.stdout, file, mtimeMs)
    if (parsed) fileCache.set(file, parsed)
  }

  async function refresh(opts: { probeMcp?: boolean } = {}): Promise<DesignStateSnapshot> {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      try {
        const files = discoverFigcraftFiles(home, roots, selection.activeFile)
        const liveSet = new Set(files.map((f) => f.path))
        for (const k of [...fileCache.keys()]) if (!liveSet.has(k)) fileCache.delete(k)
        for (const f of files) await inspectFile(f.path, f.mtimeMs)
        if (!selection.activeFile && files.length > 0) {
          selection = { ...selection, activeFile: files[0]!.path, updatedAt: selection.updatedAt || now() }
          savePersisted()
        }
        if (opts.probeMcp) mcpAttached = await probeMcp()
        return emitIfChanged()
      } finally {
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  }

  async function update(patch: DesignStatePatch): Promise<DesignStateSnapshot> {
    let nextFile = selection.activeFile
    if (patch.activeFile !== undefined) {
      nextFile = patch.activeFile ? resolveAllowedFigcraftPath(patch.activeFile, home, roots) : null
      if (patch.activeFile && !nextFile) throw new Error("invalid_file")
    }
    const fileChanged = nextFile !== selection.activeFile
    selection = {
      activeFile: nextFile,
      activeFrameId: patch.activeFrameId !== undefined ? (patch.activeFrameId ? sanitizeDesignText(patch.activeFrameId, 60) : null) : fileChanged ? null : selection.activeFrameId,
      brand: patch.brand !== undefined ? sanitizeDesignText(patch.brand, 30) || "tls" : selection.brand,
      themeMode: patch.themeMode === "dark" || patch.themeMode === "light" ? patch.themeMode : selection.themeMode,
      pickedDirection: patch.pickedDirection !== undefined ? (patch.pickedDirection ? sanitizeDesignText(patch.pickedDirection, 80) : null) : selection.pickedDirection,
      pickedNodeId: patch.pickedNodeId !== undefined ? (patch.pickedNodeId ? sanitizeDesignText(patch.pickedNodeId, 60) : null) : selection.pickedNodeId,
      pickedAt: patch.pickedAt !== undefined ? patch.pickedAt : selection.pickedAt,
      updatedAt: now(),
    }
    savePersisted()
    if (selection.activeFile) {
      try { await inspectFile(selection.activeFile, statSync(selection.activeFile).mtimeMs) } catch { /* best effort */ }
    }
    return emitIfChanged(true)
  }

  async function syncCanvasPick(node: { id: string; kind: string; ref: string; data: Record<string, unknown> }): Promise<DesignStateSnapshot> {
    const direction = typeof node.data.direction === "string" && node.data.direction.trim() ? node.data.direction.trim() : node.ref || node.id
    const pickedAt = typeof node.data.pickedAt === "number" ? node.data.pickedAt : now()
    const figFile = typeof node.data.figcraftFile === "string" ? node.data.figcraftFile : undefined
    const frameId = typeof node.data.frameId === "string" ? node.data.frameId : undefined
    return update({ ...(figFile ? { activeFile: figFile } : {}), ...(frameId ? { activeFrameId: frameId } : {}), pickedDirection: direction, pickedNodeId: node.id, pickedAt })
  }

  async function renderPreview(opts: { file?: string; nodeId?: string; scale?: number }): Promise<{ ok: true; path: string; bytes: Uint8Array } | { ok: false; status: number; error: string }> {
    const rawFile = opts.file || selection.activeFile || buildSnapshot().activeFile
    if (!rawFile) return { ok: false, status: 404, error: "no_active_file" }
    const real = resolveAllowedFigcraftPath(rawFile, home, roots)
    if (!real) return { ok: false, status: 400, error: "invalid_file" }
    let mtimeMs = 0
    try { mtimeMs = statSync(real).mtimeMs } catch { return { ok: false, status: 404, error: "file_not_found" } }
    const scale = opts.scale && ALLOWED_SCALES.has(opts.scale) ? opts.scale : 1
    const cleanNode = opts.nodeId?.trim() ?? ""
    if (cleanNode && (cleanNode.startsWith("-") || CONTROL_CHARS_RE.test(cleanNode) || cleanNode.length > 120)) {
      return { ok: false, status: 400, error: "invalid_node" }
    }
    const key = createHash("sha256").update(`${real}:${mtimeMs}:${cleanNode}:${scale}`).digest("hex").slice(0, 32)
    const cachedPath = join(cacheDir, `${key}.png`)
    if (existsSync(cachedPath)) {
      try {
        const bytes = readFileSync(cachedPath)
        if (bytes.length > 0) return { ok: true, path: cachedPath, bytes }
      } catch { /* re-render */ }
    }
    const existing = inflightRenders.get(key)
    if (existing) return existing
    const task = (async () => {
      try {
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
        const tmpOut = join(cacheDir, `${key}.tmp.${process.pid}.${Date.now()}.png`)
        const args = cleanNode
          ? ["export", real, "-o", tmpOut, "--format", "png", "--scale", String(scale), "--node", cleanNode]
          : ["render", real, "-o", tmpOut, "--scale", String(scale)]
        const res = await runCli("figcraft-cli", args, { timeoutMs: EXPORT_TIMEOUT_MS })
        if (!res.ok || !existsSync(tmpOut)) return { ok: false as const, status: 502, error: res.stderr.trim() || "render_failed" }
        renameSync(tmpOut, cachedPath)
        const bytes = readFileSync(cachedPath)
        return bytes.length > 0 ? { ok: true as const, path: cachedPath, bytes } : { ok: false as const, status: 502, error: "empty_render" }
      } catch (err) {
        return { ok: false as const, status: 502, error: err instanceof Error ? err.message : "render_failed" }
      } finally {
        inflightRenders.delete(key)
      }
    })()
    inflightRenders.set(key, task)
    return task
  }

  async function exportTokens(): Promise<{ ok: boolean; status: number; output: string; error?: string; state: DesignStateSnapshot }> {
    const snap = buildSnapshot()
    if (!existsSync(exportScriptPath)) return { ok: false, status: 404, output: "", error: "export_script_not_found", state: snap }
    const args = snap.activeFile ? [exportScriptPath, snap.activeFile] : [exportScriptPath]
    const res = await runCli("bash", args, { cwd: dirname(dirname(exportScriptPath)), timeoutMs: EXPORT_TIMEOUT_MS })
    cssCache.mtime = -1
    const next = emitIfChanged(true)
    return { ok: res.ok, status: res.ok ? 200 : 502, output: `${res.stdout}\n${res.stderr}`.trim().slice(0, 1200), ...(res.ok ? {} : { error: "export_failed" }), state: next }
  }

  function scheduleRefresh(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void refresh() }, WATCH_DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  function start(): void {
    if (sweepTimer) return
    void refresh({ probeMcp: true })
    for (const dir of [...roots, dirname(themeCssPath)]) {
      if (!existsSync(dir)) continue
      try { watchers.push(watch(dir, () => scheduleRefresh())) } catch { /* watch unavailable */ }
    }
    sweepTimer = setInterval(() => { void refresh() }, SWEEP_MS)
    sweepTimer.unref?.()
  }

  function stop(): void {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    for (const w of watchers) { try { w.close() } catch { /* closed */ } }
    watchers.length = 0
  }

  return {
    snapshot: buildSnapshot, refresh, update, syncCanvasPick, renderPreview, exportTokens, start, stop,
    promptContext: (maxChars = 420) => formatDesignStatePrompt(buildSnapshot(), maxChars),
    onChange: (fn: (s: DesignStateSnapshot) => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

export type DesignStateService = ReturnType<typeof createDesignStateService>

let activePromptProvider: (() => string) | null = null

export function registerActiveDesignPromptProvider(fn: (() => string) | null): void {
  activePromptProvider = fn
}

export function withActiveDesignStatePrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed || trimmed.startsWith("/") || !activePromptProvider) return prompt
  try {
    const ctx = activePromptProvider().trim()
    return ctx ? `${trimmed}\n\n${ctx}` : prompt
  } catch {
    return prompt
  }
}
