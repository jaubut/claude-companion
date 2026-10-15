import { describe, expect, test } from "bun:test"
import { REPO_YES_INSTRUCTION } from "./resolver"
import { type ResolverContext, buildResolverPrompt } from "./resolver-prompt"
import type { SourceItem } from "./triage"

// The resolver prompt per autonomy: a normal run gets no instruction, an
// ask_opus (elevated) run gets Jeremie's words, a delegated run (his Yes on a
// repo card) gets the repo-Yes instruction plus the why / confidence rule.

const src: SourceItem = {
  source: "task", refId: "t1", version: "blocked|1", title: "Invoice totals", project: "Dash", createdAt: 1, updatedAt: 1,
  facts: { status: "blocked", blocker: "Round per line or on the total?" }, url: null, ref: { source: "task", taskId: "t1", status: "blocked", channel: "general" },
}
const ctx: ResolverContext = { repo: null, readableDirs: [], blocks: [], sensitivePaths: [], sensitive: false, rescuedBefore: false }

describe("buildResolverPrompt per autonomy", () => {
  test("normal: no hand-back preamble", () => {
    const p = buildResolverPrompt(src, ctx, { autonomy: "normal", instruction: null })
    expect(p).not.toContain("handed this item back")
    expect(p).not.toContain("said Yes")
  })

  test("elevated: Jeremie's instruction and the consent rule (unchanged)", () => {
    const p = buildResolverPrompt(src, ctx, { autonomy: "elevated", instruction: "make it smaller" })
    expect(p).toContain('with this instruction: "make it smaller"')
    expect(p).toContain('Set "consent": true')
  })

  test("delegated: the repo-Yes instruction is never dropped, and the why / confidence line is asked for", () => {
    const p = buildResolverPrompt(src, ctx, { autonomy: "delegated", instruction: REPO_YES_INSTRUCTION })
    expect(p).toContain(REPO_YES_INSTRUCTION)
    expect(p).toContain("said Yes")
    expect(p).toMatch(/money, client_wording or irreversible/)
    expect(p).toMatch(/confidence/i)
    expect(p).not.toContain('Set "consent": true')
  })
})
