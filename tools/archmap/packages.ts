import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ModuleInfo, PackageUse } from "./types"
import { packageOf } from "./adapters/shared"

// External packages per target, pinned against the NEAREST lockfile first:
// search starts at the target root and walks up to the repo root (a client
// with its own bun.lock — dashboard, companion — pins its own react, not the
// server's). Lockfiles further up fill what the nearer ones lack: a dep
// declared in the root package.json and imported only from client/ resolves
// from the root lock. bun.lock is JSONC (trailing commas) and is scanned
// line-wise, never parsed.

// `from` = the target root that found it: a yarn workspace's ranges live in
// the workspace's own package.json, not the lockfile's
export type Lockfile = { kind: "bun" | "npm" | "yarn" | "swiftpm"; path: string; from?: string }

const JS_LOCKS = [["bun", "bun.lock"], ["npm", "package-lock.json"], ["yarn", "yarn.lock"]] as const

// Every lockfile from the target root up to the repo root, nearest first.
// `swift` = the target is a SwiftUI app: only then, and only when no JS lock
// exists, is Package.resolved searched (a bounded walk under the target root,
// then the repo root).
export function findLockfiles(repoRoot: string, targetRoot: string, swift = false): Lockfile[] {
  const top = resolve(repoRoot)
  const from = resolve(targetRoot)
  let dir = from
  const out: Lockfile[] = []
  for (let i = 0; i < 12; i++) {
    for (const [kind, name] of JS_LOCKS) {
      const p = join(dir, name)
      if (existsSync(p)) out.push({ kind, path: p, from })
    }
    if (dir === top || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  if (out.length || !swift) return out
  const resolved = findSwiftResolved(resolve(targetRoot), 0) ?? findSwiftResolved(top, 0)
  return resolved ? [{ kind: "swiftpm", path: resolved }] : []
}

export function findLockfile(repoRoot: string, targetRoot: string, swift = false): Lockfile | null {
  return findLockfiles(repoRoot, targetRoot, swift)[0] ?? null
}

function findSwiftResolved(dir: string, depth: number): string | null {
  if (depth > 4 || !existsSync(dir)) return null
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === ".build") continue
    const p = join(dir, e)
    if (e === "Package.resolved") return p
    let st; try { st = lstatSync(p) } catch { continue }   // dangling symlinks are not lockfiles
    if (st.isDirectory()) { const r = findSwiftResolved(p, depth + 1); if (r) return r }
  }
  return null
}

