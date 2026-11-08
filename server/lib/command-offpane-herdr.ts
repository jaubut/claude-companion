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

import { type Herdr, SCRAPE_PANE_MARK, herdrErrorCode, herdrSendKey, herdrSendText, realHerdr } from "./herdr"
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

interface WorkspaceRow { workspace_id?: string; label?: string }
interface PaneRow { pane_id?: string; workspace_id?: string; terminal_id?: string; label?: string; agent?: string }

// The claude's pid: `exec` makes it the shell's. Throws when herdr can't say.
async function panePid(pane: string, h: Herdr): Promise<number> {
  const pid = ((await h.call(["pane", "process-info", "--pane", pane], 2_000)).process_info as { shell_pid?: unknown } | undefined)?.shell_pid
  if (typeof pid !== "number" || pid <= 0) throw new Error("process-info: no pid")
  return pid
}

// herdr reuses pane and workspace ids, so an id never proves a pane is ours.
// What does: the pane still carries its scrape's own mark,
// `companion-scrape:<session name>`, the terminal and the workspace this
// server created (or adopted from a listing after a restart). The name in the
// mark binds a pane to one scrape, so a reused workspace id can never pair a
// dead owner's label with a newer scrape's pane.
// Every read and write goes through ownedScrape first. A pane that is gone or
// no longer ours marks its record gone for good, so a later answer can't
// revive it and has-session can say so even while a split keeps the label;
// herdr failing to answer throws, which the runner reports as unknown (-1).
// ponytail: check then act, a reuse inside that gap of a few ms is not
// covered; herdr 0.9.5 has no compare-and-send. Gone records stay (one per
// run, a few a day) until the process ends.
// `unmarked`: created, not yet (or never) renamed, nothing launched in it. Such
// a pane is ours only while the ids hold and no agent runs in it, and that is
// what lets cleanup close it after a failed rename. `pid`: the claude's, once
// known; a later lookup never replaces it.
interface Owned { pane: string; terminal: string; workspace: string; gone?: boolean; unmarked?: boolean; pid?: number }
const scrapes = new Map<string, Owned>()
export function resetHerdrScrapes(): void { scrapes.clear() }

const markOf = (name: string): string => `${SCRAPE_PANE_MARK}:${name}`

async function ownedScrape(name: string, h: Herdr): Promise<Owned | null> {
  const o = scrapes.get(name)
  if (!o || o.gone) return null
  let p: PaneRow | undefined
  try {
    p = (await h.call(["pane", "get", o.pane], 2_000)).pane as PaneRow | undefined
  } catch (err) {
    if (herdrErrorCode(err) !== "pane_not_found") throw err
  }
  const mine = o.unmarked ? !p?.agent : p?.label === markOf(name)
  if (mine && p?.terminal_id === o.terminal && p.workspace_id === o.workspace) return o
  o.gone = true
  return null
}

async function hasLabel(name: string, h: Herdr): Promise<boolean> {
  const list = (await h.call(["workspace", "list"], 3_000)).workspaces
  if (!Array.isArray(list)) throw new Error("workspace list: bad shape")
  return (list as WorkspaceRow[]).some((w) => w.label === name)
}

