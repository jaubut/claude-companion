import type { SkillDirectoryEntry, SkillManifest, SkillSelectionResult } from "./skill-types"

const STOPWORDS: ReadonlySet<string> = new Set([
  "about", "above", "after", "again", "against", "all", "also", "always", "among", "another",
  "answer", "answers", "any", "anything", "are", "around", "ask", "asks", "auto", "back", "base",
  "based", "because", "been", "before", "being", "below", "between", "both", "build", "call",
  "calls", "can", "case", "check", "checks", "clean", "code", "come", "comes", "create", "current",
  "data", "default", "does", "done", "down", "each", "edit", "else", "every", "example", "existing",
  "fast", "file", "files", "find", "first", "follow", "fourth", "from", "full", "generate", "give",
  "given", "good", "hand", "have", "having", "hello", "help", "here", "high", "into", "item", "items",
  "just", "keep", "kind", "know", "last", "like", "line", "lines", "list", "live", "load", "local",
  "look", "make", "makes", "manual", "many", "mode", "more", "morning", "most", "much", "must", "name",
  "named", "need", "needs", "never", "next", "none", "note", "notes", "only", "open", "optional",
  "other", "output", "over", "page", "pages", "part", "pass", "path", "paths", "pick", "plan",
  "please", "plus", "project", "projects", "prompt", "question", "questions", "quick", "read", "real",
  "repo", "repos", "report", "request", "result", "results", "return", "returns", "right", "root",
  "rule", "rules", "runs", "running", "same", "save", "scan", "search", "second", "send", "session",
  "sessions", "sets", "should", "show", "shows", "single", "site", "skill", "skills", "small", "some",
  "source", "start", "state", "status", "step", "steps", "still", "stop", "strict", "string",
  "structured", "such", "support", "system", "table", "take", "takes", "target", "task", "tasks",
  "team", "tell", "text", "than", "thank", "thanks", "that", "their", "them", "then", "there", "these",
  "they", "thing", "things", "third", "this", "those", "through", "time", "tool", "tools", "tree",
  "true", "turn", "turns", "type", "types", "under", "until", "update", "updates", "urgent", "used",
  "user", "uses", "using", "valid", "value", "values", "verify", "version", "view", "waiting", "want",
  "wants", "watch", "well", "what", "when", "where", "which", "while", "with", "within", "without",
  "work", "worker", "workers", "workflow", "workflows", "write", "writes", "your",
])

const COMPACT_DESC_MAX = 150

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length > 3 && !STOPWORDS.has(tok))
}

