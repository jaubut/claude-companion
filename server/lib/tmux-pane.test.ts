import { test, expect } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listTmuxSockets,
  mapTtysToPanes,
  paneKey,
  paneRefOf,
  parsePaneTtys,
  sendKeysArgs,
  sessionCmdArgv,
  spawnNewSessionFlags,
  spawnServerFlags,
  spawnSocketName,
  spawnSocketPath,
  tmuxArgv,
  tmuxSocketFlags,
  tmuxSocketFromEnv,
} from "./tmux-pane"

test("tmuxSocketFromEnv: the first field of $TMUX, absolute paths only", () => {
  expect(tmuxSocketFromEnv("/private/tmp/tmux-501/default,2080,87")).toBe("/private/tmp/tmux-501/default")
  expect(tmuxSocketFromEnv("/tmp/tmux-1000/cc,4242,0")).toBe("/tmp/tmux-1000/cc")
  expect(tmuxSocketFromEnv("")).toBe("")
  expect(tmuxSocketFromEnv(null)).toBe("")
  expect(tmuxSocketFromEnv(undefined)).toBe("")
  expect(tmuxSocketFromEnv("garbage")).toBe("")
  expect(tmuxSocketFromEnv(",123,0")).toBe("")
})

test("tmuxArgv / tmuxSocketFlags: bare tmux for the default server, -S otherwise", () => {
  expect(tmuxArgv()).toEqual(["tmux"])
  expect(tmuxArgv("")).toEqual(["tmux"])
  expect(tmuxArgv("/tmp/tmux-501/cc")).toEqual(["tmux", "-S", "/tmp/tmux-501/cc"])
  expect(tmuxSocketFlags(null)).toEqual([])
  expect(sendKeysArgs({ pane: "%3", socket: "/s" }, "-l", "x")).toEqual(["-S", "/s", "send-keys", "-t", "%3", "-l", "x"])
  expect(sendKeysArgs({ pane: "%3", socket: "" }, "Enter")).toEqual(["send-keys", "-t", "%3", "Enter"])
})

test("paneKey: (socket, pane) identity; default server keeps the bare id", () => {
  expect(paneKey("%3")).toBe("%3")
  expect(paneKey("%3", "")).toBe("%3")
  expect(paneKey("%3", "/tmp/tmux-501/cc")).toBe("/tmp/tmux-501/cc|%3")
  expect(paneKey("%3", "/tmp/tmux-501/cc")).not.toBe(paneKey("%3", "/tmp/tmux-501/default"))
  expect(paneRefOf({ tmuxPane: " %4 ", tmuxSocket: "/s" })).toEqual({ pane: "%4", socket: "/s" })
  expect(paneRefOf({ tmuxPane: "" })).toBeNull()
  expect(paneRefOf(null)).toBeNull()
})

test("parsePaneTtys ignores junk lines", () => {
  const m = parsePaneTtys("%1 /dev/ttys001\n%2 /dev/pts/4\nnot-a-pane /dev/x\n\n")
  expect([...m]).toEqual([["/dev/ttys001", "%1"], ["/dev/pts/4", "%2"]])
})

test("mapTtysToPanes: one tty → (socket, pane) across servers; same pane id on two servers stays distinct", async () => {
  const out: Record<string, string> = {
    "/s/default": "%3 /dev/pts/1\n%4 /dev/pts/2\n",
    "/s/cc": "%3 /dev/pts/9\n",
    "/s/dead": "",
  }
  const m = await mapTtysToPanes(["/s/default", "/s/cc", "/s/dead"], async (s) => out[s] || null)
  expect(m.get("/dev/pts/1")).toEqual({ pane: "%3", socket: "/s/default" })
  expect(m.get("/dev/pts/9")).toEqual({ pane: "%3", socket: "/s/cc" })
  expect(m.get("/dev/pts/2")).toEqual({ pane: "%4", socket: "/s/default" })
  expect(m.size).toBe(3)
})

