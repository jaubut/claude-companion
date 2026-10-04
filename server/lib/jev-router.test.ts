import { describe, expect, test } from "bun:test"
import type { JevOutcome } from "./jev"
import { DEFAULT_MIN_CONF, INTENTS, type RouteDecision, minConfidence, pickRoute, routerMode, routerQuestions, routerState, toDecision } from "./jev-router"
import { buildCatalog } from "./project-catalog"

const NOTES = [
  { noteId: "projects/2026-03-26-chantal-masse-website", ref: "PRJ-UC3L", title: "Chantal Massé — Website", status: "done" },
  { noteId: "projects/2026-01-01-tls-dashboard", ref: "PRJ-WCLS", title: "TLS Dashboard", status: "active" },
]
const SOURCE = "{ match: /chantal-masse-website/i, path: `${HOME}/chantalmasse-website` },"
const cat = buildCatalog(NOTES, SOURCE, { home: "/h", isDir: (p) => p === "/h/chantalmasse-website" })
const input = (text: string) => ({ text, channelName: "General", channelProject: null, recent: [] })

function jev(intent: string, iconf: number, project: string, pconf: number): JevOutcome {
  return {
    ok: true, model: "jev", latencyMs: 180,
    answers: {
      intent: { type: "choice", choice: intent, probabilities: {}, confidence: iconf },
      project: { type: "choice", choice: project, probabilities: {}, confidence: pconf },
    },
  }
}

describe("env", () => {
  test("mode defaults to shadow; min confidence defaults to 0.7", () => {
    expect(routerMode({})).toBe("shadow")
    expect(routerMode({ COMPANION_JEV_ROUTER: "LIVE" })).toBe("live")
    expect(routerMode({ COMPANION_JEV_ROUTER: "off" })).toBe("off")
    expect(routerMode({ COMPANION_JEV_ROUTER: "yes" })).toBe("shadow")
    expect(minConfidence({})).toBe(DEFAULT_MIN_CONF)
    expect(minConfidence({ COMPANION_JEV_MIN_CONF: "0.55" })).toBe(0.55)
    expect(minConfidence({ COMPANION_JEV_MIN_CONF: "7" })).toBe(DEFAULT_MIN_CONF)
  })
})

describe("questions", () => {
  test("one call: intent over the 5 intents + project over the catalog and none", () => {
    const q = routerQuestions(cat)
    expect(Object.keys(q)).toEqual(["intent", "project"])
    expect(q.intent!.type === "choice" && Object.keys(q.intent!.criteria)).toEqual([...INTENTS])
    expect(q.project!.type === "choice" && Object.keys(q.project!.criteria)).toEqual(["tls-dashboard", "chantal-masse-website", "none"])
    const s = routerState({ text: "hi", channelName: "Dash", channelProject: "TLS Dashboard", recent: [{ role: "user", text: "a\nb" }] })
    expect(s).toEqual({ latest_message: "hi", channel: "Dash", channel_project: "TLS Dashboard", previous_messages: ["user: a b"] })
  })
})

describe("toDecision", () => {
  const opts = { minConf: 0.7, channelNoteId: null }
  test("confident Jev project wins", () => {
    const d = toDecision(jev("quick_look", 0.9, "chantal-masse-website", 0.88), input("nuxt version?"), cat, opts)
    expect(d.ok && d.decision).toMatchObject({ intent: "quick_look", intentConf: 0.9, projectSource: "jev", projectConf: 0.88, jevMs: 180 })
    expect(d.ok && d.decision.project?.repo).toBe("/h/chantalmasse-website")
  })

  test("low-confidence Jev project → code alias match (inactive project included)", () => {
    const d = toDecision(jev("quick_look", 0.9, "tls-dashboard", 0.4), input("is chantalmasse.com on the latest nuxt?"), cat, opts)
    expect(d.ok && [d.decision.project?.noteId, d.decision.projectSource]).toEqual([NOTES[0]!.noteId, "alias"])
  })

  test("none + no alias → the channel's note, else nothing", () => {
    const none = jev("status", 0.95, "none", 0.9)
    const ch = toDecision(none, input("what's running?"), cat, { minConf: 0.7, channelNoteId: NOTES[1]!.noteId })
    expect(ch.ok && [ch.decision.project?.noteId, ch.decision.projectSource]).toEqual([NOTES[1]!.noteId, "channel"])
    const no = toDecision(none, input("what's running?"), cat, opts)
    expect(no.ok && [no.decision.project, no.decision.projectSource]).toEqual([null, "none"])
  })

  test("Jev errors and unknown intents fail over", () => {
    expect(toDecision({ ok: false, error: "timeout", latencyMs: 2000 }, input("x"), cat, opts)).toEqual({ ok: false, error: "timeout", jevMs: 2000 })
    expect(toDecision(jev("dance", 0.9, "none", 0.9), input("x"), cat, opts)).toMatchObject({ ok: false, error: "no_intent" })
  })
})

describe("pickRoute", () => {
  const base: RouteDecision = { intent: "chat", intentConf: 0.9, project: null, projectConf: 0, projectSource: "none", jevMs: 1 }
  const site = cat.candidates.find((c) => c.key === "chantal-masse-website")!
  const dash = cat.candidates.find((c) => c.key === "tls-dashboard")!
  test("each intent at or above the threshold", () => {
    expect(pickRoute({ ...base, intent: "status" }, 0.7)).toBe("status")
    expect(pickRoute({ ...base, intent: "task" }, 0.7)).toBe("task")
    expect(pickRoute({ ...base, intent: "body" }, 0.7)).toBe("body")
    expect(pickRoute({ ...base, intent: "chat" }, 0.7)).toBe("brain")
    expect(pickRoute({ ...base, intent: "quick_look", project: site, projectSource: "alias", projectConf: 1 }, 0.7)).toBe("quick_look")
  })

  test("below the threshold, or a quick look with nothing to read → old brain", () => {
    expect(pickRoute({ ...base, intent: "status", intentConf: 0.69 }, 0.7)).toBe("brain")
    expect(pickRoute({ ...base, intent: "quick_look", project: dash, projectSource: "jev", projectConf: 0.9 }, 0.7)).toBe("brain") // no local repo
    expect(pickRoute({ ...base, intent: "quick_look", project: site, projectSource: "jev", projectConf: 0.5 }, 0.7)).toBe("brain")
    expect(pickRoute({ ...base, intent: "quick_look" }, 0.7)).toBe("brain")
  })
})
