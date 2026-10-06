import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  type ScopeTask, agentFor, allProposals, assignProposals, duplicateMatch, hiddenBy, isSlip, isVague, loadAssignRules, mergeProposals,
  normalizeText, parseAssignRules, pmAssignPath, slipCounts, slipProposals, splitProposals,
} from "./tasks-agent-rules"

const PY = `
ROUTES: list[tuple[str, str]] = [
    # invoice OUT — sensitive (financial outbound), always human
    (r"\\b(send invoice|envoyer.*facture)\\b", "human"),
    (r"\\b(design|redesign|wireframe|figma)\\b", "frontend-design"),
    (r"\\b(og tags|open graph|sitemap|robots\\.txt)\\b", "seo-audit"),
    (r"\\b(post|publish)\\b.*\\b(reel|tiktok|stor(?:y|ies))\\b", "human"),
    (r"\\b(research|investigate|compare|étudier)\\b", "researcher"),
    (r"\\b(broken[)\\b", "researcher"),
]

VAGUE_HINTS = ["tbd"]
`

const rules = parseAssignRules(PY)

const t = (id: string, o: Partial<ScopeTask> = {}): ScopeTask => ({
  id, noteId: "projects/p1", parentId: null, text: `task ${id}`, description: null, due: null, position: 0,
  assignee: "human:jeremie", mine: true, project: "P1", folder: "projects", ...o,
})
const input = (tasks: ScopeTask[], slips = new Map<string, number>()) => ({ tasks, slips, rules, today: "2026-10-06" })

describe("pm-assign rules (read-only parse)", () => {
  test("parses the ROUTES tuples in order, skips an invalid regex", () => {
    expect(rules.map((r) => r.agent)).toEqual(["human", "frontend-design", "seo-audit", "human", "researcher"])
  })

  test("first match wins; a human route yields no proposal; agents get the agent: prefix", () => {
    expect(agentFor("Redesign the hero", rules)).toEqual({ assignee: "agent:frontend-design", rule: rules[1]!.pattern })
    expect(agentFor("Send invoice and redesign", rules)).toBeNull()
    expect(agentFor("Post the reel on TikTok", rules)).toBeNull()
    expect(agentFor("Compare two NAS options", rules)?.assignee).toBe("agent:researcher")
    expect(agentFor("Buy milk", rules)).toBeNull()
  })

  test("the live pm-assign.py parses into working rules when present", () => {
    if (!existsSync(pmAssignPath())) return
    const live = loadAssignRules()
    expect(live.length).toBeGreaterThan(10)
    expect(agentFor("Wireframe the booking page", live)?.assignee).toBe("agent:frontend-design")
  })
})

describe("rule: reschedule (slipping dates)", () => {
  test("a slip is a date pushed later or dropped; first dates and pull-ins are not", () => {
    expect(isSlip({ taskId: "a", from: null, to: "2026-10-01" })).toBe(false)
    expect(isSlip({ taskId: "a", from: "2026-10-01", to: "2026-10-08" })).toBe(true)
    expect(isSlip({ taskId: "a", from: "2026-10-08", to: "2026-10-01" })).toBe(false)
    expect(isSlip({ taskId: "a", from: "2026-10-08", to: null })).toBe(true)
  })

  test(">= 2 slips on my task → one proposal; 1 slip or someone else's task → none", () => {
    const slips = slipCounts([
      { taskId: "aaaaaaaaaa", from: "2026-09-01", to: "2026-09-08" },
      { taskId: "aaaaaaaaaa", from: "2026-09-08", to: "2026-09-20" },
      { taskId: "bbbbbbbbbb", from: "2026-09-01", to: "2026-09-08" },
      { taskId: "cccccccccc", from: "2026-09-01", to: "2026-09-08" },
      { taskId: "cccccccccc", from: "2026-09-08", to: "2026-09-10" },
    ])
    const ps = slipProposals(input([t("aaaaaaaaaa", { due: "2026-09-20" }), t("bbbbbbbbbb"), t("cccccccccc", { assignee: null, mine: false })], slips))
    expect(ps.map((p) => p.id)).toEqual(["slip:aaaaaaaaaa"])
    expect(ps[0]!.suggestion).toEqual({ slips: 2, due: "2026-09-20", suggestedDue: "2026-10-13" })
    expect(ps[0]!.kind).toBe("reschedule")
  })

  test("a decided slip stays hidden until it slips twice more", () => {
    const p = slipProposals(input([t("aaaaaaaaaa")], new Map([["aaaaaaaaaa", 3]])))[0]!
    expect(hiddenBy(p, { version: "2" })).toBe(true)
    expect(hiddenBy(p, { version: "1" })).toBe(false)
    expect(hiddenBy(p, undefined)).toBe(false)
  })
})

