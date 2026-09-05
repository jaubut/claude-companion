// Mirror Claude Code's interactive dialogs (/model, /mcp, trust, MCP-enable,
// AskUserQuestion when the hook missed it) to the phone.
//
// Detection is textual: the pane region below the last divider that has a
// cursor row ("❯ …") AND a hint footer ("Enter to …", "Esc to cancel", …).
// The idle input prompt also starts with "❯" but its footer is the auto-mode
// line, never key hints, so it doesn't qualify. Two row shapes seen live:
//   ❯ 1. Default (recommended) ✔  Opus 5 …     numbered picker (/model, questions)
//   ❯ birds-n-clubs-store · ✘ failed           plain list (/mcp)
// Continuation lines (indented past the row's text start) fold into the row.

export interface DialogItem {
  index: number          // 0-based position in the list as rendered
  number: number | null  // the "N." prefix when the picker is numbered
  text: string
  cursor: boolean        // the row the ❯ sits on
  selected: boolean      // ✔ mark
}

export interface DialogHint {
  key: string            // what to send: Enter | Escape | Up | Down | Left | Right | Tab | a literal char
  label: string          // what the footer says it does
}

export interface Dialog {
  title: string
  body: string           // lines between the title and the first row
  items: DialogItem[]
  more: string           // "↓ 10 more below" / "… +3 models" when the list is cut
  hints: DialogHint[]
  numbered: boolean
}

const CURSOR_RE = /^\s*(?:❯|›|>)\s+(.*)$/
const HINT_FOOTER_RE = /\b(?:Enter|Esc|Tab|Space)\b[^·\n]*\bto\b|↑\/↓|←\/→|Arrow keys/
const MORE_RE = /^\s*(?:↓\s*\d+\s+more\s+below|…\s*\+\d+\s+\w+|↓ .*more.*)\s*$/
const DIVIDER_RE = /^[\s▔─━═]{8,}$/
const INPUT_PROMPT_RE = /^\s*❯\s*(?:Try\s+".*")?\s*$/

const KEY_NAMES: Record<string, string> = {
  enter: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space",
  "↑": "Up", "↓": "Down", "←": "Left", "→": "Right",
}

// "Enter to set as default · s to use this session only · Esc to cancel"
// → [{Enter, set as default}, {s, use this session only}, {Escape, cancel}]
export function parseHints(line: string): DialogHint[] {
  const out: DialogHint[] = []
  for (const part of line.split(/\s+·\s+/)) {
    const m = part.trim().match(/^(.+?)\s+to\s+(.+)$/)
    if (!m) continue
    const keyText = m[1]!.trim()
    const label = m[2]!.trim()
    // "↑/↓" → two hints; "Tab/Arrow keys" → Tab only; "←/→" → two hints
    const keys = keyText.split("/").map((k) => k.trim()).filter((k) => k && !/arrow keys/i.test(k))
    for (const k of keys) {
      const mapped = KEY_NAMES[k.toLowerCase()] ?? (k.length === 1 ? k : null)
      if (mapped) out.push({ key: mapped, label })
    }
  }
  return out
}

const MARKER_RE = /^(\s*)(❯|›|>|↓|↑)(\s+)/
const TAB_BAR_RE = /Submit\s+→/

interface Classified {
  marker: boolean
  cursor: boolean
  numbered: string | null
  col: number      // column where the row's own text starts (after marker / before "N.")
  text: string     // text without marker
}

function classify(line: string): Classified {
  const m = line.match(MARKER_RE)
  const marker = !!m
  const cursor = marker && /^(?:❯|›|>)$/.test(m![2]!)
  const rest = marker ? line.slice(m![0].length) : line.trimStart()
  const col = marker ? m![0].length : line.length - line.trimStart().length
  const num = rest.match(/^(\d+)\.\s+/)
  return { marker, cursor, numbered: num ? num[1]! : null, col, text: num ? rest.slice(num[0].length) : rest }
}

export function parseDialog(pane: string): Dialog | null {
  const all = pane.replace(/\r/g, "").split("\n")
  let end = all.length
  while (end > 0 && !all[end - 1]!.trim()) end--
  let footerIdx = -1
  for (let i = end - 1; i >= Math.max(0, end - 6); i--) {
    if (HINT_FOOTER_RE.test(all[i]!)) { footerIdx = i; break }
  }
  if (footerIdx < 0) return null
  const hints = parseHints(all[footerIdx]!)
  if (!hints.length) return null

  // Anchor on the cursor row (the idle prompt's "❯" doesn't count), then
  // open the region at the divider above it. Dialogs can contain their own
  // dividers (the question picker does), so the cursor decides, not the
  // nearest divider to the footer.
  let cursorIdx = -1
  for (let i = footerIdx - 1; i >= Math.max(0, footerIdx - 60); i--) {
    const l = all[i]!
    if (CURSOR_RE.test(l) && !INPUT_PROMPT_RE.test(l)) { cursorIdx = i; break }
  }
  if (cursorIdx < 0) return null
  let start = 0
  for (let i = cursorIdx - 1; i >= 0; i--) {
    if (DIVIDER_RE.test(all[i]!)) { start = i + 1; break }
  }
  const textCol = classify(all[cursorIdx]!).col

  const items: DialogItem[] = []
  const pre: string[] = []
  const notes: string[] = []
  let more = ""
  for (const raw of all.slice(start, footerIdx)) {
    const line = raw.replace(/\s+$/, "")
    if (!line.trim() || DIVIDER_RE.test(line) || TAB_BAR_RE.test(line)) continue
    if (MORE_RE.test(line)) { more = line.trim(); continue }
    const c = classify(line)
    const isRow = c.marker || c.numbered !== null || (items.length > 0 && Math.abs(c.col - textCol) <= 1)
    if (isRow) {
      const cleanText = c.text.replace(/\s*✔\s*/g, " ").replace(/\s{2,}/g, " ").trim()
      items.push({
        index: items.length,
        number: c.numbered ? Number(c.numbered) : null,
        text: cleanText,
        cursor: c.cursor,
        selected: /✔/.test(c.text),
      })
    } else if (items.length > 0 && c.col > textCol + 1) {
      const last = items[items.length - 1]!
      last.text = `${last.text} ${line.trim()}`.replace(/\s{2,}/g, " ")
    } else if (items.length > 0) {
      notes.push(line.trim())
    } else {
      pre.push(line.trim())
    }
  }
  if (!items.length) return null
  return {
    title: pre[0] ?? "",
    body: [...pre.slice(1), ...notes].join("\n"),
    items,
    more,
    hints,
    numbered: items.some((it) => it.number !== null),
  }
}

// Stable identity for change detection between polls.
export function dialogSignature(d: Dialog | null): string {
  if (!d) return ""
  return [d.title, d.items.map((i) => `${i.cursor ? ">" : " "}${i.selected ? "*" : " "}${i.text}`).join("|"), d.more].join("\n")
}

// Keys that move the cursor onto row `index`: Up/Down deltas from where the
// cursor sits. Arrows work in every Claude Code list; digits only in the
// question picker (/model ignores them), so arrows are the one path. The
// phone confirms with Enter (or a hint key) separately.
export function pickKeys(dialog: Dialog, index: number): string[] | null {
  if (index < 0 || index >= dialog.items.length) return null
  const from = Math.max(0, dialog.items.findIndex((it) => it.cursor))
  const delta = index - from
  return Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"))
}
