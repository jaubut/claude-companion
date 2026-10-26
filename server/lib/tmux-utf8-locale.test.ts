import { describe, expect, test } from "bun:test"
import { ensureUtf8Locale } from "./tmux-pane"

describe("ensureUtf8Locale", () => {
  test("no locale (launchd) → LC_CTYPE=UTF-8", () => {
    const env: Record<string, string | undefined> = { HOME: "/h" }
    ensureUtf8Locale(env)
    expect(env.LC_CTYPE).toBe("UTF-8")
  })

  test("an existing UTF-8 locale is left alone", () => {
    const env: Record<string, string | undefined> = { LANG: "en_US.UTF-8" }
    ensureUtf8Locale(env)
    expect(env).toEqual({ LANG: "en_US.UTF-8" })
  })

  test("LC_ALL=C would override LC_CTYPE, so it goes", () => {
    const env: Record<string, string | undefined> = { LC_ALL: "C" }
    ensureUtf8Locale(env)
    expect(env.LC_ALL).toBeUndefined()
    expect(env.LC_CTYPE).toBe("UTF-8")
  })

  // The bug itself: tmux without a UTF-8 locale prints "\t" in -F as "_".
  test("tmux keeps tab separators once the locale is set", async () => {
    if (!Bun.which("tmux")) return
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME }
    ensureUtf8Locale(env)
    const p = Bun.spawnSync(["tmux", "-L", `utf8-probe-${process.pid}`, "-f", "/dev/null", "new-session", "-d", "-s", "p"], { env: env as Record<string, string> })
    try {
      const out = Bun.spawnSync(["tmux", "-L", `utf8-probe-${process.pid}`, "display-message", "-p", "-t", "p", "#{session_name}\t#{pane_id}"], { env: env as Record<string, string> })
      expect(p.exitCode).toBe(0)
      expect(out.stdout.toString().trim().split("\t").length).toBe(2)
    } finally {
      Bun.spawnSync(["tmux", "-L", `utf8-probe-${process.pid}`, "kill-server"])
    }
  })
})
