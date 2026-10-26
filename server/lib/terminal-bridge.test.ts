import { test, expect } from "bun:test"
import { TERMINAL_ENDED, openTerminal, parseControl, terminalAttachArgv, terminalEnv, terminalSize, type PtySpawner } from "./terminal-bridge"
import type { ShellSession } from "./shell-sessions"

// The /api/terminal bridge: phone socket ↔ `tmux attach-session` under a PTY.

const SHELL: ShellSession = { key: "shell:sh-a", name: "sh-a", cwd: "/x", tmuxPane: "%7", tmuxSocket: "/tmp/tmux-501/cc", createdAt: 1 }

test("attach argv: exact-match session on the shell's own tmux server", () => {
  expect(terminalAttachArgv(SHELL)).toEqual(["tmux", "-S", "/tmp/tmux-501/cc", "attach-session", "-t", "=sh-a"])
  expect(terminalAttachArgv({ name: "sh-a", tmuxSocket: "" })).toEqual(["tmux", "attach-session", "-t", "=sh-a"])
})

test("size: clamped integers, junk → phone default", () => {
  expect(terminalSize("80", "24")).toEqual({ cols: 80, rows: 24 })
  expect(terminalSize("2", "9999")).toEqual({ cols: 20, rows: 200 })
  expect(terminalSize(null, "x")).toEqual({ cols: 50, rows: 30 })
  expect(terminalSize("40.5", "-1")).toEqual({ cols: 50, rows: 5 })
})

test("env: xterm-256color, $TMUX dropped so attach is not refused as nested", () => {
  const env = terminalEnv({ TMUX: "/tmp/x,1,0", TMUX_PANE: "%1", HOME: "/h", LANG: "fr_CA.UTF-8" })
  expect(env).toEqual({ HOME: "/h", LANG: "fr_CA.UTF-8", TERM: "xterm-256color" })
})

test("control: only resize frames parse", () => {
  expect(parseControl(`{"type":"resize","cols":100,"rows":40}`)).toEqual({ cols: 100, rows: 40 })
  expect(parseControl(`{"type":"input","data":"ls"}`)).toBeNull()
  expect(parseControl("ls -la")).toBeNull()
})

function fakePty() {
  const writes: Uint8Array[] = []
  const resizes: [number, number][] = []
  let closed = 0
  let exit!: (code: number) => void
  let emit!: (d: Uint8Array) => void
  let argv: string[] = []
  const spawner: PtySpawner = (a, _size, onData) => {
    argv = a
    emit = onData
    return {
      write: (d) => writes.push(typeof d === "string" ? new TextEncoder().encode(d) : d),
      resize: (c, r) => resizes.push([c, r]),
      close: () => { closed++ },
      exited: new Promise<number>((r) => { exit = r }),
    }
  }
  return { spawner, writes, resizes, closed: () => closed, exit: (c: number) => exit(c), emit: (d: Uint8Array) => emit(d), argv: () => argv }
}

function fakeSock() {
  const sent: Uint8Array[] = []
  const ends: [number, string][] = []
  return { sock: { send: (d: Uint8Array) => sent.push(d), end: (c: number, r: string) => ends.push([c, r]) }, sent, ends }
}

test("bridge: output → socket, binary input → PTY, resize frame → resize, other text ignored", () => {
  const p = fakePty()
  const s = fakeSock()
  const t = openTerminal(SHELL, { cols: 50, rows: 30 }, s.sock, p.spawner)
  expect(p.argv()).toEqual(terminalAttachArgv(SHELL))
  p.emit(new TextEncoder().encode("$ "))
  expect(new TextDecoder().decode(s.sent[0])).toBe("$ ")
  t.input(Buffer.from("ls\r"))
  t.input(`{"type":"resize","cols":90,"rows":33}`)
  t.input("rm -rf /")
  expect(p.writes.map((w) => new TextDecoder().decode(w))).toEqual(["ls\r"])
  expect(p.resizes).toEqual([[90, 33]])
})

test("bridge: the attach ends (shell exit) → socket closed 4000 ended, onEnded called", async () => {
  const p = fakePty()
  const s = fakeSock()
  let ended = 0
  openTerminal(SHELL, { cols: 50, rows: 30 }, s.sock, p.spawner, () => { ended++ })
  p.exit(0)
  await Bun.sleep(0)
  expect(s.ends).toEqual([[TERMINAL_ENDED, "ended"]])
  expect(ended).toBe(1)
})

test("bridge: phone closes → PTY closed once (detach only), nothing written after", async () => {
  const p = fakePty()
  const s = fakeSock()
  const t = openTerminal(SHELL, { cols: 50, rows: 30 }, s.sock, p.spawner)
  t.close()
  t.close()
  t.input(Buffer.from("late"))
  p.emit(new TextEncoder().encode("late output"))
  p.exit(0)
  await Bun.sleep(0)
  expect(p.closed()).toBe(1)
  expect(p.writes).toEqual([])
  expect(s.sent).toEqual([])
  expect(s.ends).toEqual([])
})
