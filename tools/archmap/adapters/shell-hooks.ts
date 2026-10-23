import { join } from "node:path"
import { existsSync } from "node:fs"
import { emptyModule, uniq, type HookContract, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot } from "./shared"
import { globToRegex, SHELL_GLOB } from "../lint"

// Shell hook scripts (Claude Code / Codex hooks that curl a local server).
// Per script: the `/hooks/<name>` endpoints it calls (as apiCalls, so the
// endpoint index joins them to the server handler) and the `-H "X-…:"` headers
// it sends. Headers become `hook header` contracts whose consumers are the
// modules under `readers` roots that quote the header name in code
// (`headers.get("x-companion-task-id")`, any casing; comments don't count).

const HEADER_RE = /-H\s+["']?(X-[A-Za-z0-9-]+)\s*:/g
// `"$URL/hooks/stop"`, `$URL/hooks/$ENDPOINT`, `http://h:1/hooks/${NAME}` → `/hooks/:p`.
// Needs a URL base (`$VAR`/`${VAR}`/`scheme://host`) right before `/hooks/` and no
// file extension or deeper path after it, so `~/.claude/hooks/x.py` and
// `$HOME/hooks/_lib.sh` are paths, not calls.
const HOOK_CALL_RE = /(?:\$\{?\w+\}?|https?:\/\/[^/\s"']+)\/hooks\/(\$\{\w+\}|\$\w+|[A-Za-z0-9_-]+)(?![\w./-])/g

export function shellFiles(root: string, glob: string = SHELL_GLOB, ignore: string[] = []): string[] {
  const re = globToRegex(glob)
  return walk(root, [".sh"], ignore).filter((f) => re.test(rel(root, f)))
}

function code(lines: string[], comment: RegExp): string[] {
  return lines.filter((l) => !comment.test(l))
}

export function scanShellHooks(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const modules: ModuleInfo[] = []
  const senders = new Map<string, string[]>()   // header → scripts sending it
  for (const file of shellFiles(root, cfg.glob, cfg.ignore)) {
    const { lines } = read(file)
    const m = emptyModule(rel(root, file), lines.length, "lib")
    const body = code(lines, /^\s*#/).join("\n")
    m.apiCalls = uniq([...body.matchAll(HOOK_CALL_RE)].map((x) => `/hooks/${x[1]!.startsWith("$") ? ":p" : x[1]}`))
    if (m.apiCalls.length) m.kind = "hook"
    for (const h of uniq([...body.matchAll(HEADER_RE)].map((x) => x[1]!))) (senders.get(h) ?? senders.set(h, []).get(h)!).push(m.path)
    modules.push(m)
  }
  const contracts: HookContract[] = [...senders.keys()].sort().map((h) => ({
    kind: "hook header", name: h, producers: senders.get(h)!, consumers: headerReaders(repoRoot, cfg.readers ?? [], h),
  }))
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn: {}, contracts }
}

// Modules (repo-relative "<readerRoot>/<path>") that quote the header name in a
// non-comment line.
export function headerReaders(repoRoot: string, readerRoots: string[], header: string): string[] {
  const re = new RegExp(`["'\`]${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "i")
  const out: string[] = []
  for (const r of readerRoots) {
    const dir = resolveRoot(repoRoot, r)
    if (!existsSync(dir)) continue
    for (const f of walk(dir, [".ts", ".tsx", ".js", ".mjs"]).filter((f) => !isTest(f) && !f.endsWith(".d.ts"))) {
      if (code(read(f).lines, /^\s*(?:\/\/|\/\*|\*)/).some((l) => re.test(l))) out.push(join(r, rel(dir, f)))
    }
  }
  return out
}