// One runner drives one enumeration: its reads and keys go to the scrape it
// created, never to whichever record holds a pane id now.
export function herdrScrapeRunner(h: Herdr = realHerdr, read: PaneReader = readPanePlain): TmuxRunner {
  let mine = ""
  const minePane = async (pane: string): Promise<boolean> =>
    !!mine && scrapes.get(mine)?.pane === pane && !!await ownedScrape(mine, h)
  return async (args) => {
    const name = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "")
    try {
      switch (args[0]) {
        case "new-session": {
          const label = args[args.indexOf("-s") + 1]!
          const r = await h.call(["workspace", "create", "--cwd", "/tmp", "--label", label, "--no-focus"])
          const root = r.root_pane as PaneRow | undefined
          const workspace = (r.workspace as WorkspaceRow | undefined)?.workspace_id
          if (!root?.pane_id || !root.terminal_id || !workspace) return UNKNOWN
          mine = label
          const rec: Owned = { pane: root.pane_id, terminal: root.terminal_id, workspace, unmarked: true }
          scrapes.set(label, rec)
          // The ids create returned must still hold before even the rename.
          if (!await ownedScrape(label, h)) return MISSING
          await h.call(["pane", "rename", root.pane_id, markOf(label)])
          rec.unmarked = false
          if (!await ownedScrape(label, h)) return MISSING
          // No pid, no claude: its HOME may only go once that pid has exited.
          const pid = await panePid(root.pane_id, h)
          rec.pid = pid
          if (!await ownedScrape(label, h)) return MISSING
          // A lost reply may still have launched claude: pane and pid go back
          // either way, so cleanup waits for that pid before the HOME goes.
          const out = `${root.pane_id}||${pid}|\n`
          const ran = await h.call(["pane", "run", root.pane_id, ` ${args.at(-1)!}`]).then(() => true, () => false)
          return { code: ran ? 0 : -1, stdout: out }
        }
        case "capture-pane": {
          if (!await minePane(name)) return MISSING
          const text = await read(name)
          return text === null ? MISSING : { code: 0, stdout: text }
        }
        case "send-keys": {
          if (!await minePane(name)) return MISSING
          const keys = args.slice(args.indexOf("-t") + 2)
          const ok = keys[0] === "-l" ? await herdrSendText(name, keys[1]!, h) : await herdrSendKey(name, keys[0]!, h)
          return ok ? OK : MISSING
        }
        case "kill-session": {
          // Our pane only, never the workspace: a split someone adds can land
          // after any read of it. The workspace goes with its last pane.
          const o = await ownedScrape(name, h)
          if (o) await h.call(["pane", "close", o.pane], 5_000)
          return OK
        }
        case "has-session": {
          if (scrapes.has(name)) return (await ownedScrape(name, h)) ? OK : MISSING
          // Never ours to check: a workspace still wearing the label is one
          // nothing here can prove gone, so it is never reported as gone.
          return (await hasLabel(name, h)) ? UNKNOWN : MISSING
        }
        case "list-panes": {
          // Every cc-scrape-* workspace is listed, so the reaper keeps its HOME;
          // only one whose single pane marked with that same name is
          // unambiguous gets a pane and is adopted. A pid herdr can't give, or
          // two such panes, is no inventory.
          const [workspaces, panes] = await Promise.all([h.call(["workspace", "list"], 3_000), h.call(["pane", "list"], 3_000)])
          if (!Array.isArray(workspaces.workspaces) || !Array.isArray(panes.panes)) return UNKNOWN
          const rows: string[] = []
          for (const w of workspaces.workspaces as WorkspaceRow[]) {
            const label = w.label ?? ""
            if (!isScrapeSessionName(label)) continue
            const marked = (panes.panes as PaneRow[]).filter((p) => p.workspace_id === w.workspace_id && p.label === markOf(label))
            if (marked.length > 1) return UNKNOWN
            const p = marked[0]
            if (!p?.pane_id || !p.terminal_id || !w.workspace_id) { rows.push(`${label}\t\t\t\t`); continue }
            const known = scrapes.get(label)
            if (known && (known.gone || known.pane !== p.pane_id || known.terminal !== p.terminal_id || known.workspace !== w.workspace_id)) { rows.push(`${label}\t\t\t\t`); continue }
            // A known pid stands. A looked-up one counts only if the pane
            // still holds the listed terminal right after: the id may have
            // been reissued between the listing and the lookup.
            let pid = known?.pid
            if (!pid) {
              pid = await panePid(p.pane_id, h)
              const now = (await h.call(["pane", "get", p.pane_id], 2_000)).pane as PaneRow | undefined
              if (now?.terminal_id !== p.terminal_id || now.workspace_id !== w.workspace_id || now.label !== markOf(label)) return UNKNOWN
            }
            if (known) known.pid = pid
            else scrapes.set(label, { pane: p.pane_id, terminal: p.terminal_id, workspace: w.workspace_id, pid })
            rows.push(`${label}\t${p.pane_id}\t\t${pid}\t`)
          }
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
