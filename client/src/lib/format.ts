export function hashHue(s: string): number {
  if (!s) return 210
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

export function shortKey(key: string): string {
  if (!key) return "—"
  const colon = key.indexOf(":")
  const value = colon >= 0 ? key.slice(colon + 1) : key
  const last = value.split("/").filter(Boolean).pop() ?? value
  return last.length > 18 ? last.slice(0, 17) + "…" : last
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, "0")}s`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m${rem.toString().padStart(2, "0")}s`
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}t`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}
