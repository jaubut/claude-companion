import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type SkillCategory, type SkillManifest, estimateTokens, isSkillCategory } from "./skill-types"

const SKILL_ID_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function flatText(v: unknown): string {
  return String(v ?? "").split(/\s+/).filter(Boolean).join(" ")
}

export function parseSkillFrontmatter(rawText: string): { meta: Record<string, unknown>; body: string } {
  const normalized = normalizeLf(rawText)
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(normalized)
  if (!m) return { meta: {}, body: normalized }
  const yamlBlock = m[1] ?? ""
  const body = m[2] ?? ""
  try {
    const parsed = Bun.YAML.parse(yamlBlock) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { meta: parsed as Record<string, unknown>, body }
    }
  } catch {
    /* Fallback to conservative key:value line extraction when frontmatter contains unquoted colons */
  }
  const meta: Record<string, unknown> = {}
  for (const key of ["name", "description", "when_to_use", "category", "alwaysInclude", "disable-model-invocation"]) {
    const lineMatch = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(yamlBlock)
    if (lineMatch?.[1]) {
      meta[key] = lineMatch[1].trim().replace(/^["']|["']$/g, "")
    }
  }
  return { meta, body }
}

export function extractSkillTriggers(id: string, description: string, explicitTriggers?: unknown): string[] {
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const t = raw.trim()
    if (t.length >= 2 && t.length <= 80) seen.add(t)
  }

  add(`/${id}`)
  if (id.includes("-") && id.length >= 6) {
    add(id.replace(/-/g, " "))
  }

  if (Array.isArray(explicitTriggers)) {
    for (const item of explicitTriggers) {
      if (typeof item === "string") add(item)
    }
  }

  for (const match of description.matchAll(/["\u201c]([^"\u201d]{3,60})["\u201d]/g)) {
    if (match[1]) add(match[1])
  }

  return [...seen]
}

export function inferSkillCategory(id: string, description: string, rawCategory?: unknown): SkillCategory {
  if (isSkillCategory(rawCategory)) return rawCategory
  const hay = `${id} ${description}`.toLowerCase()
  if (/\b(git|commit|branch|rebase|merge|pr-flow|pull request|worktree)\b/.test(hay)) return "git"
  if (/\b(sql|turso|libsql|postgres|database|migration|schema|sqlite|convex)\b/.test(hay)) return "db"
  if (/\b(deploy|railway|vercel|cloudflare|tailscale|systemd|zettlab|canary|monitor|triage|cron|ops|security|cso|vault)\b/.test(hay)) return "ops"
  if (/\b(architect|architecture|spec|design-system|roadmap|plan|diagram|graphify)\b/.test(hay)) return "architecture"
  if (/\b(code|build|typescript|react|astro|nuxt|swift|swiftui|ios|test|qa|review|refactor|frontend|ui|component)\b/.test(hay)) return "code"
  return "general"
}

export interface LoadSkillsOptions {
  pinnedIds?: ReadonlySet<string>
  includeCommandsDir?: boolean
}

export function defaultSkillsDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const explicit = env.COMPANION_SKILLS_DIR?.trim()
  if (explicit) return explicit
  const claudeSkills = join(home, ".claude", "skills")
  if (existsSync(claudeSkills)) return claudeSkills
  const workspaceConfigSkills = join(home, "jaubut", "claude-config", "skills")
  if (existsSync(workspaceConfigSkills)) return workspaceConfigSkills
  return claudeSkills
}

function buildManifestFromFile(
  id: string,
  filePath: string,
  pinnedIds: ReadonlySet<string>,
): SkillManifest | null {
  if (!SKILL_ID_SAFE_RE.test(id)) return null
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
  } catch {
    return null
  }
  const normalized = normalizeLf(raw).trim()
  if (!normalized) return null

  const { meta, body } = parseSkillFrontmatter(normalized)
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : id
  let description = flatText(meta.description)
  if (meta.when_to_use) description = `${description} ${flatText(meta.when_to_use)}`.trim()
  if (!description) description = flatText(body).slice(0, 240) || name

  const alwaysInclude = pinnedIds.has(id) || meta.alwaysInclude === true || String(meta.alwaysInclude) === "true"
  const manualOnly = meta["disable-model-invocation"] === true || String(meta["disable-model-invocation"]) === "true"
  const triggers = extractSkillTriggers(id, description, meta.triggers)
  const category = inferSkillCategory(id, description, meta.category)

  return {
    id,
    name,
    description,
    triggers,
    category,
    alwaysInclude,
    estimatedTokens: estimateTokens(normalized),
    content: normalized,
    ...(manualOnly ? { manualOnly: true } : {}),
  }
}

/**
 * Deterministically load `SkillManifest[]` from a skills directory (`<skillsDir>/<id>/SKILL.md`)
 * and optional sibling `commands/*.md`, sorted lexicographically by `id`.
 */
export function loadSkillManifests(skillsDir = defaultSkillsDir(), opts: LoadSkillsOptions = {}): SkillManifest[] {
  if (!existsSync(skillsDir)) return []
  const pinnedIds = opts.pinnedIds ?? new Set<string>()
  const byId = new Map<string, SkillManifest>()

  let entries: string[] = []
  try {
    entries = readdirSync(skillsDir).sort()
  } catch {
    return []
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry.startsWith("_") || entry === "synced" || entry === "INDEX.md") continue
    const dirPath = join(skillsDir, entry)
    let isDir = false
    try {
      isDir = statSync(dirPath).isDirectory()
    } catch {
      try {
        if (lstatSync(dirPath).isSymbolicLink()) continue
      } catch { /* ignore unreadable entry */ }
      continue
    }
    if (!isDir) continue

    const skillFile = join(dirPath, "SKILL.md")
    if (!existsSync(skillFile)) continue
    const manifest = buildManifestFromFile(entry, skillFile, pinnedIds)
    if (manifest) byId.set(manifest.id, manifest)
  }

  if (opts.includeCommandsDir !== false) {
    const commandsDir = join(dirname(skillsDir), "commands")
    if (existsSync(commandsDir)) {
      let cmdFiles: string[] = []
      try {
        cmdFiles = readdirSync(commandsDir).sort()
      } catch {
        cmdFiles = []
      }
      for (const file of cmdFiles) {
        if (!file.endsWith(".md")) continue
        const id = file.slice(0, -3)
        if (byId.has(id)) continue
        const manifest = buildManifestFromFile(id, join(commandsDir, file), pinnedIds)
        if (manifest) byId.set(manifest.id, manifest)
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
