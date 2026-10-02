import { test, expect } from "bun:test"
import {
  isNoTty,
  markFirstDiscoveryDoneForTest,
  parseAgentPs,
  resetFirstDiscovery,
  resolveTmuxRef,
  tmuxPaneFromSessionFile,
  tmuxRefFromEnv,
  waitForFirstDiscovery,
} from "./discover"

// P1: Linux procps prints "?" for no controlling tty. It used to register
// every ttyless claude as `claude:tty:/dev/?` — one phantom row.
test("no-tty markers: ?? (macOS), ? (Linux), - (BSD) are all skipped", () => {
  expect(isNoTty("?")).toBe(true)
  expect(isNoTty("??")).toBe(true)
  expect(isNoTty("-")).toBe(true)
  expect(isNoTty("pts/3")).toBe(false)
  expect(isNoTty("ttys007")).toBe(false)
  const ps = [
    "  101 ?        claude",
    "  102 ??       claude",
    "  103 pts/3    claude --resume abc",
    "  104 ttys007  /usr/local/bin/claude",
    "  105 pts/4    codex exec do-thing",
    "  106 pts/5    bash",
  ].join("\n")
  expect(parseAgentPs(ps).map((a) => [a.pid, a.tty])).toEqual([["103", "/dev/pts/3"], ["104", "/dev/ttys007"]])
})

test("tmuxRefFromEnv: socket from $TMUX, pane from $TMUX_PANE", () => {
  expect(tmuxRefFromEnv(["HOME=/h", "TMUX=/tmp/tmux-1000/cc,55,0", "TMUX_PANE=%12"])).toEqual({ socket: "/tmp/tmux-1000/cc", pane: "%12" })
  expect(tmuxRefFromEnv(["TMUX_PANE=bogus"])).toEqual({ socket: "", pane: "" })
  expect(tmuxRefFromEnv(null)).toEqual({ socket: "", pane: "" })
  expect(tmuxPaneFromSessionFile("claude-1790825923:@85.%85")).toBe("%85")
})

test("resolveTmuxRef: env first, then the tty map, then the session file's bare pane", async () => {
  const env = (e: string[] | null) => async () => e
  const map = (m: Record<string, { pane: string; socket: string }>) => async () => new Map(Object.entries(m))
  // env has both halves
  expect(await resolveTmuxRef("1", "/dev/pts/1", "%9", { envOf: env(["TMUX=/s/cc,1,0", "TMUX_PANE=%3"]) }))
    .toEqual({ socket: "/s/cc", pane: "%3" })
  // env has the socket only: pane from the session file
  expect(await resolveTmuxRef("1", "/dev/pts/1", "%9", { envOf: env(["TMUX=/s/cc,1,0"]) }))
    .toEqual({ socket: "/s/cc", pane: "%9" })
  // env unreadable: the tty map names the server
  expect(await resolveTmuxRef("1", "/dev/pts/1", "%9", { envOf: env(null), ttyMap: map({ "/dev/pts/1": { pane: "%9", socket: "/s/cc" } }) }))
    .toEqual({ socket: "/s/cc", pane: "%9" })
  // nothing knows: the old behaviour (default server, file pane)
  expect(await resolveTmuxRef("1", "/dev/pts/1", "%9", { envOf: env(null), ttyMap: map({}) }))
    .toEqual({ socket: "", pane: "%9" })
  // not in tmux at all
  expect(await resolveTmuxRef("1", "/dev/ttys001", "", { envOf: env(["HOME=/h"]), ttyMap: map({}) }))
    .toEqual({ socket: "", pane: "" })
})

// P2: an init frame sent before the first discovery carries sessions: [].
test("waitForFirstDiscovery: immediate when no boot discovery was announced", async () => {
  resetFirstDiscovery(false)
  const t0 = Date.now()
  expect(await waitForFirstDiscovery(2_000)).toBe(true)
  expect(Date.now() - t0).toBeLessThan(100)
})

test("waitForFirstDiscovery: bounded when the boot pass is slow", async () => {
  resetFirstDiscovery(true)
  const t0 = Date.now()
  expect(await waitForFirstDiscovery(80)).toBe(false)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(75)
})

test("waitForFirstDiscovery: releases as soon as the boot pass finishes", async () => {
  resetFirstDiscovery(true)
  const waiting = waitForFirstDiscovery(5_000)
  setTimeout(markFirstDiscoveryDoneForTest, 20)
  const t0 = Date.now()
  expect(await waiting).toBe(true)
  expect(Date.now() - t0).toBeLessThan(1_000)
  expect(await waitForFirstDiscovery(5_000)).toBe(true)
})
