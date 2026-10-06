// The final assistant text of the turn that just ended, read from the transcript (Stop hook).

function readAssistantAfterLastUser(transcriptPath: string): string | null {
  // Returns the concatenated text of all assistant entries that appear AFTER
  // the most recent user entry in the transcript. Returns null if the file
  // hasn't been flushed with the current turn's assistant message yet — the
  // caller should retry in that case instead of showing the prior turn.
  try {
    const raw = require("node:fs").readFileSync(transcriptPath, "utf8") as string
    const lines = raw.trim().split("\n")
    let lastUserIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!)
        if (entry.type === "user") { lastUserIdx = i; break }
      } catch { /* skip */ }
    }
    if (lastUserIdx < 0) return null  // no user entry at all → nothing reliable

    const chunks: string[] = []
    for (let i = lastUserIdx + 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]!)
        if (entry.type !== "assistant") continue
        const content = entry.message?.content
        if (!Array.isArray(content)) continue
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") chunks.push(b.text)
        }
      } catch { /* skip */ }
    }
    if (chunks.length === 0) return null  // transcript not flushed yet
    return chunks.join("\n")
  } catch {
    return null
  }
}

export async function extractLastAssistantMessage(transcriptPath: string | undefined): Promise<string> {
  // Stop hook sometimes fires before the harness finishes flushing the final
  // assistant turn to disk. Retry briefly (up to ~1s) before giving up — a
  // stale "last assistant message" would surface the PRIOR turn's text as the
  // reply to the current user prompt, which is the bug we're fixing.
  if (!transcriptPath) return ""
  const attempts = [0, 80, 160, 320, 500]  // ms between retries
  for (const delay of attempts) {
    if (delay) await new Promise(r => setTimeout(r, delay))
    const out = readAssistantAfterLastUser(transcriptPath)
    if (out !== null) return out
  }
  return ""
}
