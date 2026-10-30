import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HerdrPaneSizer } from "./pane-mirror"

// A stand-in herdr: logs its argv, then each stdin line, until EOF.
function fakeHerdr(body = 'while IFS= read -r l; do echo "$l" >> "$LOG"; done; echo eof >> "$LOG"') {
  const dir = mkdtempSync(join(tmpdir(), "cc-sizer-"))
  const bin = join(dir, "herdr")
  const log = join(dir, "log")
  writeFileSync(bin, `#!/bin/sh\nLOG=${log}\necho "argv $*" >> "$LOG"\n${body}\n`)
  chmodSync(bin, 0o755)
  writeFileSync(log, "")
  return { bin, lines: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) }
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10)
}

test("sizer: first size spawns the controller, later sizes go over stdin, null closes stdin; no loss reported", async () => {
  const h = fakeHerdr()
  let lost = 0
  const s = new HerdrPaneSizer("w3:p1", () => { lost++ }, h.bin)
  s.set({ cols: 48, rows: 30 })
  s.set({ cols: 40, rows: 25 })
  await until(() => h.lines().length >= 2)
  s.set(null)
  await until(() => h.lines().includes("eof"))
  await Bun.sleep(30)
  expect(h.lines()).toEqual([
    "argv terminal session control w3:p1 --cols 48 --rows 30",
    '{"type":"terminal.resize","cols":40,"rows":25}',
    "eof",
  ])
  expect(lost).toBe(0)
  s.set(null) // nothing held → no-op
})

test("sizer: a controller that ends on its own (refused, killed) reports the loss once; the next size respawns", async () => {
  const h = fakeHerdr("exit 0")
  let lost = 0
  const s = new HerdrPaneSizer("w3:p1", () => { lost++ }, h.bin)
  s.set({ cols: 48, rows: 30 })
  await until(() => lost > 0)
  expect(lost).toBe(1)
  s.set({ cols: 50, rows: 30 })
  await until(() => lost > 1)
  expect(h.lines()).toEqual([
    "argv terminal session control w3:p1 --cols 48 --rows 30",
    "argv terminal session control w3:p1 --cols 50 --rows 30",
  ])
})

// ── tmux source, against a private tmux server (its own -S socket) ──
// Skipped where tmux is missing (CI image), like tmux-utf8-locale.test.ts.

import { tmuxPaneSource } from "./pane-mirror"
import { createKeyGate } from "../lib/key-gate"

async function privateTmux(cmd: string) {
  const dir = mkdtempSync(join(tmpdir(), "cc-mirror-tmux-"))
  const socket = join(dir, "s")
  const out = join(dir, "out")
  const run = (...a: string[]) => Bun.spawnSync(["tmux", "-S", socket, "-f", "/dev/null", ...a], { stdout: "pipe", stderr: "pipe" })
  run("new-session", "-d", "-x", "80", "-y", "24", "-s", "t", cmd.replace("$OUT", out))
  const pane = run("display-message", "-p", "-t", "t", "#{pane_id}").stdout.toString().trim()
  return { socket, pane, out, kill: () => run("kill-server") }
}

test.skipIf(!Bun.which("tmux"))("tmux source: send is byte-exact for control bytes, ESC sequences, UTF-8 and a leading dash", async () => {
  // The pane's program records raw stdin bytes (no line discipline) as hex.
  const t = await privateTmux("stty raw -echo; head -c 13 | od -An -tx1 > $OUT")
  try {
    const src = tmuxPaneSource({ pane: t.pane, socket: t.socket }, createKeyGate({ settleMs: 0 }))
    await src.send(t.pane, "a\x1b[B")
    await src.send(t.pane, "é\x03\r")
    await src.send(t.pane, "-x;q\x7f") // would read as an option / a command separator without -H
    await until(() => { try { return readFileSync(t.out, "utf8").trim().length > 0 } catch { return false } })
    expect(readFileSync(t.out, "utf8").trim().split(/\s+/)).toEqual(["61", "1b", "5b", "42", "c3", "a9", "03", "0d", "2d", "78", "3b", "71", "7f"])
  } finally { t.kill() }
})

test.skipIf(!Bun.which("tmux"))("tmux source: read = the visible screen with escapes, one row per line; cols = pane_width; a dead pane reads null", async () => {
  const t = await privateTmux("printf '\\033[31mred\\033[0m line\\n'; sleep 30")
  try {
    const src = tmuxPaneSource({ pane: t.pane, socket: t.socket })
    let screen: string | null = null
    await until(() => { void src.read(t.pane).then((s) => { screen = s }); return !!screen && screen.includes("red") })
    expect(screen!).toContain("\x1b[31mred")
    expect(screen!.split("\n").length - 1).toBe(24)
    expect(await src.cols(t.pane)).toBe(80)
  } finally { t.kill() }
  expect(await tmuxPaneSource({ pane: t.pane, socket: t.socket }).read(t.pane)).toBeNull()
})
