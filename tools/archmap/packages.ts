import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ModuleInfo, PackageUse } from "./types"
import { packageOf } from "./adapters/shared"

// External packages per target, pinned against the NEAREST lockfile: search
// starts at the target root and walks up to the repo root (a client with its
// own bun.lock — dashboard, companion — pins its own react, not the server's).
// bun.lock is JSONC (trailing commas) and is scanned line-wise, never parsed.

export type Lockfile = { kind: "bun" | "npm" | "swiftpm"; path: string }

// `swift` = the target is a SwiftUI app: only then is Package.resolved searched
// (a bounded walk under the target root, then the repo root).
export function findLockfile(repoRoot: string, targetRoot: string, swift = false): Lockfile | null {
  const top = resolve(repoRoot)
  let dir = resolve(targetRoot)
  for (let i = 0; i < 12; i++) {
    for (const [kind, name] of [["bun", "bun.lock"], ["npm", "package-lock.json"]] as const) {
      const p = join(dir, name)
      if (existsSync(p)) return { kind, path: p }
    }
    if (dir === top || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  if (!swift) return null
  const resolved = findSwiftResolved(resolve(targetRoot), 0) ?? findSwiftResolved(top, 0)
  return resolved ? { kind: "swiftpm", path: resolved } : null
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

export function resolvePackages(modules: ModuleInfo[], lock: Lockfile | null): Record<string, PackageUse> {
  const pins = lock ? readLockfile(lock) : {}
  const swift = lock?.kind === "swiftpm"
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
