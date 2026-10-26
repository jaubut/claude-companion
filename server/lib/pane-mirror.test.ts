import { test, expect } from "bun:test"
import {
  FrameCoalescer, MAX_MIRROR_VIEWERS, MIRROR_ECHO_MS, MIRROR_ENDED, MIRROR_GONE_AFTER, PaneMirror, frameSize, mirrorInput, paneMirrorUpgrade,
  repaintFrame, screenRows, type Clock, type MirrorSource, type MirrorUpgradeDeps,
} from "./pane-mirror"
import { recordPeer } from "./vault-guard"

// A clock the test advances by hand.
function fakeClock() {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let next = 1
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = next++; timers.push({ at: t + ms, fn, id }); return id },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1) },
  }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  const advance = async (ms: number) => {
    const end = t + ms
    await flush()
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (!due || due.at > end) break
      timers.shift()
      t = due.at
      due.fn()
      await flush()
    }
    t = end
  }
  return { clock, advance, pending: () => timers.length }
}

// ── coalescing ──

test("coalescer: first frame goes out at once, a burst inside the window sends only its last screen", async () => {
  const { clock, advance } = fakeClock()
  const out: string[] = []
  const c = new FrameCoalescer(33, (f) => out.push(f), clock)
  c.offer("a")
  expect(out).toEqual(["a"])
  await advance(5); c.offer("b")
  await advance(5); c.offer("c")
  await advance(5); c.offer("d")
  expect(out).toEqual(["a"])
  await advance(18)
  expect(out).toEqual(["a", "d"])
})

test("coalescer: an unchanged screen is never resent, and a burst that returns to the sent screen sends nothing", async () => {
  const { clock, advance } = fakeClock()
  const out: string[] = []
  const c = new FrameCoalescer(33, (f) => out.push(f), clock)
  c.offer("a"); c.offer("a")
  await advance(100); c.offer("a")
  expect(out).toEqual(["a"])
  await advance(100); c.offer("b"); await advance(1); c.offer("c"); await advance(1); c.offer("b")
  await advance(1); c.offer("b") // inside b's window: b already sent → pending c then back to b
  await advance(50)
  expect(out).toEqual(["a", "b"])
})

test("coalescer: stop drops a pending frame", async () => {
  const { clock, advance } = fakeClock()
  const out: string[] = []
  const c = new FrameCoalescer(33, (f) => out.push(f), clock)
  c.offer("a"); c.offer("b"); c.stop()
  await advance(100)
  expect(out).toEqual(["a"])
})

// ── frames ──

test("rows: herdr's CRLF rows, the trailing newline is not a row", () => {
  expect(screenRows("a\r\nb\r\n")).toEqual(["a", "b"])
  expect(screenRows("\r\nx\r\n")).toEqual(["", "x"])
  expect(screenRows("")).toEqual([""])
})

test("size: rows from the frame, cols = layout width but never narrower than the widest row (ANSI not counted)", () => {
  const ansi = "\x1b[1mhello\x1b[0m\r\n\x1b[38;2;1;2;3m❯ /\x1b[0m\r\n"
  expect(frameSize(ansi, 153)).toEqual({ cols: 153, rows: 2 })
  expect(frameSize(ansi, null)).toEqual({ cols: 5, rows: 2 })
  expect(frameSize(ansi, 3)).toEqual({ cols: 5, rows: 2 })
})

test("repaint: cursor hidden, each row addressed and cleared BEFORE it is drawn, SGR reset after", () => {
  expect(repaintFrame("ab\r\n\x1b[31mc\r\n")).toBe("\x1b[?25l\x1b[1;1H\x1b[2Kab\x1b[0m\x1b[2;1H\x1b[2K\x1b[31mc\x1b[0m")
})

// ── input ──

test("input: phone bytes go through as text verbatim (Esc, arrows, Ctrl-C, '/', Enter, UTF-8)", () => {
  const b = (s: string) => new TextEncoder().encode(s)
  for (const s of ["\x1b", "\x1b[B", "\x1b[A", "\x03", "/", "\r", "é✓", "\x1b[Z"]) expect(mirrorInput(b(s))).toBe(s)
})

test("input: text frames (control/resize), empty and oversized input are dropped", () => {
  expect(mirrorInput('{"type":"resize","cols":50,"rows":30}')).toBeNull()
  expect(mirrorInput(new Uint8Array(0))).toBeNull()
  expect(mirrorInput(new Uint8Array(5000).fill(97))).toBeNull()
})

// ── upgrade gate ──

function from(peer: string | null, url = "http://host:4245/api/pane-mirror?key=k1", headers: Record<string, string> = {}): [Request, URL] {
  const req = new Request(url, { headers })
  if (peer) recordPeer(req, peer)
  return [req, new URL(url)]
}
const SESS: Record<string, { key: string; herdrPane?: string; tmuxPane?: string }> = {
  k1: { key: "k1", herdrPane: "w3:p1" },
  tm: { key: "tm", herdrPane: "w3:p2", tmuxPane: "%4" },
  plain: { key: "plain" },
}
const deps = (over: Partial<MirrorUpgradeDeps> = {}): MirrorUpgradeDeps => ({
  authorized: () => true,
  lookup: (k) => SESS[k] ?? (k.startsWith("cwd:") ? SESS.k1! : null),
  viewers: () => 0,
  ...over,
})

test("gate: no header Bearer → 401 before anything else", async () => {
  const r = paneMirrorUpgrade(...from("127.0.0.1"), deps({ authorized: () => false }))
  expect((r as Response).status).toBe(401)
})

