// Short two-tone notification beep using the Web Audio API.
// No asset files, no network. Has to be primed inside a user gesture on iOS —
// call `unlockAudio()` on the first tap so subsequent beeps work silently.

let ctx: AudioContext | null = null
let unlocked = false

export function unlockAudio(): void {
  if (unlocked) return
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    ctx = new AC()
    // Silent blip to wake iOS up
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
    unlocked = true
  } catch { /* ignore */ }
}

function tone(frequency: number, startOffset: number, duration: number): void {
  if (!ctx) return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = "sine"
  osc.frequency.value = frequency
  const start = ctx.currentTime + startOffset
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(0.25, start + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.02)
}

export function playAlert(pattern: "approval" | "waiting" = "approval"): void {
  if (!ctx || !unlocked) return
  try {
    if (ctx.state === "suspended") void ctx.resume()
    if (pattern === "waiting") {
      tone(660, 0, 0.18)
      tone(880, 0.2, 0.22)
    } else {
      tone(880, 0, 0.15)
      tone(660, 0.17, 0.15)
    }
  } catch { /* ignore */ }
}
