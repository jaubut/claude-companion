import { closeSync, fstatSync, openSync, readSync } from "node:fs"

// Byte cursor for the incremental transcript reader (split out of transcript.ts
// to keep it under the module cap). Only appended bytes are parsed on each
// 1.5 s tick, so a screenshot-heavy transcript carrying MBs of base64 isn't
// re-parsed every time. Keyed by the session's state object in a WeakMap so
// forgetStates() drops the cursor for free.
//
// Resets to offset 0 (and clears toolUses) when the path or inode changes,
// the file shrank, or the bytes just before the offset no longer match the
// checkpoint taken at the last read — a same-inode rewrite that ends at or past
// the old offset (truncate + refill between two polls) would otherwise be
// skipped for good (Codex on PR #46). The existing seen-sets keep a reset from
// emitting anything twice.

export type ToolUses = Map<string, { name: string; input: unknown }>

export interface Cursor {
  path: string
  ino: number
  offset: number
  // Up to CHECK_BYTES bytes ending at `offset`, from the last read.
  check: Buffer
  // tool_use id → name/input, kept across reads: a tool_result can land in a
  // later chunk than its tool_use.
  toolUses: ToolUses
}

export const CHECK_BYTES = 256

// An entry with where its line sits in the file, so a payload (a screenshot's
// base64) can be re-read later instead of being held in memory.
export interface Located {
  entry: Record<string, unknown>
  offset: number
  length: number
}

const cursors = new WeakMap<object, Cursor>()

// Complete lines appended since the last read. A trailing line without its
// newline is consumed only if it already parses (the old whole-file reader did
// the same); otherwise it waits for the next tick. null = unreadable file.
export function readAppended(key: object, path: string): { entries: Located[]; cursor: Cursor } | null {
  let fd: number
  try { fd = openSync(path, "r") } catch { return null }
  try {
    const st = fstatSync(fd)
    let c = cursors.get(key)
    if (c && (c.path !== path || c.ino !== st.ino || st.size < c.offset || !checkpointHolds(fd, c))) c = undefined
    if (!c) {
      c = { path, ino: st.ino, offset: 0, check: Buffer.alloc(0), toolUses: new Map() }
      cursors.set(key, c)
    }
    const len = st.size - c.offset
    if (len <= 0) return { entries: [], cursor: c }
    const buf = Buffer.alloc(len)
    const got = readSync(fd, buf, 0, len, c.offset)
    const data = buf.subarray(0, got)
    const nl = data.lastIndexOf(0x0a)
    let used = nl + 1
    const entries = parseLocated(data, 0, used, c.offset)
    if (used < data.length) {
      const tail = parseLocated(data, used, data.length, c.offset)
      if (tail.length) { entries.push(...tail); used = data.length }
    }
    if (used > 0) {
      c.offset += used
      c.check = Buffer.from(data.subarray(Math.max(0, used - CHECK_BYTES), used))
    }
    return { entries, cursor: c }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function checkpointHolds(fd: number, c: Cursor): boolean {
  if (c.check.length === 0) return true
  const buf = Buffer.alloc(c.check.length)
  const got = readSync(fd, buf, 0, buf.length, c.offset - buf.length)
  return got === buf.length && buf.equals(c.check)
}

// Parse the lines in data[start, end); offsets are absolute file positions.
function parseLocated(data: Buffer, start: number, end: number, base: number): Located[] {
  const out: Located[] = []
  let pos = start
  while (pos < end) {
    let nl = data.indexOf(0x0a, pos)
    if (nl === -1 || nl > end) nl = end
    const length = nl - pos
    if (length > 0) {
      const line = data.toString("utf8", pos, nl)
      if (line.trim()) {
        try {
          const entry: unknown = JSON.parse(line)
          if (entry && typeof entry === "object") out.push({ entry: entry as Record<string, unknown>, offset: base + pos, length })
        } catch { /* skip malformed line */ }
      }
    }
    pos = nl + 1
  }
  return out
}

// The base64 of image block `idx` in `entry`: inside the tool_result for
// `toolUseId`, or — toolUseId null — a user-pasted image sitting directly in
// the message content.
export function imageBlockData(entry: Record<string, unknown> | null, toolUseId: string | null, idx: number): string | null {
  let content = (entry?.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return null
  if (toolUseId !== null) {
    const tr = (content as Array<Record<string, unknown>>).find((b) => b?.type === "tool_result" && b.tool_use_id === toolUseId)
    content = tr?.content
    if (!Array.isArray(content)) return null
  }
  const item = (content as Array<Record<string, unknown>>)[idx]
  const source = item?.type === "image" ? (item.source as Record<string, unknown> | undefined) : undefined
  return source?.type === "base64" && typeof source.data === "string" ? source.data : null
}

// Re-read one line by location. null when the file moved on (rotated,
// truncated) or the bytes no longer parse — the caller drops the job.
export function readLineAt(path: string, offset: number, length: number): Record<string, unknown> | null {
  let fd: number
  try { fd = openSync(path, "r") } catch { return null }
  try {
    const buf = Buffer.alloc(length)
    const got = readSync(fd, buf, 0, length, offset)
    if (got !== length) return null
    const entry: unknown = JSON.parse(buf.toString("utf8"))
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
