// Live activity tracker — mirrors Claude Code's "Whisking... 12s (2.1k tokens)" status.
// Broadcasts current activity to phone clients so Jeremie can tell if Claude is
// actually working or wedged.

export interface Activity {
  verb: string
  tool: string
  summary: string
  turnStartedAt: number
  lastBeatAt: number
  tokens: number
}

const VERBS = [
  "Whisking",
  "Cogitating",
  "Ruminating",
  "Noodling",
  "Pondering",
  "Simmering",
  "Percolating",
  "Tinkering",
  "Churning",
  "Marinating",
  "Brewing",
  "Puzzling",
  "Hatching",
  "Plotting",
  "Sleuthing",
] as const

let current: Activity | null = null

export function getActivity(): Activity | null {
  return current
}

export function startTurn(): Activity {
  const now = Date.now()
  current = {
    verb: VERBS[Math.floor(Math.random() * VERBS.length)]!,
    tool: "",
    summary: "",
    turnStartedAt: now,
    lastBeatAt: now,
    tokens: 0,
  }
  return current
}

export function updateTool(tool: string, summary: string): Activity {
  const now = Date.now()
  if (!current) {
    current = {
      verb: VERBS[Math.floor(Math.random() * VERBS.length)]!,
      tool,
      summary,
      turnStartedAt: now,
      lastBeatAt: now,
      tokens: 0,
    }
  } else {
    current.tool = tool
    current.summary = summary
    current.lastBeatAt = now
  }
  return current
}

export function beat(tokens?: number): Activity | null {
  if (!current) return null
  current.lastBeatAt = Date.now()
  if (typeof tokens === "number" && tokens > current.tokens) {
    current.tokens = tokens
  }
  return current
}

export function clearActivity(): void {
  current = null
}

// Read cumulative token usage from a Claude Code transcript JSONL for the
// current turn (everything after the most recent user message).
export async function readTurnTokens(transcriptPath: string): Promise<number> {
  try {
    const text = await Bun.file(transcriptPath).text()
    const lines = text.trim().split("\n")
    let total = 0
    // Walk backwards — stop at the most recent user message so we only count
    // the current turn's usage.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } }
        }
        if (entry.type === "user") break
        const usage = entry.message?.usage
        if (usage) {
          total +=
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
        }
      } catch { /* skip */ }
    }
    return total
  } catch {
    return 0
  }
}
