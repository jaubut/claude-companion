import { describe, expect, test } from "bun:test"
import { MAX_CANDIDATES, NONE_KEY, buildCatalog, catalogLines, jevCriteria, matchAlias, normalize, noteSlug, regexAliases } from "./project-catalog"

const SOURCE = `
const REPO_MAP: Array<{ match: RegExp; path: string }> = [
  { match: /dashboard|PRJ-WCLS|tls-dashboard/i, path: \`\${HOME}/tls-dashboard-v2\` },
  { match: /chantal-masse-website|chantalmasse-website/i, path: \`\${HOME}/lanes/chantalmasse-website\` },
  { match: /chantal-masse-website|chantalmasse-website/i, path: \`\${HOME}/chantalmasse-website\` },
  { match: /kb-v1|agent knowledge base/i, path: \`\${HOME}/kb-v1\` },
  { match: /tls-video-assist/i, path: \`\${HOME}/apps/TLS VIDEO ASSIST\` },
];
`

const NOTES = [
  { noteId: "projects/2026-03-26-chantal-masse-website", ref: "PRJ-UC3L", title: "Chantal Massé — Website", status: "done" },
  { noteId: "projects/2026-04-05-chantal-masse-seo-audit", ref: "PRJ-LBW8", title: "SEO Audit — Chantal Massé", status: "active" },
  { noteId: "projects/2026-01-01-tls-dashboard", ref: "PRJ-WCLS", title: "TLS Dashboard", status: "active" },
  { noteId: "projects/2026-02-02-tls-video-assist", ref: null, title: "TLS Video Assist", status: "archived" },
]

const HOME = "/h"
const EXISTS = new Set(["/h/chantalmasse-website", "/h/tls-dashboard-v2", "/h/kb-v1"])
const cat = () => buildCatalog(NOTES, SOURCE, { home: HOME, isDir: (p) => EXISTS.has(p) })

describe("helpers", () => {
  test("normalize / slug / regex aliases", () => {
    expect(normalize("Chantal Massé — Website")).toBe("chantalmassewebsite")
    expect(noteSlug("projects/2026-03-26-chantal-masse-website")).toBe("chantal-masse-website")
    expect(regexAliases(/review\.cherrypik|tls-review|a(b)c/)).toEqual(["review.cherrypik", "tls-review"])
  })
})

describe("buildCatalog", () => {
  test("every note, any status, with its local repo (first existing checkout)", () => {
    const c = cat()
    const site = c.candidates.find((x) => x.noteId === NOTES[0]!.noteId)!
    expect(site.status).toBe("done")
    expect(site.repo).toBe("/h/chantalmasse-website") // lanes/ checkout missing here
    expect(site.repoKnown).toBe(true)
    expect(site.aliases).toContain("chantal-masse") // slug minus the generic "website"
    expect(site.aliases).toContain("PRJ-UC3L")
    // a mapped repo that only exists on the other host
    const tva = c.candidates.find((x) => x.noteId?.endsWith("tls-video-assist"))!
    expect([tva.repo, tva.repoKnown, tva.status]).toEqual([null, true, "archived"])
    // active notes come first
    expect(c.candidates[0]!.status).toBe("active")
  })

  test("a REPO_MAP entry no note matches becomes its own candidate", () => {
    const kb = cat().candidates.find((x) => x.kind === "repo")!
    expect(kb).toMatchObject({ key: "repo-kb-v1", repo: "/h/kb-v1", noteId: null })
    expect(kb.aliases).toEqual(["kb-v1", "agent knowledge base"])
  })

  test("keys are unique; no source → notes only", () => {
    const dup = buildCatalog([...NOTES, { ...NOTES[2]!, noteId: "projects/2026-05-05-tls-dashboard" }], null)
    const keys = dup.candidates.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain("tls-dashboard-2")
    expect(dup.candidates.every((c) => c.kind === "note" && !c.repo)).toBe(true)
  })

  test("capped to fit a Jev Choice (≤ 255 options with none)", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ noteId: `projects/p${i}`, ref: null, title: `P ${i}`, status: "active" }))
    const c = buildCatalog(many, null)
    expect(c.candidates.length).toBe(MAX_CANDIDATES)
    expect(Object.keys(jevCriteria(c)).length).toBeLessThanOrEqual(255)
  })
})

describe("resolution", () => {
  test("domain alias resolves to the (inactive) website note, not the SEO audit", () => {
    expect(matchAlias("is chantalmasse.com on the latest nuxt?", cat())?.noteId).toBe(NOTES[0]!.noteId)
    expect(matchAlias("check the Chantal Massé website", cat())?.noteId).toBe(NOTES[0]!.noteId)
  })

  test("ref codes, regex aliases, repo-only entries, nothing", () => {
    expect(matchAlias("status of PRJ-WCLS?", cat())?.noteId).toBe(NOTES[2]!.noteId)
    expect(matchAlias("anything new in the dashboard", cat())?.noteId).toBe(NOTES[2]!.noteId)
    expect(matchAlias("is kb-v1 healthy", cat())).toBeNull() // "kb-v1" → "kbv1" is under 6 chars
    expect(matchAlias("the agent knowledge base version?", cat())?.key).toBe("repo-kb-v1")
    expect(matchAlias("hello there", cat())).toBeNull()
  })

  test("criteria + prompt lines carry status and repo", () => {
    const crit = jevCriteria(cat())
    expect(crit[NONE_KEY]).toContain("no specific project")
    expect(crit["chantal-masse-website"]).toContain("[done]")
    expect(crit["chantal-masse-website"]).toContain("Code repo: chantalmasse-website")
    const lines = catalogLines(cat())
    expect(lines.find((l) => l.includes("chantal-masse-website"))).toBe(
      "  - projects/2026-03-26-chantal-masse-website (PRJ-UC3L): Chantal Massé — Website [done] → repo /h/chantalmasse-website",
    )
    expect(lines).toContain("  - repo kb-v1: /h/kb-v1")
    expect(lines.find((l) => l.includes("tls-video-assist"))).toContain("repo on the other host")
  })
})