describe("rule: assign (unassigned + agent heuristic)", () => {
  test("only unassigned tasks matching an agent route", () => {
    const ps = assignProposals(input([
      t("aaaaaaaaaa", { assignee: null, mine: false, text: "Wireframe the new pricing page" }),
      t("bbbbbbbbbb", { text: "Wireframe the other page" }),
      t("cccccccccc", { assignee: null, mine: false, text: "Send invoice to Granby" }),
      t("dddddddddd", { assignee: null, mine: false, text: "Water the plants" }),
    ]))
    expect(ps.map((p) => [p.id, p.suggestion.assignee])).toEqual([["assign:aaaaaaaaaa", "agent:frontend-design"]])
  })
})

describe("rule: merge (duplicates in one note)", () => {
  test("normalization: case, accents, punctuation", () => {
    expect(normalizeText("  Créer la  FACTURE! ")).toBe("creer la facture")
    expect(duplicateMatch("Créer la facture", "creer la facture.")).toBe("exact")
    expect(duplicateMatch("Book the studio for the Granby shoot", "Book studio for the Granby shoot")).toBe("near")
    expect(duplicateMatch("Call Marie", "Call Pierre")).toBeNull()
    // A different number is a different task, however close the text.
    expect(duplicateMatch("Invoice 1041", "Invoice 1042")).toBeNull()
    expect(duplicateMatch("[Week 3] copy for the newsletter", "[Week 4] copy for the newsletter")).toBeNull()
  })

  test("same note only; keeps the first by position; a parent is never merged away", () => {
    const ps = mergeProposals(input([
      t("aaaaaaaaaa", { text: "Export the final cut", position: 1 }),
      t("bbbbbbbbbb", { text: "export the final cut!", position: 2 }),
      t("cccccccccc", { text: "Export the final cut", noteId: "projects/p2", position: 1 }),
      t("dddddddddd", { text: "Plan shoot day", position: 3 }),
      t("eeeeeeeeee", { text: "Plan shoot day", position: 4 }),
      t("ffffffffff", { text: "sub", parentId: "eeeeeeeeee", position: 5 }),
    ]))
    expect(ps.map((p) => p.id)).toEqual(["merge:aaaaaaaaaa:bbbbbbbbbb"])
    expect(ps[0]!.suggestion).toMatchObject({ keepId: "aaaaaaaaaa", duplicateId: "bbbbbbbbbb", match: "exact" })
  })
})

describe("rule: split (vague tasks)", () => {
  test("> 12 words and no opening action verb", () => {
    expect(isVague("the whole website thing with the new client and the photos and the blog maybe")).toBe(true)
    expect(isVague("Write the blog post about the new client launch and the photos and the reel")).toBe(false)
    expect(isVague("Préparer le tournage avec le client pour la nouvelle campagne et les photos du site")).toBe(false)
    expect(isVague("short vague thing")).toBe(false)
    expect(isVague("[SaaS gap vs PlanOps] Add electronic signature on quotes and invoices before the phase four launch")).toBe(false)
    expect(isVague("[Week 4] the soft launch thing with the list and the footer and the site and more")).toBe(true)
  })

  test("my root tasks only, never one that already has subtasks", () => {
    const vague = "the whole website thing with the new client and the photos and the blog maybe"
    const ps = splitProposals(input([
      t("aaaaaaaaaa", { text: vague }),
      t("bbbbbbbbbb", { text: vague, assignee: null, mine: false }),
      t("cccccccccc", { text: vague }),
      t("dddddddddd", { parentId: "cccccccccc" }),
    ]))
    expect(ps.map((p) => p.id)).toEqual(["split:aaaaaaaaaa"])
  })
})

test("allProposals: stable kind order", () => {
  const ps = allProposals(input([
    t("aaaaaaaaaa", { text: "the whole website thing with the new client and the photos and the blog maybe" }),
    t("bbbbbbbbbb", { assignee: null, mine: false, text: "Research NAS options" }),
  ], new Map([["aaaaaaaaaa", 2]])))
  expect(ps.map((p) => p.kind)).toEqual(["reschedule", "assign", "split"])
})
