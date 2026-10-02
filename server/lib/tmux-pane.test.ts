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
