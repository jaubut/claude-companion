import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MergeGateFn } from "./merge-gate"

// Test-only. CI has no ~/.claude/tools, so the gate's four modules are written to a temp dir and the real loader
// imports them. merge-gate-callers.test.ts runs the same matrix on the real files on any host that has them, so a
// stub that drifts from claude-config fails there.

/** For tests about something else: a gate that passes at `head` and never calls gh. */
export const passGate = (head: string): MergeGateFn => async () => ({ ok: true, head })

const GATE = `
export const HUMAN_MERGE_RE = /^(rules|agents|hooks|skills|commands|workflows|mods|output-styles|memory)\\/|(^|\\/)CLAUDE\\.md$/;
const PROD_SCHEMA_RE = /migration|schema\\.sql/i;
export function gateVerdict(g) {
  if (g.holdLabels?.length) return { stop: "hold-label", action: "wait", reason: \`held by label \${g.holdLabels.join(", ")}\` };
  if (g.taint?.truncated) return { stop: "tainted-sensitive", action: "park", reason: \`tainted (\${g.taint.origin}) PR: file list may be truncated — human merge\` };
  if (g.taint?.sensitive.length) return { stop: "tainted-sensitive", action: "park", reason: \`tainted (\${g.taint.origin}) PR touches \${g.taint.sensitive.join(", ")} — human merge only\` };
  if (g.approved) return null;
  const schema = g.paths.filter((p) => PROD_SCHEMA_RE.test(p) && !p.endsWith(".md"));
  if (schema.length) return { stop: "prod-schema", action: "park", reason: \`touches \${schema.join(", ")} (prod schema) — human merge only\` };
  const human = g.paths.filter((p) => HUMAN_MERGE_RE.test(p));
  if (human.length) return { stop: "human-merge-path", action: "park", reason: \`touches \${human.join(", ")} — human merge only\` };
  return null;
}
export const parseGatePaths = (tsv) => tsv.split("\\n").flatMap((l) => l.split("\\t")).filter(Boolean);
export function liveGateInput(g, paths, holdLabels, sensitive) {
  const taint = g.taint && { ...g.taint, sensitive: [...new Set([...g.taint.sensitive, ...paths.filter((p) => sensitive.test(p))])] };
  return { ...g, paths, pathsIncomplete: false, holdLabels, taint };
}
`

const LANE = `export const SENSITIVE_RE = /auth|token|secret|migration|schema\\.sql|^(rules|agents|hooks|skills|commands|workflows|mods|output-styles|memory)\\/|(^|\\/)CLAUDE\\.md$/i;\n`

const POLICY = `
import { normalizeOrigin } from "./client-origin.ts";
export const policy = (origin, sink) => (["jeremie", "system"].includes(normalizeOrigin(origin)) ? "EXISTING" : sink === "merge-sensitive" ? "DENY" : "HEURISTICS_OR_STAMP");
const ORDER = ["unknown", "web", "error", "internal-user", "client", "system", "jeremie"];
export const leastTrusted = (origins) => ORDER.find((o) => origins.map(normalizeOrigin).includes(o)) ?? "unknown";
export function taintedSensitive(filePaths, diff, re) {
  if (diff === null) return { sensitive: ["(diff unavailable)"], truncated: true };
  const headers = diff.split("\\n").filter((l) => l.startsWith("diff --git ")).length;
  return { sensitive: filePaths.filter((p) => re.test(p)), truncated: filePaths.length >= 100 || headers !== filePaths.length };
}
`

const ORIGIN = `
const ORIGINS = ["jeremie", "system", "internal-user", "client", "web", "error", "unknown"];
export const normalizeOrigin = (o) => (ORIGINS.includes(o ?? "") ? o : "unknown");
export const isTainted = (o) => !["jeremie", "system"].includes(normalizeOrigin(o));
`

export type ToolFile = "pr-gate.ts" | "dep-lane.ts" | "pr-shepherd-policy.ts" | "client-origin.ts"
export const STUB_GATE = GATE

/** A fresh tools dir holding the four stub modules; `over` replaces a file's text. */
export function writeStubTools(over: Partial<Record<ToolFile, string>> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-merge-gate-")), "tools")
  mkdirSync(dir)
  const files: Record<ToolFile, string> = { "pr-gate.ts": GATE, "dep-lane.ts": LANE, "pr-shepherd-policy.ts": POLICY, "client-origin.ts": ORIGIN, ...over }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