test("listTmuxSockets: every entry of $TMUX_TMPDIR/tmux-<uid>, realpath'd", async () => {
  const root = await mkdtemp(join(tmpdir(), "tmuxsock-"))
  try {
    await mkdir(join(root, "tmux-77"))
    await writeFile(join(root, "tmux-77", "default"), "")
    await writeFile(join(root, "tmux-77", "cc"), "")
    const got = (await listTmuxSockets({ TMUX_TMPDIR: root }, 77)).sort()
    const real = await realpath(join(root, "tmux-77"))
    expect(got).toEqual([join(real, "cc"), join(real, "default")])
    expect(await listTmuxSockets({ TMUX_TMPDIR: root }, 78)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── Spawn server (COMPANION_TMUX_SOCKET / COMPANION_TMUX_CONF) ───────────

test("spawn server: unset → no flags, no socket path (the Mac's behaviour)", () => {
  expect(spawnSocketName({})).toBe("")
  expect(spawnServerFlags({})).toEqual([])
  expect(spawnNewSessionFlags({})).toEqual([])
  expect(spawnSocketPath({}, 501)).toBe("")
  // A conf alone does not move the default server onto a new config.
  expect(spawnNewSessionFlags({ COMPANION_TMUX_CONF: "/home/a/.tmux/cc.conf" })).toEqual([])
  expect(spawnServerFlags({ COMPANION_TMUX_SOCKET: "   " })).toEqual([])
})

test("spawn server: set → -L <name>; -f <conf> only on new-session", () => {
  const env = { COMPANION_TMUX_SOCKET: "cc", COMPANION_TMUX_CONF: "/home/a/.tmux/cc.conf" }
  expect(spawnServerFlags(env)).toEqual(["-L", "cc"])
  expect(spawnNewSessionFlags(env)).toEqual(["-L", "cc", "-f", "/home/a/.tmux/cc.conf"])
  expect(spawnNewSessionFlags({ COMPANION_TMUX_SOCKET: "cc" })).toEqual(["-L", "cc"])
})

test("spawn server: a name that is a path or carries metacharacters is refused", () => {
  for (const bad of ["/tmp/x", "a b", "cc;id", "$(id)", "../cc", "cc'"]) {
    expect(spawnServerFlags({ COMPANION_TMUX_SOCKET: bad })).toEqual([])
    expect(spawnSocketPath({ COMPANION_TMUX_SOCKET: bad }, 501)).toBe("")
  }
})

test("spawn server: socket path is $TMUX_TMPDIR/tmux-<uid>/<name>, dir realpath'd like $TMUX", async () => {
  const base = await mkdtemp(join(tmpdir(), "cc-sock-"))
  try {
    await mkdir(join(base, "tmux-501"))
    const real = await realpath(join(base, "tmux-501"))
    expect(spawnSocketPath({ COMPANION_TMUX_SOCKET: "cc", TMUX_TMPDIR: base }, 501)).toBe(join(real, "cc"))
    // Dir not created yet → unresolved but well-formed.
    expect(spawnSocketPath({ COMPANION_TMUX_SOCKET: "cc", TMUX_TMPDIR: base }, 777)).toBe(join(base, "tmux-777", "cc"))
    // The discovery side parses the same string out of $TMUX.
    expect(tmuxSocketFromEnv(`${join(real, "cc")},1234,0`)).toBe(join(real, "cc"))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("sessionCmdArgv: by-name commands carry the recorded socket, none for default", () => {
  expect(sessionCmdArgv(null, "kill-session", "cc-x")).toEqual(["tmux", "kill-session", "-t", "cc-x"])
  expect(sessionCmdArgv("", "send-keys", "cc-x", "Enter")).toEqual(["tmux", "send-keys", "-t", "cc-x", "Enter"])
  expect(sessionCmdArgv("/tmp/tmux-1000/cc", "kill-session", "cc-x"))
    .toEqual(["tmux", "-S", "/tmp/tmux-1000/cc", "kill-session", "-t", "cc-x"])
  expect(sessionCmdArgv("/tmp/tmux-1000/cc", "send-keys", "cc-x", "-l", "hi"))
    .toEqual(["tmux", "-S", "/tmp/tmux-1000/cc", "send-keys", "-t", "cc-x", "-l", "hi"])
})