// `"name": ["name@1.2.3", …]` — the alias before the colon may differ from the
// bracketed name, so the version is whatever follows the LAST "@"; bounded
// groups only (an unbounded `.+` runs into the sha512 or a nested dep).
const BUN_LINE_RE = /^\s*"([^"]+)":\s*\["([^"]+)"/

export function readLockfile(lock: Lockfile): Record<string, string | null> {
  const text = readFileSync(lock.path, "utf-8")
  const out: Record<string, string | null> = {}
  // A 0-byte stub (kept to block npm/pnpm/yarn installs) pins nothing; a
  // truncated JSON lockfile leaves everything unpinned rather than crash the map.
  if (!text.trim()) return out
  if (lock.kind === "yarn") return readYarnLock(text, declaredRanges(dirname(lock.path), lock.from))
  if (lock.kind !== "bun") { try { JSON.parse(text) } catch { return out } }
  if (lock.kind === "bun") {
    let inPackages = false
    for (const l of text.split("\n")) {
      if (/^\s*"packages":\s*\{/.test(l)) { inPackages = true; continue }
      if (!inPackages) continue
      const m = l.match(BUN_LINE_RE)
      if (!m) continue
      const at = m[2]!.lastIndexOf("@")
      const ver = at > 0 ? m[2]!.slice(at + 1) : ""
      out[m[1]!] = /^\d/.test(ver) ? ver : null   // workspace:, link:, file:, git+ → null
    }
    return out
  }
  if (lock.kind === "npm") {
    const j = JSON.parse(text) as { packages?: Record<string, { version?: string }> }
    for (const [k, v] of Object.entries(j.packages ?? {})) {
      const i = k.lastIndexOf("node_modules/")
      if (i < 0) continue
      out[k.slice(i + "node_modules/".length)] = v.version ?? null
    }
    return out
  }
  // SwiftPM: v2 `pins[]` (identity) or v1 `object.pins[]` (package); the
  // identity is the repo name, matched case-insensitively against module names.
  const j = JSON.parse(text) as { pins?: { identity?: string; state?: { version?: string } }[]; object?: { pins?: { package?: string; state?: { version?: string } }[] } }
  for (const p of j.pins ?? j.object?.pins ?? []) {
    const name = ("identity" in p ? p.identity : (p as { package?: string }).package) ?? ""
    if (name) out[name.toLowerCase()] = p.state?.version ?? null
  }
  return out
}

// yarn v1 (`"a@^1", a@^2:` + `  version "1.2.3"`) and berry (`"a@npm:^1":` +
// `  version: 1.2.3`). A name locked at several versions resolves to the entry
// matching the range declared in the nearest package.json (what the app
// imports), else the first entry.
function readYarnLock(text: string, declared: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  let specs: string[] = []
  for (const l of text.split("\n")) {
    if (/^\S.*:\s*$/.test(l) && !l.startsWith("#") && !l.startsWith("__metadata")) {
      specs = l.replace(/:\s*$/, "").split(",").map((x) => x.trim().replace(/^"|"$/g, ""))
      continue
    }
    const m = specs.length ? l.match(/^\s+version:?\s+"?([^"\s]+)"?\s*$/) : null
    if (!m) continue
    // a grouped header can mix names (berry alias `x-cjs@npm:x@^4, x@npm:^4`): resolve each name alone
    const byName = new Map<string, string[]>()
    for (const s of specs) {
      const at = s.indexOf("@", 1)
      const name = at > 0 ? s.slice(0, at) : s
      ;(byName.get(name) ?? byName.set(name, []).get(name)!).push(normRange(at > 0 ? s.slice(at + 1) : ""))
    }
    for (const [name, ranges] of byName) {
      const ver = ranges.some((r) => /^(workspace|link|file|portal|patch):/.test(r)) || !/^\d/.test(m[1]!) ? null : m[1]!
      const want = declared[name] === undefined ? undefined : normRange(declared[name]!)
      if (!(name in out) || (want !== undefined && ranges.includes(want))) out[name] = ver
    }
    specs = []
  }
  return out
}

// lockfile and manifest both may say `npm:^1` (or `npm:x@^1` for an alias)
const normRange = (r: string): string => r.trim().replace(/^npm:/, "")

// Ranges from every package.json between the target root and the lockfile's
// dir; the nearest manifest wins (a workspace's semver@^7 over the root's ^6).
function declaredRanges(lockDir: string, from = lockDir): Record<string, string> {
  let out: Record<string, string> = {}
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    try {
      const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, Record<string, string> | undefined>
      out = { ...j.devDependencies, ...j.optionalDependencies, ...j.dependencies, ...out }
    } catch { /* no manifest at this level */ }
    if (dir === resolve(lockDir) || dirname(dir) === dir) return out
  }
}

// `locks` nearest first (findLockfiles); a single lockfile is accepted too.
export function resolvePackages(modules: ModuleInfo[], locks: Lockfile[] | Lockfile | null): Record<string, PackageUse> {
  const list = !locks ? [] : Array.isArray(locks) ? locks : [locks]
  const pins: Record<string, string | null> = {}
  // only absent keys fall back: a nearer workspace:/link: pin (null) stays null
  for (const lock of list) for (const [k, v] of Object.entries(readLockfile(lock))) if (!(k in pins)) pins[k] = v
  const swift = list[0]?.kind === "swiftpm"
  const acc = new Map<string, Set<string>>()
  for (const m of modules) for (const spec of m.externals ?? []) {
    const pkg = swift ? spec : packageOf(spec)
    ;(acc.get(pkg) ?? acc.set(pkg, new Set()).get(pkg)!).add(m.path)
  }
  const out: Record<string, PackageUse> = {}
  for (const pkg of [...acc.keys()].sort()) {
    const version = swift ? swiftVersion(pkg, pins) : pins[pkg] ?? null
    out[pkg] = { version, modules: [...acc.get(pkg)!].sort() }
  }
  return out
}

function swiftVersion(moduleName: string, pins: Record<string, string | null>): string | null {
  const n = moduleName.toLowerCase()
  const key = Object.keys(pins).find((k) => k === n || k.endsWith(n) || k.replace(/^swift-/, "") === n)
  return key ? pins[key] ?? null : null
}
