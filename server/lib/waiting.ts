// Waiting precedence algebra (PRJ-OR1T Phase 11). Pure, zero imports.
//
// Kubernetes' `status.conditions[]` is the reference: a resource carries a LIST
// of conditions, one owner per type, each with its own transition time; the
// single-value summary a client renders is derived on read, never stored as the
// source of truth. Here a session carries a list of WaitingReasons — one owner
// per kind (Stop hook → turn-end, pty-manager → approval, questions → question,
// the dialog watcher → dialog) — and `resolveWaiting` is that derivation.

export type WaitingKind = "turn-end" | "approval" | "question" | "dialog"

export interface WaitingReason {
  kind: WaitingKind
  // When THIS reason started blocking. Re-asserting the same (kind, ref) does
  // not move it: the badge's age is a property of the block, not of when we
  // last noticed it.
  since: number
  // What is blocking: the approval/question id, the dialog's session key, "" for
  // turn-end. Reasons are keyed by (kind, ref) so clearing is exact.
  ref: string
}

// Highest precedence first. `dialog` outranks everything because it is modal in
// the terminal — nothing else can be driven while it is up. `approval` outranks
// `question` because an approval that expires resolves "allow" while a question
// that expires denies: the wrong-way-on-timeout one is the urgent one.
export const WAITING_PRECEDENCE: WaitingKind[] = ["dialog", "approval", "question", "turn-end"]

// The projection every client reads: the highest-precedence kind present and,
// within that kind, the OLDEST reason — the one blocking longest and the one
// whose 290 s expiry fires first.
export function resolveWaiting(reasons: WaitingReason[]): WaitingReason | null {
  for (const kind of WAITING_PRECEDENCE) {
    let best: WaitingReason | null = null
    for (const r of reasons) {
      if (r.kind !== kind) continue
      if (!best || r.since < best.since) best = r
    }
    if (best) return best
  }
  return null
}

// Re-asserting an existing (kind, ref) keeps its `since`; a new ref on the same
// kind is a new reason with a fresh stamp.
export function upsertReason(
  list: WaitingReason[],
  kind: WaitingKind,
  ref: string,
  now: number,
): WaitingReason[] {
  if (list.some((r) => r.kind === kind && r.ref === ref)) return list
  return list.concat({ kind, since: now, ref })
}

// Omit `kind` to drop every reason; omit `ref` to drop every reason of that
// kind. With both, exactly one reason goes.
export function removeReason(
  list: WaitingReason[],
  kind?: WaitingKind,
  ref?: string,
): WaitingReason[] {
  if (kind === undefined) return []
  return list.filter((r) => !(r.kind === kind && (ref === undefined || r.ref === ref)))
}