export function compactSkillDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim()
  if (!oneLine) return ""
  const firstSentence = oneLine.split(/(?<=[.!?])\s+(?=(?:Use|Invoke|Triggers?|Don't|Never|Requires)\b)/)[0] ?? oneLine
  return firstSentence.length > COMPACT_DESC_MAX
    ? `${firstSentence.slice(0, COMPACT_DESC_MAX - 1).trimEnd()}…`
    : firstSentence
}

interface IndexedSkill {
  manifest: SkillManifest
  tokens: string[]
  tokenFreq: Map<string, number>
}

/**
 * Two-stage Dynamic Skill Registry (Phase 1):
 * - Stage 1: Deterministic exact-trigger + BM25 lexical scorer selecting at most `MAX_DYNAMIC_SKILLS` (5) skills.
 * - Stage 2: Compact directory of un-injected skills exposed via the `load_skill` meta-tool.
 */
export class DynamicSkillRegistry {
  public static readonly MAX_DYNAMIC_SKILLS = 5

  private readonly skills: Map<string, SkillManifest> = new Map()
  private readonly indexed: Map<string, IndexedSkill> = new Map()
  private readonly docFreq: Map<string, number> = new Map()
  private avgDocLen = 1

  constructor(manifests: SkillManifest[]) {
    const sorted = [...manifests].sort((a, b) => a.id.localeCompare(b.id))
    let totalTokens = 0
    for (const s of sorted) {
      this.skills.set(s.id, s)
      const tokens = tokenizeWords(`${s.id.replace(/[-_]/g, " ")} ${s.name} ${s.description}`)
      const tokenFreq = new Map<string, number>()
      for (const tok of tokens) {
        tokenFreq.set(tok, (tokenFreq.get(tok) ?? 0) + 1)
      }
      for (const uniqueTok of tokenFreq.keys()) {
        this.docFreq.set(uniqueTok, (this.docFreq.get(uniqueTok) ?? 0) + 1)
      }
      totalTokens += tokens.length
      this.indexed.set(s.id, { manifest: s, tokens, tokenFreq })
    }
    this.avgDocLen = sorted.length > 0 ? Math.max(1, totalTokens / sorted.length) : 1
  }

  public getSkill(rawId: string): SkillManifest | undefined {
    const normalized = rawId.trim().replace(/^\/+/, "")
    return this.skills.get(normalized) ?? this.skills.get(normalized.toLowerCase())
  }

  public getAllSkills(): SkillManifest[] {
    return Array.from(this.skills.values())
  }

  public getPinnedCount(): number {
    let n = 0
    for (const s of this.skills.values()) if (s.alwaysInclude) n++
    return n
  }

  /** Total skill tokens if the entire catalogue were statically injected on every turn. */
  public getBaselineTotalTokens(): number {
    let sum = 0
    for (const s of this.skills.values()) sum += s.estimatedTokens
    return sum
  }

  public selectSkillsForTurn(
    currentInput: string,
    historySummary: string[] = [],
  ): SkillSelectionResult {
    const allSkills = Array.from(this.skills.values())
    const pinnedSkills = allSkills.filter((s) => s.alwaysInclude)
    const candidatePool = allSkills.filter((s) => !s.alwaysInclude)

    const queryText = `${currentInput} ${historySummary.slice(-2).join(" ")}`.toLowerCase().trim()
    const queryWords = new Set(tokenizeWords(queryText))
    const corpusSize = Math.max(1, allSkills.length)
    const k1 = 1.2
    const b = 0.75

    const scored = candidatePool.map((skill) => {
      if (!queryText) return { skill, score: 0 }
      let score = 0

      // Explicit slash-command or exact skill-id mention
      const lowerId = skill.id.toLowerCase()
      if (queryText.includes(`/${lowerId}`)) {
        score += 15
      } else if (lowerId.length >= 4 && new RegExp(`(?:^|[^a-z0-9])${lowerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(queryText)) {
        score += 12
      }

      // Stage 1a: Exact trigger phrase matches (+10 per matched trigger)
      for (const trigger of skill.triggers) {
        const lowerTrigger = trigger.trim().toLowerCase()
        if (!lowerTrigger || lowerTrigger === `/${lowerId}`) continue
        if (queryText.includes(lowerTrigger)) {
          score += 10
        }
      }

      // Stage 1b: BM25 / IDF-weighted lexical keyword matching over non-stopword tokens
      const idx = this.indexed.get(skill.id)
      if (idx && queryWords.size > 0) {
        const docLen = Math.max(1, idx.tokens.length)
        for (const qTok of queryWords) {
          const tf = idx.tokenFreq.get(qTok) ?? 0
          if (tf <= 0) continue
          const df = this.docFreq.get(qTok) ?? 1
          const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5))
          const normTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / this.avgDocLen)))
          score += Math.max(0.5, idf * normTf)
        }
      }

      return { skill, score }
    })

    const dynamicSkills = scored
      .filter((item) => item.score >= 1.5)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
      .slice(0, DynamicSkillRegistry.MAX_DYNAMIC_SKILLS)
      .map((item) => item.skill)

    const activeSkills = [...pinnedSkills, ...dynamicSkills]
    const selectedIds = new Set(dynamicSkills.map((s) => s.id))

    const availableDirectory: SkillDirectoryEntry[] = candidatePool
      .filter((s) => !selectedIds.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: compactSkillDescription(s.description),
      }))

    const totalInjectedTokens = activeSkills.reduce((sum, s) => sum + s.estimatedTokens, 0)

    return {
      activeSkills,
      pinnedSkills,
      dynamicSkills,
      availableDirectory,
      totalInjectedTokens,
    }
  }
}
