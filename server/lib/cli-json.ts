// Parse the `claude -p --output-format json` wrapper and return its `.result`.
//
// Don't key on field order: the CLI used to print `{"type":"result",…}` but
// 2.1.28x starts with `{"duration_api_ms":…}`, which silently broke a parser that
// searched for the literal `{"type"`. The CLI may also print warning lines before
// the JSON. So: try the whole output, then each line from the last, then each
// `{` from the last, and take the first object that carries a string `result`.

type Wrapper = { result?: unknown }

function resultOf(text: string): string | null {
  try {
    const w = JSON.parse(text) as Wrapper
    return w && typeof w === "object" && typeof w.result === "string" ? w.result : null
  } catch {
    return null
  }
}

/** The wrapper's `.result` string, or null when no wrapper with a string result is found. */
export function parseCliResult(out: string): string | null {
  const trimmed = out.trim()
  if (!trimmed) return null
  const whole = resultOf(trimmed)
  if (whole !== null) return whole
  const lines = trimmed.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith("{")) continue
    const r = resultOf(line)
    if (r !== null) return r
  }
  // Pretty-printed or prefixed on the same line: try every `{` from the last.
  for (let i = trimmed.lastIndexOf("{"); i >= 0; i = i > 0 ? trimmed.lastIndexOf("{", i - 1) : -1) {
    const r = resultOf(trimmed.slice(i))
    if (r !== null) return r
  }
  return null
}
