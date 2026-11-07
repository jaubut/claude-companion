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
interface PaneRow { pane_id?: string; workspace_id?: string; terminal_id?: string; label?: string }

// The claude's pid: `exec` makes it the shell's. Throws when herdr can't say.
async function panePid(pane: string, h: Herdr): Promise<number> {
  const pid = ((await h.call(["pane", "process-info", "--pane", pane], 2_000)).process_info as { shell_pid?: unknown } | undefined)?.shell_pid
  if (typeof pid !== "number" || pid <= 0) throw new Error("process-info: no pid")
  return pid
}

// herdr reuses pane and workspace ids, so an id never proves a pane is ours.
// What does: the pane still carries SCRAPE_PANE_MARK, the terminal and the
// workspace this server created (or adopted from a listing after a restart).
// Every read and write goes through ownedScrape first. A pane that is gone or
// no longer ours drops its record for good, so a later answer can't revive it;
// herdr failing to answer throws, which the runner reports as unknown (-1).
// ponytail: check then act, a reuse inside that gap of a few ms is not
// covered; herdr 0.9.5 has no compare-and-send.
interface Owned { pane: string; terminal: string; workspace: string }
const scrapes = new Map<string, Owned>()
export function resetHerdrScrapes(): void { scrapes.clear() }

async function ownedScrape(name: string, h: Herdr): Promise<Owned | null> {
  const o = scrapes.get(name)
  if (!o) return null
  let p: PaneRow | undefined
  try {
    p = (await h.call(["pane", "get", o.pane], 2_000)).pane as PaneRow | undefined
  } catch (err) {
    if (herdrErrorCode(err) !== "pane_not_found") throw err
  }
  if (p?.label === SCRAPE_PANE_MARK && p.terminal_id === o.terminal && p.workspace_id === o.workspace) return o
  scrapes.delete(name)
  return null
}

// The newest record holding this pane id: an older scrape's stale id loses.
function nameOfPane(pane: string): string {
  return [...scrapes].findLast(([, o]) => o.pane === pane)?.[0] ?? ""
}

async function hasLabel(name: string, h: Herdr): Promise<boolean> {
  const list = (await h.call(["workspace", "list"], 3_000)).workspaces
  if (!Array.isArray(list)) throw new Error("workspace list: bad shape")
  return (list as WorkspaceRow[]).some((w) => w.label === name)
}

export function herdrScrapeRunner(h: Herdr = realHerdr, read: PaneReader = readPanePlain): TmuxRunner {
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
          scrapes.set(label, { pane: root.pane_id, terminal: root.terminal_id, workspace })
          await h.call(["pane", "rename", root.pane_id, SCRAPE_PANE_MARK])
          if (!await ownedScrape(label, h)) return MISSING
          // No pid, no claude: its HOME may only go once that pid has exited.
          const pid = await panePid(root.pane_id, h)
          if (!await ownedScrape(label, h)) return MISSING
          await h.call(["pane", "run", root.pane_id, ` ${args.at(-1)!}`])
          return { code: 0, stdout: `${root.pane_id}||${pid}|\n` }
        }
        case "capture-pane": {
          if (!await ownedScrape(nameOfPane(name), h)) return MISSING
          const text = await read(name)
          return text === null ? MISSING : { code: 0, stdout: text }
        }
        case "send-keys": {
          if (!await ownedScrape(nameOfPane(name), h)) return MISSING
          const keys = args.slice(args.indexOf("-t") + 2)
          const ok = keys[0] === "-l" ? await herdrSendText(name, keys[1]!, h) : await herdrSendKey(name, keys[0]!, h)
          return ok ? OK : MISSING
        }
        case "kill-session": {
          // A split someone added to the workspace survives: only a workspace
          // holding our pane alone is closed. Read first, ownership last.
          const o = scrapes.get(name)
          if (!o) return OK
          const count = ((await h.call(["workspace", "get", o.workspace], 2_000)).workspace as { pane_count?: unknown } | undefined)?.pane_count
          if (typeof count !== "number") return UNKNOWN
          if (!await ownedScrape(name, h)) return OK
          await h.call(count === 1 ? ["workspace", "close", o.workspace] : ["pane", "close", o.pane], 5_000)
          return OK
        }
        case "has-session": {
          if (await ownedScrape(name, h)) return OK
          // Not ours, or ours and gone: a workspace still wearing the label is
          // one nothing here can prove gone, so it is never reported as gone.
          return (await hasLabel(name, h)) ? UNKNOWN : MISSING
        }
        case "list-panes": {
          // Every cc-scrape-* workspace is listed, so the reaper keeps its HOME;
          // only one whose single marked pane is unambiguous gets a pane and is
          // adopted. A pid herdr can't give, or two marked panes, is no inventory.
          const [workspaces, panes] = await Promise.all([h.call(["workspace", "list"], 3_000), h.call(["pane", "list"], 3_000)])
          if (!Array.isArray(workspaces.workspaces) || !Array.isArray(panes.panes)) return UNKNOWN
          const rows: string[] = []
          for (const w of workspaces.workspaces as WorkspaceRow[]) {
            const label = w.label ?? ""
            if (!isScrapeSessionName(label)) continue
            const marked = (panes.panes as PaneRow[]).filter((p) => p.workspace_id === w.workspace_id && p.label === SCRAPE_PANE_MARK)
            if (marked.length > 1) return UNKNOWN
            const p = marked[0]
            if (!p?.pane_id || !p.terminal_id || !w.workspace_id) { rows.push(`${label}\t\t\t\t`); continue }
            const known = scrapes.get(label)
            if (known && (known.pane !== p.pane_id || known.terminal !== p.terminal_id || known.workspace !== w.workspace_id)) { rows.push(`${label}\t\t\t\t`); continue }
            scrapes.set(label, { pane: p.pane_id, terminal: p.terminal_id, workspace: w.workspace_id })
            rows.push(`${label}\t${p.pane_id}\t\t${await panePid(p.pane_id, h)}\t`)
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