test("gate: LAN peer, forged XFF, Funnel and an unrecorded peer → 403 network_refused", async () => {
  for (const [req, url] of [
    from("192.168.2.40"),
    from("192.168.2.40", undefined, { "x-forwarded-for": "100.101.102.103" }),
    from("127.0.0.1", undefined, { "x-forwarded-for": "100.101.102.103", "tailscale-funnel-request": "?1" }),
    from(null),
  ]) {
    const r = paneMirrorUpgrade(req, url, deps()) as Response
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ ok: false, error: "network_refused" })
  }
})

test("gate: unknown key, empty key and a non-exact (cwd:) lookup → 410; not a herdr pane (or tmux inside herdr) → 409", async () => {
  for (const u of ["?key=nope", "?key=", "", "?key=cwd:/x"]) {
    expect((paneMirrorUpgrade(...from("127.0.0.1", `http://h/api/pane-mirror${u}`), deps()) as Response).status).toBe(410)
  }
  for (const k of ["plain", "tm"]) {
    const r = paneMirrorUpgrade(...from("127.0.0.1", `http://h/api/pane-mirror?key=${k}`), deps()) as Response
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ ok: false, error: "not_herdr" })
  }
})

test("gate: max viewers per pane → 429; tailnet/loopback with a herdr session → the pane", () => {
  expect((paneMirrorUpgrade(...from("100.88.1.2"), deps({ viewers: () => MAX_MIRROR_VIEWERS })) as Response).status).toBe(429)
  expect(paneMirrorUpgrade(...from("100.88.1.2"), deps({ viewers: () => MAX_MIRROR_VIEWERS - 1 }))).toEqual({ key: "k1", pane: "w3:p1" })
  expect(paneMirrorUpgrade(...from("127.0.0.1", undefined, { "x-forwarded-for": "100.101.102.103" }), deps())).toEqual({ key: "k1", pane: "w3:p1" })
})

// ── the mirror loop ──

function fakeSource(screens: Array<string | null>) {
  const sent: string[] = []
  let i = 0
  const src: MirrorSource = {
    read: async () => screens[Math.min(i++, screens.length - 1)] ?? null,
    cols: async () => 10,
    send: async (_p, t) => { sent.push(t) },
  }
  return { src, sent, reads: () => i }
}
function viewer() {
  const frames: string[] = []; const controls: unknown[] = []; const ends: Array<[number, string]> = []
  return { frames, controls, ends, v: { frame: (f: string) => frames.push(f), control: (c: string) => controls.push(JSON.parse(c)), end: (c: number, r: string) => ends.push([c, r]) } }
}

test("mirror: size then frame; unchanged polls send nothing; a change sends one repaint; a late viewer gets the current screen", async () => {
  const { clock, advance } = fakeClock()
  const { src } = fakeSource(["a\r\n", "a\r\n", "a\r\n", "b\r\nc\r\n"])
  const m = new PaneMirror("w3:p1", src, clock, { pollMs: 50, minFrameMs: 33 })
  const a = viewer()
  m.add(a.v)
  await advance(0)
  expect(a.controls).toEqual([{ type: "size", cols: 10, rows: 1 }])
  expect(a.frames).toEqual([repaintFrame("a\r\n")])
  await advance(160)
  expect(a.frames.length).toBe(2)
  expect(a.controls).toEqual([{ type: "size", cols: 10, rows: 1 }, { type: "size", cols: 10, rows: 2 }])
  const b = viewer()
  m.add(b.v)
  expect(b.controls).toEqual([{ type: "size", cols: 10, rows: 2 }])
  expect(b.frames).toEqual([repaintFrame("b\r\nc\r\n")])
  expect(m.remove(a.v)).toBe(false)
  expect(m.remove(b.v)).toBe(true)
})

test("mirror: input is forwarded in order; text frames are not", async () => {
  const { clock } = fakeClock()
  const { src, sent } = fakeSource(["x\r\n"])
  const m = new PaneMirror("w3:p1", src, clock)
  const e = new TextEncoder()
  m.input(e.encode("/")); m.input("{\"type\":\"resize\"}"); m.input(e.encode("\x1b[B")); m.input(e.encode("\r"))
  await new Promise((r) => setTimeout(r, 5))
  expect(sent).toEqual(["/", "\x1b[B", "\r"])
})

test("mirror: the pane stays unreadable → viewers closed 4000 gone and polling stops", async () => {
  const { clock, advance, pending } = fakeClock()
  const { src, reads } = fakeSource([null])
  const m = new PaneMirror("w3:p1", src, clock, { pollMs: 50 })
  const a = viewer()
  m.add(a.v)
  await advance(50 * (MIRROR_GONE_AFTER + 5))
  expect(a.ends).toEqual([[MIRROR_ENDED, "gone"]])
  expect(reads()).toBe(MIRROR_GONE_AFTER)
  expect(pending()).toBe(0)
})

test("mirror: a keystroke pulls the next poll forward to MIRROR_ECHO_MS instead of the full tick", async () => {
  const { clock, advance } = fakeClock()
  const { src, reads } = fakeSource(["a\r\n"])
  const m = new PaneMirror("w3:p1", src, clock, { pollMs: 1000 })
  m.add(viewer().v)
  await advance(0)
  expect(reads()).toBe(1)
  m.input(new TextEncoder().encode("x"))
  await advance(MIRROR_ECHO_MS)
  expect(reads()).toBe(2)
})
