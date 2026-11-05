// The hidden `/help` session (lib/command-offpane.ts) as a herdr workspace.
//
// Herdr-only, Stage 3: same lifecycle, new floor. The enumeration, the reaper
// and their tests speak the tmux verbs of a TmuxRunner, so this answers the
// few verbs they use from herdr instead of rewriting them; Stage 5 can flatten
// it once the tmux path is gone. A failed herdr call is code -1 ("unknown"),
// never a real tmux exit code, so nothing is taken as proof that a session
// is gone. "No such session" is the only code 1.
//
// `pane run` types the command into the workspace's login shell, whose `exec`
// makes claude the pane's process, so its pid is the shell's and the workspace
// goes when claude does. Leading space: a shell with ignorespace leaves it out
// of its history.
//
// A cc-scrape-* workspace is visible in a herdr client for the ~30 s of a run.
// herdr detects the claude in it as an agent; nothing here reads that. Hooks
// are off, and ps-discovery skips it by its environment (scrape-registry.ts).

import { type Herdr, herdrSendKey, herdrSendText, realHerdr } from "./herdr"
import { herdrSocketCall } from "./herdr-socket"
import { isScrapeSessionName } from "./scrape-registry"
import type { TmuxResult, TmuxRunner } from "./command-offpane-launch"

const OK: TmuxResult = { code: 0, stdout: "" }
const UNKNOWN: TmuxResult = { code: -1, stdout: "" }
const MISSING: TmuxResult = { code: 1, stdout: "" }

export type PaneReader = (pane: string) => Promise<string | null>

export const readPanePlain: PaneReader = async (pane) => {
  const r = await herdrSocketCall("pane.read", { pane_id: pane, source: "visible", format: "text" }, { timeoutMs: 1_500 })
  const text = (r.read as { text?: unknown } | undefined)?.text
  return typeof text === "string" ? text : null
}

type WorkspaceRow = { workspace_id?: string; label?: string }

async function workspaceOf(label: string, h: Herdr): Promise<string | null | undefined> {
  const list = (await h.call(["workspace", "list"], 3_000)).workspaces
  if (!Array.isArray(list)) throw new Error("workspace list: bad shape")
  return (list as WorkspaceRow[]).find((w) => w.label === label)?.workspace_id
}

async function panePid(pane: string, h: Herdr): Promise<number> {
  const info = await h.call(["pane", "process-info", "--pane", pane], 2_000).catch(() => ({}) as Record<string, unknown>)
  return (info.process_info as { shell_pid?: number } | undefined)?.shell_pid ?? 0
}

// herdr reuses pane ids: once a scrape's workspace is gone, its id can name a
// human's pane. So a read or write first checks the pane still holds the
// terminal this scrape created. ponytail: check then act, a reuse inside that
// gap of a few ms is not covered; herdr has no compare-and-send.
const scrapeTerminals = new Map<string, string>()

async function ownedPane(pane: string, h: Herdr): Promise<boolean> {
  const terminal = scrapeTerminals.get(pane)
  if (!terminal) return false
  const p = (await h.call(["pane", "get", pane], 2_000)).pane as { terminal_id?: string } | undefined
  return p?.terminal_id === terminal
}

export function herdrScrapeRunner(h: Herdr = realHerdr, read: PaneReader = readPanePlain): TmuxRunner {
  return async (args) => {
    const name = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "")
    try {
      switch (args[0]) {
        case "new-session": {
          const label = args[args.indexOf("-s") + 1]!
          const r = await h.call(["workspace", "create", "--cwd", "/tmp", "--label", label, "--no-focus"])
          const root = r.root_pane as { pane_id?: string; terminal_id?: string } | undefined
          const pane = root?.pane_id ?? ""
          if (!pane || !root?.terminal_id) return UNKNOWN
          scrapeTerminals.set(pane, root.terminal_id)
          await h.call(["pane", "run", pane, ` ${args.at(-1)!}`])
          return { code: 0, stdout: `${pane}||${await panePid(pane, h)}|\n` }
        }
        case "capture-pane": {
          if (!await ownedPane(name, h)) return MISSING
          const text = await read(name)
          return text === null ? MISSING : { code: 0, stdout: text }
        }
        case "send-keys": {
          if (!await ownedPane(name, h)) return MISSING
          const keys = args.slice(args.indexOf("-t") + 2)
          const ok = keys[0] === "-l" ? await herdrSendText(name, keys[1]!, h) : await herdrSendKey(name, keys[0]!, h)
          return ok ? OK : MISSING
        }
        case "kill-session": {
          const ws = await workspaceOf(name, h)
          if (ws) await h.call(["workspace", "close", ws], 5_000)
          return OK
        }
        case "has-session":
          return (await workspaceOf(name, h)) ? OK : MISSING
        case "list-panes": {
          const [workspaces, panes] = await Promise.all([h.call(["workspace", "list"], 3_000), h.call(["pane", "list"], 3_000)])
          if (!Array.isArray(workspaces.workspaces) || !Array.isArray(panes.panes)) return UNKNOWN
          const scrapes = (workspaces.workspaces as WorkspaceRow[]).filter((w) => isScrapeSessionName(w.label ?? ""))
          const rows = await Promise.all(scrapes.map(async (w) => {
            const pane = (panes.panes as Array<{ workspace_id?: string; pane_id?: string }>).find((x) => x.workspace_id === w.workspace_id)?.pane_id ?? ""
            return `${w.label}\t${pane}\t\t${pane ? await panePid(pane, h) : ""}\t`
          }))
          return { code: 0, stdout: rows.join("\n") }
        }
        default:
          return UNKNOWN // show-environment: nothing to ask, the process env counts
      }
    } catch {
      return UNKNOWN
    }
  }
}
