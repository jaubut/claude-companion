import { test, expect } from "bun:test"
import {
  isIgnoredAgentProcess,
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
  // nothing knows: no address — never the file pane on a guessed (default) server
  expect(await resolveTmuxRef("1", "/dev/pts/1", "%9", { envOf: env(null), ttyMap: map({}) }))
    .toEqual({ socket: "", pane: "" })
  // partial env (TMUX_PANE, no TMUX): the tty map names the server, never a default-server guess
  expect(await resolveTmuxRef("1", "/dev/pts/1", "", { envOf: env(["TMUX_PANE=%3"]), ttyMap: map({ "/dev/pts/1": { pane: "%3", socket: "/s/cc" } }) }))
    .toEqual({ socket: "/s/cc", pane: "%3" })
  expect(await resolveTmuxRef("1", "/dev/pts/1", "", { envOf: env(["TMUX_PANE=%3"]), ttyMap: map({}) }))
    .toEqual({ socket: "", pane: "" })
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

test("isIgnoredAgentProcess: a DISPATCH_WORKER=1 claude is skipped, a plain one is listed", async () => {
  const { resetDispatchWorkerCache } = await import("./dispatch-worker")
  resetDispatchWorkerCache()
  const envs: Record<string, string[]> = {
    "301": ["HOME=/h", "DISPATCH_WORKER=1", "DISPATCH_TASK_ID=abc"], // herdr pane worker, has a tty
    "302": ["HOME=/h", "TERM=xterm"],                                  // a human's claude
    "303": ["COMPANION_SCRAPE=1"],                                     // the companion's own scrape claude
  }
  const deps = { ownsTty: async () => true, envOf: async (pid: string) => envs[pid] ?? null }
  expect(await isIgnoredAgentProcess("301", "/dev/pts/7", deps)).toBe(true)
  expect(await isIgnoredAgentProcess("302", "/dev/pts/8", deps)).toBe(false)
  expect(await isIgnoredAgentProcess("303", "/dev/pts/9", deps)).toBe(true)
  expect(await isIgnoredAgentProcess("304", "/dev/pts/10", deps)).toBe(false) // env unreadable: listed, as before
})
