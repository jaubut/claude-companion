# Brain triage — API contract (v1, 2026-10-04)

Goal (Jeremie): "the queue should be triaged first, then phrased as a simple
problem / action / options for me to choose."

Owner: Companion server (Zettlab owns the orchestrator). Bearer-gated like every
/api/orchestrator/* route. All additions are additive; older iOS builds ignore them.

## Item

```ts
type TriageItem = {
  id: string                 // stable: `${source}:${refId}` — same item keeps its id across refreshes
  source: "task" | "proposal" | "pr" | "body" | "mytask" | "outbound"   // outbound added 2026-10-25
  refId: string              // dispatch task id / proposal taskId / "<repo>#<pr>" / component id / task id or "p:<noteId>" (mytask) / outbound id
  title: string              // ≤ 80 chars, plain words
  project: string | null     // project title or repo name (human label)
  repo: string | null        // added 2026-10-15: GitHub repo name the work lands in — see "Repo" below
  severity: "urgent" | "normal" | "low"
  problem: string            // 1–2 short sentences, plain French-or-English as Jeremie writes; no jargon, no ids
  action: string             // 1 sentence: what the brain recommends doing
  recommended: string        // option id
  options: TriageOption[]    // 2–4, recommended first
  context?: string           // optional: 1–3 lines of evidence (blocker text, CI failure, investigation root cause);
                             // on an Opus card: Opus's analysis, up to 1500 chars, line breaks kept
  resolver?: ResolverInfo    // added 2026-10-04 (Opus resolver) — see "Opus resolver" below
  payload?: OutboundPayload  // added 2026-10-25, source outbound only: the exact email — see "Source outbound"
  version?: string           // added 2026-10-25, source outbound only: = payload.payloadHash; echo it in choose
  createdAt: number          // ms
  updatedAt: number          // ms
}

type TriageOption = {
  id: string                 // "a" | "b" | "c" | "d"
  label: string              // ≤ 32 chars, verb-first ("Use per-line rounding")
  detail?: string            // ≤ 90 chars
  action: TriageAction
  destructive?: boolean      // red styling + confirm
}

type TriageAction =
  | { kind: "answer"; text: string }            // unblock task with this answer
  | { kind: "answer_custom" }                   // phone shows a text field → POST with text
  | { kind: "requeue" }
  | { kind: "cancel" }
  | { kind: "approve" }   // proposal: files one pending row (dashboard stamp queues it)
  | { kind: "reject" }                          // proposal
  | { kind: "merge" }                           // PR (sensitive PRs only reach Jeremie this way)
  | { kind: "close_pr" }
  | { kind: "open_url"; url: string }
  | { kind: "snooze"; hours: number }           // hide from triage until then
  | { kind: "ask_opus"; instruction?: string }  // hand the item back to Opus (2026-10-04) → POST with optional text = instruction
```

## Endpoints

- `GET /api/orchestrator/triage` → `{ items: TriageItem[], resolving: ResolvingItem[], repos: RepoCard[], generatedAt: number }`
  (`resolving` added 2026-10-04 — see "Opus resolver"; `repos` added 2026-10-15 — see "Repo cards")
  Ordered: urgent first, then oldest. Only things that genuinely need Jeremie.
- `POST /api/orchestrator/triage/<id>/choose` body `{ optionId: string, text?: string }`,
  header `Idempotency-Key`. Performs the mapped action through the EXISTING guarded
  functions (unblock/requeue/cancel/approve/reject; merge/close via `gh`).
  → `{ ok: true, id, result: "done" | "replay", next?: TriageItem | null }`
  (`202 { ok: true, id, result: "queued", next, detail }` added 2026-10-05 — see "Merge intent")
  Errors: 404 no such item · 409 stale (underlying state moved; item refreshed) ·
  422 `text_required` (answer_custom without text) · 503 turso/gh unreachable.
- WS frame `{ type: "orchestrator_triage", items: TriageItem[], resolving: ResolvingItem[], generatedAt }` on any change.

## Sources
- `task`: dispatch tasks in `blocked` (and `failed` with a retryable cause).
- `proposal`: pending proposals in every channel (incl. Body fix cards — keep their
  host routing, approve goes through the existing approve path).
- `pr`: PRs the PR shepherd parked as "needs Jeremie" (sensitive paths, repeated
  CI failure it couldn't fix, merge conflict it couldn't resolve). Read from the
  shepherd's Turso marker (see claude-config PR-shepherd contract: tasks with
  `dispatch_status='pr'` and an `agent_activity` row `pr:needs-human` + reason).
- `body`: investigations that failed twice (no proposal) — options: requeue investigation / open component / snooze.
- trips: auto-filed, approved per quarter on the dashboard (no triage source since 2026-10-15, trips-auto-quarterly).
- `mytask` (added 2026-10-06, PRJ-CT4M WP3): Jeremie's own overdue tasks — see "Source mytask" below.
- `outbound` (added 2026-10-25): an email an agent wants to send, shown with its exact payload — see "Source outbound" below.

## Repo (added 2026-10-15, needs-you-by-repo)

Every `items[]` and `resolving[]` entry (GET, `orchestrator_triage` frame, choose `next`)
carries `repo: string | null`: the GitHub repo NAME (no owner, every repo is `jaubut/…`)
the work lands in, so the phone can group Needs you by repo. `project` stays the human label.

- `task` / `proposal`: claude-config `repo-map.ts`, dispatch-run's routing order minus
  `repo_path` (`lib/live-repo.ts repoNameFor`): (1) `[autodev:deps:<name>:…]`, then a
  `[repo:<name>]` prefix on the task text / proposal prompt (an unknown name falls through);
  (2) proposal only: `cwd` equal to an entry's path; (3) `"<noteId> <noteTitle>"` → the first
  entry whose `match` hits (any host); (4) the task text names exactly one map name,
  token-bounded (two or more → null). Output: the entry's `github` basename
  (`jaubut/TLSTUDIO` → `TLSTUDIO`), else its map `name`; no entry → null.
- `pr` cards and approved-merge rows: the repo from the PR URL (`pr:jaubut/claude-companion-ios#12` → `claude-companion-ios`).
- `body`, `mytask`: null.
- The repo-map is read once per collect; unreadable → task/proposal `repo: null`, no card dropped, no error.
- **`repo` never moves `version`** and is not in the phrase prompt or the phrase cache key:
  a card whose repo changes (null → name, a repo-map edit) keeps its id and version, its
  cached phrasing, and a choose against it is 200, not 409. The frame dedupe key does include
  `repo`, so a flip costs exactly one extra frame.

## Repo cards (added 2026-10-15, needs-you-repo-yes-no)

Jeremie: "the needs you should be just an overview of the repo and a yes or no from my hand". GET, the
`orchestrator_triage` frame and the choose `next` stay as they were (`items[]` / `resolving[]` byte-identical,
builds ≤ 52 ignore the new key); GET and the frame gain `repos: RepoCard[]`, derived on every render from the
same snapshot as `items` (never stored). The frame is sent when a card changes, even when `items` did not.

```ts
type RepoCard = {
  id: string                 // "repo:<key>"; key = the repo name, or "_other" (task / proposal / PR items with repo null)
  repo: string | null        // null for "_other"
  name: string               // the repo name, or "Other work"
  version: string            // hash of the members' id@version + held ids + the latest run's id/status (values, never counts)
  overview: string[]         // ≤ 6 plain lines: "Start: …", "Opus answers: …", "Back to the shepherd: …", "Stays with you: …", "Opus is on N more", "+N more"
  counts: { members: number; held: number; resolving: number; proposals: number; tasks: number; prs: number }
  members: { id: string; version: string; does: "approve" | "ask_opus" | "hand_back" }[]   // what a Yes acts on
  held: string[]             // item ids a Yes never touches: they stay individual cards in items[]
  run?: RepoRunView          // the repo's latest Yes / No run
  createdAt: number; updatedAt: number
}
type RepoRunView = {
  id: number; decision: "yes" | "no"; status: "running" | "done" | "failed" | "interrupted"
  note: string | null        // No only
  summary: string | null     // "2 started · 1 with Opus · 1 failed (live cap) · 1 skipped (changed)" / "Opus re-planned after your No: rejected 2, rescoped 1, kept 1. …"
  results: { id: string; result: "done" | "with_opus" | "handed_back" | "kept" | "failed" | "skipped"; reason?: string }[]
  createdAt: number; finishedAt: number | null
}
```

- Members are task, proposal and PR items; `body` and `mytask` items are never on a repo card (keep their own cards).
- **What Yes does** (decided by the server, `lib/triage-repos.ts memberDoes`, never by the client):
  proposal → approve (default mode; a Mac fix keeps its host) · blocked / failed task → the Opus resolver at
  autonomy `delegated` · parked PR → a human `pr:unpark` row (`target_kind 'task'`, meta `{url: <the park row's
  url>, by: "manual", via: "companion-repo-yes", reason}`): the PR shepherd takes it back with its fix budget reset
  and EVERY gate (CI, review, sensitive paths) — never `pr:approved-merge`, never a merge from the Companion ·
  PR parked "superseded…" / "task already…" → the resolver, `delegated` (it may close it when sure).
- **Held** (never a member): PRs parked `touches …` / `sensitive path …` (with or without `dep lane: `), anything
  "needs your review", `client…` parks, `stale (no activity…)`, `dep auto-merge off…` (the shepherd re-parks those
  at once), and the 48 h safety net (never parked, never reviewed). Items in `resolving[]` (Opus's runs, approved
  merges) are counted, never members.
- **`delegated`** (resolver policy): an answer acts unless `why` is money / client_wording / irreversible or the
  confidence is below 0.5; requeue / route act; fix → back to the shepherd on a non-sensitive PR, else a card;
  close_pr as normal (sure + stale / superseded / task done + not sensitive); cancel / merge / approve / revise /
  reject → a card. Every answer still posts the 🤖 turn in the task's channel.

**Endpoints** (bearer-gated; `<repo>` = the card key, percent-encoded; header `Idempotency-Key`):

- `POST /api/orchestrator/repos/<repo>/yes` `{ version, members: [{id, version}] }` (1–100 members: the card's
  `members` as the phone showed them). The server acts on the members whose version still matches, in card order;
  others → `skipped` `changed` (version moved) · `held` · `gone`. Items that arrived after the snapshot are untouched
  (they wait for the next card). → `202 { ok, repo, runId, result: "running", skipped[] }`.
- `POST /api/orchestrator/repos/<repo>/no` `{ version, note }` (note 1–2000 chars) → ONE Opus call re-plans the repo
  from the note: per item keep · reject / revise (proposals) · answer (blocked tasks) · ask_opus (anything: the
  resolver, elevated, with Opus's instruction) · cancel / close_pr only when the note consents (the `ask_opus` rule:
  short go words like "vas-y" alone, a longer order only when Opus also reads it as consent); never on held PRs. → `202` as above; the card comes back with a new
  `version` and `run.summary` saying what Opus changed.
- Errors: `409 stale` + `next: RepoCard` (Yes: no posted member still matches; No: the card's version moved) ·
  `409 repo_busy` + `run` (one run per repo at a time) · `409 resolver_disabled` (No on a host without Opus, before
  any row) · `422 note_required` · `400` bad JSON / members / note too long · `404 no_such_repo` · `503
  turso_unreachable` (no row written).
- **Idempotency (pattern B):** each run is one `triage_repo_runs` row, UNIQUE (repo, Idempotency-Key). The same key
  again → `200 { ok, repo, runId, result: "replay", run }` + `Idempotent-Replayed: true`, whatever the run's status
  (an interrupted one included); no second run. A server restart closes a `running` row as `interrupted`.
- The run lands on the card (`run`, a new `version`) and as one orchestrator turn in #General
  ("✅ Your Yes on <repo>: …" / "🤖 Opus re-planned after your No: …"). Failed items stay members of the next card.
- Fixture (a real frame with `repos[]` and a finished run, shared with the iOS decode test):
  `docs/fixtures/orchestrator-triage-repos.json` (regenerate: `UPDATE_FIXTURES=1 bun test routes/triage.test.ts`).

## Repo view (added 2026-10-25, repo-view)

Jeremie: "the tag should be the repo and it should open a repo view with the pr status and a get an agent on it to
resolve blocked pr etc because individual pr is too confusing for me". The repo chip on a Needs you card (the
item's `repo`) opens one summary of the repo; the PR-by-PR cards stay as they are. Bearer-gated like every
`/api/orchestrator/*` route; `<repo>` = the GitHub repo name (`repo` on items / repo cards), percent-encoded, any case.
Known repos only: a claude-config `repo-map.ts` entry with a `github` slug (`_other`, a map entry without `github`,
anything else → `404 no_such_repo`; gh never sees a name that is not a map slug, and always as argv).

- `GET /api/orchestrator/repos/<repo>` →
  ```ts
  {
    ok: true, repo: string, github: string,          // "claude-companion-ios", "jaubut/claude-companion-ios"
    prs: { number: number; title: string; url: string; status: RepoPrStatus; label: string; reason: string; updatedAt: number }[],
    blocked: number,                                 // PRs whose status is checks_failing | conflict | parked
    needsYou: number,                                // items[] whose repo is this repo (any case)
    agent: { taskId: string; status: string } | null, // the open "Resolve blocked PRs" task (status = dispatch_status)
    generatedAt: number
  }
  type RepoPrStatus = "ready" | "checks_failing" | "conflict" | "parked" | "review" | "checks_running" | "behind" | "draft"
  ```
  `prs` = every open PR (`gh pr list --repo <slug> --state open --limit 50`, cached 60 s per repo), blocked first,
  then newest. `label` is the plain words ("Ready to merge", "Checks failing", "Merge conflict", "Parked by shepherd",
  "Waiting on review", "Checks running", "Behind main", "Draft"); `reason` one short line (the shepherd's park reason
  without its ` · Opus:` brief when it parked the PR). One status per PR, first hit wins: draft → conflict
  (`CONFLICTING` / `DIRTY`) → failing checks → parked (the shepherd's live `pr:needs-human`, `lib/triage-sources.ts
  prSources`) → checks pending / GitHub still computing (`UNKNOWN`) → review (`CHANGES_REQUESTED`, `REVIEW_REQUIRED`,
  merge state `BLOCKED`) → `BEHIND` → ready. Turso down → no parks (the view still renders); gh down with nothing
  cached → `503 gh_unreachable`.
- `POST /api/orchestrator/repos/<repo>/agent` (no body) — "Get an agent on it". Jeremie's tap is the approval: ONE
  builder task through `fileProposal(…, { byHand: true, runner: "herdr" })` (as `POST /api/body/component/:id/agent`):
  origin `jeremie` → `queued`, `dispatch-runner: herdr` in the description, a proposal in #General marked filed.
  Title `[repo:<repo>] Resolve blocked PRs in <repo>` (dispatch-run routes on the marker); the description lists each
  blocked PR (number, title, label, reason, URL), read fresh from GitHub at the tap. Note = the map entry's `project`
  (note id or ref_code). One `agent_activity` row `repo:agent` (target_kind `repo`, target_id the slug).
  → `200 { ok, repo, result: "filed", agent: { taskId, status: "queued" } }` (`status: "pending"` + `approveUrl` on a
  Turso without the origin column).
  **Idempotent:** a task with that exact title, `done = 0` and `dispatch_status` pending / queued / running / blocked /
  pr → `200 { ok, repo, result: "existing", agent }`, nothing filed. A completed / failed / cancelled one does not
  count: the next tap files a new task. Errors: `404 no_such_repo` · `409 nothing_blocked` · `409 already_filing` (a
  tap in flight) · `422 no_project` (the map's project note is not in Turso) · `503 turso_unreachable` / `gh_unreachable`.

## Phrasing
Generated by the brain (lean `claude -p`, sonnet), one call per new/changed item,
cached by (source, refId, underlying updated_at). Jev may pre-classify severity.
Fallback when the model is unavailable: deterministic template (problem = blocker
text, options = answer_custom / requeue / cancel).

## Server implementation notes (v1, 2026-10-04 — additive, nothing above changes)

- **Id in the path is percent-encoded** (`encodeURIComponent`): a PR id is
  `pr:<owner>/<repo>#<n>` and carries `/` and `#`. Example:
  `POST /api/orchestrator/triage/pr%3Ajaubut%2Ftls-review%234/choose`.
- **Responses.** Success: `{ ok: true, id, result: "done" | "replay", next, detail? }` —
  `next` is the next item to show (first remaining item, or null); `detail` is
  optional per action (e.g. `{dispatchStatus}`, approve's `{dispatchTaskId, status, mode, host?}`,
  merge's `{state:"MERGED"}`). A replay also sets the header `Idempotent-Replayed: true`.
  Errors are `{ ok: false, error, id, ... }`:
  `400` `optionId required` · `unknown_option` · `text_too_long` (> 4000) · `idempotency-key-too-long`;
  `404` `no_such_item`; `409` `stale` with `next: TriageItem | null` (the refreshed item, null when it is gone),
  or `investigation_<status>` for a Body requeue the investigator refused (with `reason`);
  `422` `text_required`; `502` `merge_unverified` / `close_unverified` (gh ran but GitHub
  does not read MERGED / CLOSED; nothing recorded) or an approve error passed through
  (e.g. `host_refused`); `503` `turso_unreachable` · `gh_unreachable` · `host_unreachable` (Mac fix card).
  Only a success is remembered under an Idempotency-Key (7 days); a refusal retries for real.
- **`open_url` / `snooze` on the server.** `open_url` is a no-op `done` (the phone opens the
  link itself). `snooze` hides the item until `now + hours` (stored in companion.db), no
  other effect. A Body component's link is `companion://body/<componentId, percent-encoded>`
  (new iOS deep link); a PR's link is the PR URL.
- **Allowed actions per source** (validated server-side; anything else → fallback):
  task `blocked` = answer · answer_custom · requeue · cancel · snooze;
  task `failed` = requeue · cancel · snooze; proposal = approve · reject · snooze;
  pr = merge · close_pr · open_url · snooze; body = requeue · open_url · snooze.
  `cancel`, `close_pr` and `reject` always carry `destructive: true`. A blocked task always
  has an `answer_custom` option.
- **Fallback options** (model unavailable or invalid): blocked task = answer_custom ·
  requeue · cancel (problem = blocker text); failed task = requeue · cancel · snooze 24 h;
  proposal = approve · reject · snooze 24 h; pr = open_url · merge · close_pr;
  body = requeue · open_url · snooze 24 h. The first option is always the recommendation.
- **GET never waits for the model.** A new item is served with its fallback phrasing at
  once; the phrased version replaces it (same id) in the next `orchestrator_triage` frame.
  `GET ?fresh=1` recollects before answering.
- **Sources, precisely.** `task`: `done=0` and `blocked`, or `failed` whose blocker does not
  read as hopeless (unknown agent / not found / invalid / forbidden / refused).
  `pr`: `done=0`, `dispatch_status IN ('pr','completed')`, a GitHub PR URL (task
  `dispatch_pr_url` or the marker's `meta.url`); shown when the task's newest `pr:*`
  activity row is `pr:needs-human` (problem = `meta.reason`), or — safety net, severity
  `low` — when it has no `pr:*` row at all and its `updated_at` is older than 48 h. An
  `outcome:merged|rejected` row newer than the marker hides it.
  `body`: the component's latest investigation `failed`, ≥ 2 consecutive failures, no
  proposal, nothing open, and the component not healthy again.
- **merge / close_pr.** `gh pr view <url> --json state` must read `OPEN` first (else 409
  stale); merge then reads GitHub's readiness (see "Merge intent": not mergeable now → 202
  `queued`, no `gh pr merge`); `gh pr merge <url> --squash` / `gh pr close <url>`; then the state must read
  `MERGED` / `CLOSED`. Merge then sets the task `done=1` (guarded) and ledgers
  `outcome:merged "PR #n merged"`; close ledgers `outcome:rejected "PR #n closed unmerged"`
  (dispatch-reconcile's wording).
- **Body requeue** runs a forced investigation (`force: true` skips the failed-twice
  cooldown, never the budget); `POST /api/body/investigate` accepts `force: true` on the
  peer hop so a Mac component is forced on the Mac too.
- **Severity**: Jev (`choice` urgent/normal/low, used at confidence ≥ 0.7;
  `COMPANION_TRIAGE_JEV=0` off), else heuristics (Body critical/high → urgent; words like
  prod / down / client / invoice / payment / deadline / security → urgent; failed task and
  safety-net PR → low).

<a id="merge-intent"></a>
## Merge intent (2026-10-05 — additive)

Incident 2026-10-05 02:26: Jeremie tapped Merge on a sensitive PR whose card was prepared when it was
mergeable; meanwhile other merges made it CONFLICTING, `gh pr merge` failed (`502 merge_unverified`), the card
stayed and nothing was logged. Now **a Merge tap is Jeremie's approval to land THIS PR**:

- **choose `merge`.** After the `OPEN` check the server reads
  `gh pr view <url> --json mergeable,mergeStateStatus,headRefOid,statusCheckRollup`.
  `MERGEABLE` (or not reported) and checks green / none → merge now, exactly as before (`200 done`).
  Otherwise the reason is, first match wins: `conflict` (`CONFLICTING` / `DIRTY`) · `ci_failing` (a check
  failed) · `ci_pending` (a check is running) · `behind` (`BEHIND`). No `gh pr merge` runs; the approval is
  recorded in Turso and the answer is

  ```json
  202 { "ok": true, "id": "pr:…", "result": "queued", "next": TriageItem | null,
        "detail": { "state": "approved_pending", "reason": "conflict" | "behind" | "ci_pending" | "ci_failing",
                    "approvedHeadSha": "<sha>" } }
  ```

  A `gh pr merge` that GitHub refuses and that is followed by one of those reasons is also answered `202
  queued` (the approval recorded); any other refusal is still `502 merge_unverified`. Stored under the
  Idempotency-Key like a success (a replay answers `200 result: "replay"` with the same `detail`).
- **The approval row** (the PR shepherd honours it — claude-config `tools/pr-shepherd-approval.ts`):
  `agent_activity` `action = 'pr:approved-merge'`, `target_kind = 'task'`, `target_id` = the dispatch task id
  (an orphan PR: `target_kind = 'pr'`, `target_id` = the PR URL, as the shepherd's park rows), `meta =
  { repo, pr, url, approvedHeadSha, approvedAt (ISO), by: "jeremie", via: "triage" | "cli", reason?, host }`.
  The same row comes from `bun ~/.claude/tools/pr-shepherd.ts --approve <repo>#<n>`.
- **The card leaves `items`.** A PR whose newest `pr:approved-merge` is newer than its newest `pr:needs-human`
  and younger than 7 days is not a card; it is listed in `resolving[]` (the "Opus is on it" line) with
  `resolver.status: "queued"`, `resolver.model: "pr-shepherd"`, `title` = `"Approved — merging once the conflict
  clears · <PR title>"` (reason text: the conflict · the branch update · pending CI · the CI failure; GitHub
  green now → `"Approved — merging on the PR shepherd's next pass"`) and the additive field
  `approval: { state: "approved_pending", reason: … | null, approvedAt: ms, approvedHeadSha }` (reason re-read
  from GitHub, ≤ 2 min old). It disappears when the shepherd merges (`outcome:merged`). The card comes back
  when the shepherd parks the PR again (e.g. "changed after your approval: <files>") or the approval expires
  (problem prefixed "Your merge approval expired (7 days).").
- **Stale cards.** A PR card's mergeable state is re-read from GitHub when the item list is built (cached ≤ 2
  min; the item `version` does not move, so a choose is not `409 stale` because of it). CONFLICTING now → the
  title's "safe to merge" becomes "merge after the conflict fix" (else " — conflicting now" is appended), the
  problem starts "GitHub reports a merge conflict with the base branch now.", and the merge option reads
  **"Approve — merge after the conflict fix"** (it may exceed the 32-char label cap).
- **Logs.** Every choose writes one line, success or not:
  `[triage] choose <item id> option=<id> → <action kind> · <HTTP status> result=<done|queued|replay>|error=<code> [reason=<hold>]`.
- **iOS.** A 202 with `ok: true` is already a success (`OrchestratorActionPolicy.classify`: any 2xx without
  `ok: false` → `.done`): the card is removed and the next frame shows the row. Nice to have (separate PR): toast
  from `result == "queued"` + `detail.reason` ("Approved · merges once the conflict clears") instead of the
  merge's "Merge started", and show `approval` / `resolver.summary` on the row (today's row shows `title` +
  `project` only, which is why the title carries the line).

<a id="pr-review-cascade"></a>
## PR review cascade (2026-10-07 — shepherd-side; no triage code change)

The claude-config PR shepherd reviews each PR through a model cascade before deciding. What triage sees:

- **Park = ESCALATE only.** `pr:needs-human` is written only when the cascade's final verdict is `ESCALATE`;
  approve / fix verdicts never reach a card. Triage reads it exactly as before (problem = `meta.reason`).
- **Reason suffix.** An Opus-escalated park's `meta.reason` ends with `" · Opus: <brief>"` and its meta carries
  `cascade: { stage, verdict, model, confidence, brief }`. Triage keeps the full reason verbatim (suffix
  included) in the source's `facts.reason`; the card's `problem` is a display string built from it (the model may
  rephrase it, the fallback clips it to 280 chars), so a long reason can lose the suffix on the card.
  `meta.cascade` is not read.
- **`pr:cascade` rows** (one per cascade stage) are **url-targeted**: `target_kind = 'pr'`, `target_id` = the PR
  URL. Triage only reads `target_kind = 'task'` rows, so they never touch a card, its `version` or the 48 h safety
  net. They are the shepherd's audit log, not a triage input.
- **`pr:hold`** (task-targeted, `meta = { url, infra_task, reason, host }`): the PR waits on an infra task. It is
  a `pr:*` row, so it counts as shepherd activity — and any `pr:*` row, `pr:hold` included, permanently disables
  the 48 h safety net (it only fires when a PR has no `pr:*` row at all). A hold that outlives its infra task stays
  invisible to triage until the shepherd writes another row (`pr:needs-human` re-parks it), so the shepherd owns
  resolving stale holds.

## Queue hygiene (2026-10-14 — additive)

- **PR state from GitHub.** The readiness read (`gh pr view --json …,state`) also drops a PR card (and an approved
  row) GitHub reports MERGED or CLOSED, whatever the ledger says — the 48 h safety net included. A `done=1` task
  whose newest `pr:*` row is still `pr:needs-human` keeps its card while the PR is open.
- **Proposal dedupe.** One proposal card per target: a Body fix by component, else (project note or channel,
  normalized title). The newest wins; the older stay `proposed` and age out with the TTL.
- **TTL.** A `task` / `proposal` card with no activity (`updatedAt`) for 14 days is dismissed for that version, with
  an `agent_activity` row (`agent_slug` companion, `action` `triage:expired`, `target_kind` task|proposal) — no row
  written (Turso down) = not dismissed. A new version (any activity) brings it back. The day's dismissals join the
  resolver's 21:00 #General digest.


## Source `mytask` (Jeremie's overdue tasks, 2026-10-06 — additive)

Store host only. Open tasks with `assignee IN ('human:jeremie','human')` and a `due_date` before today
(America/Toronto), read through `lib/my-tasks.ts` (contract: docs/tasks-api.md). Deterministic card, no model call,
no Jev severity, never routed to Opus, no "Ask Opus…" option.

- **Item.** One per overdue task (`refId` = task id, `title` = its text), or one per project once ≥ 3 of its tasks
  are overdue (`refId` = `p:<note id>`, `title` = "N overdue tasks in <project>"). `context` lists up to 5 tasks.
  `version` = ids@due, so a date moved elsewhere makes a stale `choose` 409.
- **Options** (existing kinds the shipped iOS build shows): `approve` with `task: "next_week" | "done" | "undate"`
  ("Move to next week" = today + 7, "Done" / "Mark all done", "Drop the date") and `snooze` 24 h. Recommended:
  "Move to next week" when ≤ 14 days late, else "Drop the date". Severity `low` past 14 days, else `normal`
  (`urgent` on the urgent words).
- **choose** writes every task of the card through the assignee-guarded paths (one `status_changed` /
  `due_changed` activity row per task), then pushes `tasks_changed`. `409 stale` when none of its tasks moved.

## Source `outbound` (exact-payload approval before an email leaves, 2026-10-25 — additive)

The Duet rule: before anything leaves the house, show exactly what will leave and wait for an OK on that exact
thing. v1 is email only (no payments, no calendar). Deterministic card, no model call, no Jev severity, never
routed to Opus, no "Ask Opus…" option; only a tap from Jeremie (`by` "triage") can act on it.

**Producer** (bearer-gated, like every /api/* route):

```
POST /api/orchestrator/outbound
{ kind: "email", account: "personal" | "hello", to: string[], cc?: string[], subject: string, body: string,
  inReplyTo?: string, threadId?: string, why: string, requestedBy: string }
→ 201 { ok: true, id, payloadHash, status: "proposed" }
  400 malformed (bad address, multi-line subject, missing why/requestedBy…) · 422 { error: "refused", reason }
```

Stored in companion.db `outbound_actions` (status `proposed` → `sending` → `sent` | `rejected`; a send that fails
goes back to `proposed` with `last_error`, the card stays and says so).

**payloadHash** = sha256 (hex) of the canonical JSON of the sendable fields, in this key order, no whitespace:
`{"account","to","cc","subject","body","inReplyTo"}` (`cc` `[]` and `inReplyTo` `null` when absent). It is the card
`version`. `threadId`, `why` and `requestedBy` are shown but not hashed.

**Item.** `refId` = outbound id, `title` = subject, `problem` = who asks and why, `context` = the FULL payload as
text (From / To / Cc / Subject / In-Reply-To, blank line, body; never clipped), plus:

```ts
type OutboundPayload = {
  id: string; kind: "email"; account: "personal" | "hello"; to: string[]; cc: string[]; subject: string; body: string
  inReplyTo: string | null; threadId: string | null; why: string; requestedBy: string; payloadHash: string
}
```

Severity `normal`. `item.version` = `payload.payloadHash`.

**Options** (fixed): `a` Send (`approve`, recommended) · `b` Edit (`answer_custom`: the text becomes the new body →
new hash → a new card version) · `c` Don't send (`reject`, NOT destructive) · `d` Snooze 24 h.

**choose** adds `version` to the body: `{ optionId, text?, version }`.
- Send requires `version` equal to the stored hash, re-checked at the moment of sending (an atomic
  `proposed → sending` claim at that hash). Missing or different → `409 { error: "stale_approval", next }`,
  nothing sent, the card re-renders with the current version. Same for an Edit / Don't send that echoes an old version.
- Idempotent: a replayed Idempotency-Key returns the stored result (`result: "replay"`), never a second send; the
  claim also stops a concurrent second tap. Success → `{ result: "done", detail: { status: "sent", messageId } }`,
  the Gmail message id stored on the row.
- Server policy, whatever was approved (checked at propose, at edit and again at send): body over 50 KB (UTF-8
  bytes) or more than 10 recipients (to + cc) → `422 { error: "refused", reason }`. There is no recipient allowlist.
- Send failure → `502 { error: "send_failed", reason }`, the row is back to `proposed`.
- Sender: `~/.claude/tools/gmail.py` (raw-MIME send for personal + hello@; never the claude.ai connector, which wraps
  links), override with `COMPANION_GMAIL_PY`. The executor is injected (tests use a fake).

Older iOS builds ignore the new source and fields.

## Opus resolver (2026-10-04 — additive)

Jeremie: "for me to open a PR and review it will ultimately fall onto asking you to solve it. So why not put
Opus 5.5 back in the loop of 'needs your attention'." Before an item reaches Jeremie, an Opus 5.5 agent works it
as far as it safely can. Jeremie then sees nothing (Opus resolved it) or a card with Opus's finished work and ONE
decision. Store host only (Zettlab); a Mac shows no resolver state.

### Wire additions

```ts
type ResolverInfo = {
  status: "queued" | "resolving" | "prepared" | "failed"   // "queued" added 2026-10-04 (resolving[] only, never on a card)
  summary: string            // ≤ 200 chars, one line, OUTCOME FIRST once Opus acted:
                             // "Fix failed: …" · "Fix pushed 1a2b3c4d: …; CI re-running" · "No change needed: …" ·
                             // "Opus tried twice: …"; a card-only run keeps its recommendation ("Opus reviewed: …")
  model: string              // "claude-opus-5-5"
  finishedAt: number | null  // ms
  outcome?: "done" | "failed" | "no_change" | "planned"   // added 2026-10-04: finished runs only (see below)
  queuePosition?: number     // added 2026-10-04: status "queued" only, 1-based place in Opus's queue
}

type ResolvingItem = {       // an item Opus is working on: NOT in `items`
  id: string                 // the item id it will have when (if) it comes back as a card
  source: TriageSource
  title: string
  project: string | null
  repo: string | null        // added 2026-10-15 — see "Repo"
  resolver: ResolverInfo     // status "resolving" (Opus is on it) or "queued" (waiting for a slot, with queuePosition)
}
```

`resolver.outcome` (additive, 2026-10-04) says how a finished run ended, so a card never reads as done when it
is not: `done` = Opus acted (answered, closed, pushed a fix…) · `failed` = its action did not go through (the
summary and the card's `problem` start with the reason; the recommended option is "Ask Opus to retry", or, after
the same action failed the same way twice, a manual step such as "Open the PR" — never another identical run) ·
`no_change` = the fix run found nothing to change · `planned` = Opus only prepared the card. After a fix pushed
on a sensitive PR the card recommends "Wait for CI" (snooze 1 h) with Merge "only once CI is green"; it never
offers "Ask for changes" right after changes were made.

- `items[]` never holds an item Opus is still working on or has queued. Those are in `resolving[]`, for a
  compact "Opus is on it (N)" line: N = queued + resolving (working runs first, then the queue in order;
  a queued row reads "Opus queued (3)"). In `items`, `resolver.status` is `prepared` (Opus's card) or `failed`
  (the run fell through: the normal card, marked); absent = Opus never touched it (mytask, budget, kill switch).
- Every non-mytask card carries, LAST and never recommended, option `{ id: "opus", label: "Ask Opus…",
  action: { kind: "ask_opus" } }` while the resolver is on. An Opus card may also carry a prefilled one,
  e.g. `{ label: "Ask for changes", action: { kind: "ask_opus", instruction: "Fix on the PR branch: …" } }`.
- `POST …/choose` with an `ask_opus` option: `text` (optional) is Jeremie's instruction and wins over a
  prefilled `instruction`. → `200 { ok, id, result: "done", next, detail: { resolver: "resolving" } }`; the item
  moves to `resolving[]` in the next frame. `409 resolver_disabled` (kill switch / Mac) · `409 not_routable` (mytask).
  Choosing any option on an item that is in `resolving[]` → `409 resolving` (`next: null`).

### What Opus does per source (the server's policy decides; the model only proposes)

- **Blocked task.** Opus reads the task, the blocker, the project note, STATE.md, the repo and Jeremie's memory
  files (read-only). Confident (≥ 0.8, nothing that needs Jeremie) → answers it through the guarded unblock;
  "Opus answered: …" in the task activity (`resolver:answer`) and as a 🤖 orchestrator turn. A genuine preference,
  money, client-facing wording or anything irreversible → card, Opus's best answer as the recommended option.
  **Failed task:** requeue only when the failure is clearly transient; else a card.
  **Blocked on "No local repo mapped" (2026-10-06):** Opus may `route` it: `{"kind":"route","repo":"<REPO_MAP name>"}`.
  Confident → one guarded UPDATE prefixes `[repo:<name>] ` to the task text and requeues it (dispatch-run routes on
  the marker first); the name must exist in REPO_MAP; a task already carrying a marker is never re-routed. Unsure →
  card whose first option is `ask_opus` with "vas-y, route it to <name>" (one tap = consent). Activity `resolver:route`.
- **Parked PR** (shepherd `pr:needs-human`). Opus reviews the diff, the checks and the task.
  Sensitive (auth / payment / schema / secrets / migrations / CI config — the shepherd's SENSITIVE list): a
  threat-model review in `context` (What changed / Risk / Could fail in prod / Tests / Problems); the card says
  "Opus reviewed: …" with [Merge] (recommended when the review reads safe) · [Ask for changes] · [Close]; Opus
  never hands a sensitive PR back on its own. **A sensitive PR is never merged without Jeremie** — the card's
  Merge, or `ask_opus` with explicit words ("do it", "merge", "vas-y"…).
  Not sensitive: stale / superseded / task done → Opus comments why and closes it; CI failing after the
  shepherd's 2 fixes → ONE rescue per PR (a hand-back, below); anything else → card.
- **Proposal.** Duplicate / stale / already done → rejected with the reason; otherwise a card with Opus's
  recommendation. A proposal Opus created itself is never resolved again.
- **Body failed twice** (components on this host): a deeper read-only investigation (the investigator's tools,
  Opus, 20 min) → a #Body fix proposal or a plain explanation; the component's item then leaves triage.
- **Mytask:** never (Jeremie's own list; no Ask Opus button).

Autonomy per run: `normal` (Opus's own pass, in the daily budget) · `elevated` (`ask_opus`, below) · `delegated`
(2026-10-15: Jeremie's Yes on a repo card — see "Repo cards"; outside the daily budget, never expires in the queue,
never counts as Opus's one rescue on a PR).

`ask_opus` = elevated autonomy for that item only: Opus may execute any action the source allows, outside the
daily budget. **Consent (2026-10-04):** an instruction that tells Opus to act counts as consent to Opus's
recommended action for THAT item, merge / cancel / close / approve included: the short obvious ones on their own
("fix it", "do it", "go", "handle it", "ok", "yes", "merge", "close", "cancel", "vas-y", "fais-le", "règle ça"…),
a longer order only when Opus's JSON also says `consent: true`. Words that limit Opus ("don't merge", "just look",
"explain", "ne merge pas", a question) → Opus only prepares a card. No instruction → a merge or a cancel still
waits for Jeremie's tap. If Opus finds the work already done, "fix it" closes the item (task: cancel).

### Budget, kill switch, fall-through

≤ 2 runs at once, ≤ 60 normal runs started per local day (`COMPANION_RESOLVER_DAILY`; `ask_opus` runs never
count), 20 min per run, model `COMPANION_RESOLVER_MODEL` (default
`claude-opus-5-5`). The backlog drains `ask_opus` first, then urgent → normal → low, oldest first; a normal run
still queued after 3 h falls through to the normal card. A queued run a restart dropped is queued again.
Loop guard: the same action failing the same way twice on an item (24 h) is not run a third time unless
Jeremie's instruction says "retry" / "réessaie".
The analysis reads the project's checkout when this host has one: the server reads claude-config's REPO_MAP from `~/.claude/tools/repo-map.ts`
(override `COMPANION_REPO_MAP`; older checkouts: `dispatch-run.ts`) and logs the entry count at boot — 0 entries
is a loud warning (log + a #Body turn on the store host).
Kill switch: `COMPANION_RESOLVER=0` or `~/.claude-companion/.resolver-disabled` (waiting items show as normal
cards at once). Over budget, timeout, crash, unparseable output, server restart → the normal card, so nothing
is ever lost. Every action → Turso `agent_activity` row `resolver:<action>` (agent `opus-resolver`, one-line
summary, meta `{item, model, autonomy, instruction?, confidence, category, reason}`): answer · requeue · cancel ·
merge · close_pr · fix · approve · reject · revise · propose · explain · prepared · failed. A daily #General
turn after 21:00 (`COMPANION_RESOLVER_DIGEST_HOUR`): "🤖 Opus handled N items today: answered X, closed Y,
prepared Z for you."

### PR fixes: hand back to the shepherd (one work stream, 2026-10-23)

The resolver runs no builder of its own (docs/one-stream-plan.md, Q2). Opus's `fix` action on a PR = a
`pr:unpark` row (agent `opus-resolver`, `target_kind 'task'`, meta `{url, by: "opus-resolver", reason}`, reason
`Opus rescue: <instructions>`) that hands the PR back to the PR shepherd, whose fix run (a pipeline stage, with
its own gates) makes the changes; then a PR comment with Opus's instructions and why, a 🤖 turn, and activity
`resolver:fix` (meta `then: "unpark"`). The item resolves (no card). A failed `pr:unpark` write is the honest
outcome-first card ("Fix failed: hand-back failed: …", "Ask Opus to retry"; loop-guarded). Policy: normal → one
hand-back per PR (non-sensitive only); `ask_opus` / [Ask for changes] → a hand-back, sensitive included;
delegated → non-sensitive only. A parked PR always carries its tasks row, so there is no PR without one here.
The peer fix endpoints (`/api/resolver/has-repo`, `/api/resolver/fix`) are gone; the Mac's
`resolver_peer_fixes` table is left in companion.db (nothing writes it).

Dry run (nothing executed): `bun cli.ts resolver-dry-run [--limit N] [--source task|pr|proposal|body]`
(point `COMPANION_DB_PATH` at a copy of companion.db).

### iOS requirements (separate PR)

1. Decode `TriageAction` kind `ask_opus` (`instruction?: String`). Today it decodes as `.unsupported` and is
   hidden — safe, but Jeremie can't hand anything back.
2. Render the `opus` option as a secondary "Ask Opus…" control (not a big option button) that opens a sheet with
   ONE optional text field ("do it", "make it smaller", "just fix it") → `POST …/choose { optionId, text? }`.
   A prefilled `ask_opus` option (e.g. "Ask for changes") is a normal option button that posts without text;
   show its `detail`.
3. Decode `TriageItem.resolver` (optional). When `status == "prepared"`: an "Opus" badge + `summary` above the
   problem line, and `context` shown as Opus's analysis (multi-line, expandable; up to 1500 chars). When
   `"failed"`: a muted "Opus couldn't finish: <summary>" line; the card is otherwise normal.
4. Decode `resolving: [ResolvingItem]` from GET and the `orchestrator_triage` frame (missing = `[]`), and show one
   compact row "Opus is on it (N)" (expandable to the titles) above the cards. No actions on those rows.
   N counts queued + resolving; a row whose `resolver.status == "queued"` may read "Opus queued (queuePosition)".
   (2026-10-04: an unknown `ResolverInfo.status` must not drop the row — today's app ignores `resolver` on these rows.)
7. Show `resolver.outcome == "failed"` as a failure line ("Opus couldn't finish: <summary>") even on an Opus card.
5. Handle `409 resolving` and `409 resolver_disabled` from choose: toast ("Opus is still on it" /
   "Opus is off"), refresh the list.
6. After an `ask_opus` choose: optimistic move of the card into the "Opus is on it" row; the next frame confirms.

## Takeover (2026-10-16 — additive, blocked-task-takeover)

Jeremie takes a blocked task over in an interactive session (herdr, `--remote-control <name>`), bound to the
Turso row until it opens a PR or ends (CircleCI "Rerun with SSH" + Copilot agent hand-off: the PR completes it).
Code: `lib/takeover.ts`, `lib/takeover-store.ts`, `lib/dispatch-live.ts`, `wiring/takeover.ts`, `-choose.ts`, `-liveness.ts`.

### Option

Every blocked `task` card carries, after the phrased options and before `opus` (never the recommendation,
present with the resolver off too, appended by code, never model-phrased):

```jsonc
{ "id": "takeover", "label": "Take over in a session",   // "Reprendre en session" on a French card
  "detail": "claude-companion · on Zettlab",              // or "Pick the repo first" when ambiguous
  "action": { "kind": "takeover", "repo": "claude-companion", "host": "zettlab" } }
// ambiguous: "action": { "kind": "takeover", "candidates": [{ "repo": "…", "host": "mac" | "zettlab" }] } (≤ 4, may be [])
```

Target (pure, at collect, never in `version`): repo = a `[repo:<name>]` title marker, else the ONE map name the
title + blocker name, else ask (candidates = names named ∪ the note-mapped repo). Host = a `mac:`/`zettlab:`
component id in the title, else an Xcode repo → the Mac (both pinned), else Zettlab first, then the Mac.
Build 52 decodes an unknown kind as `.unsupported` and hides the option.

### Choose

`POST /api/orchestrator/triage/<id>/choose { optionId: "takeover", text? }` — `text` = the repo name when the
action has none (checked against REPO_MAP names / GitHub names). Claim-then-async: the server re-reads the row
(version check), checks the checkout (map entry is a dir here, `requires` met), herdr's gate and the name,
writes the run row, then claims Turso in ONE guarded UPDATE (`blocked` at the seen `updated_at` → `running`,
owner `companion:takeover:<name>`, `dispatch_run_id = tko_…`, blocker / completed_at / pr_url cleared), and answers:

```jsonc
200 { "ok": true, "result": "done", "detail": { "host": "zettlab", "session": "tko-zettlab-ab12cd34",
      "cwd": "~/.claude-companion/takeover/tko-zettlab-ab12cd34", "branch": "takeover/ab12cd34",
      "dispatchTaskId": "…", "status": "starting", "replay"?: true } }
```

Worktree (`git fetch` + `worktree add -b takeover/<id8> <cwd> origin/<default>`), `herdr agent start <name>
… -- --remote-control <name>` (env `COMPANION_TASK_ID=<name>`) and the seed prompt (task, blocker, description,
the RES how-to, the last dispatch-log section when the blocker is "Agent reported done but produced no file
changes"; while the run is active the seed stays pending behind a start dialog or typed input — polled every 5 s,
up to 2 h, one orchestrator turn per dialog title naming it — and goes in once the pane is clear; other
refusals like `agent_not_ready` retried 5 s × 24) run in the background; a failure → the task blocked again with
`Takeover failed to start (<why>) — <original blocker>` and an orchestrator turn. The session shows in Sessions
~20 s later. Errors: 422 `repo_required {candidates}` · 409 `stale` / `no_checkout` / `herdr_unavailable {reason}`
/ `host_unreachable {host, reason}` / `name_taken {session}` · 503 only when Turso is down (SendQueue retries 5xx
silently). A replay (same Idempotency-Key, or any retry while the run is open) returns the existing run's detail,
never a second session.

`name` = herdr agent = Remote Control name = `COMPANION_TASK_ID` = `tko-<host>-<id8>` (host `mac` | `zettlab`,
id8 = the first 8 `[a-z0-9]` of the task id). Hooks send it as `X-Companion-Task-Id`; worker identity never
resolves a `tko-` id to a worker (no cwd guess).

### Peer hop

Wrong host → `POST /api/orchestrator/takeover` on the peer (`COMPANION_BODY_PEER`, bearer + `x-companion-takeover-hop: 1`)
`{ taskId, version, repo, host, logTail?, by }` → the same detail; `not_owner` when `host` is not the peer, never
re-forwarded. First host `no_checkout` → the other (not when pinned); both → 409 `no_checkout`.

### Lifecycle

| event | → |
|---|---|
| Stop with a PR URL in the turn whose head `gh pr view` confirms is `takeover/<id8>`, or `gh pr list --head takeover/<id8>` (≤ 1 check / 30 s; only PRs created during this run) | `completed` + `dispatch_pr_url`; worktree + workspace removed only once the session is gone |
| Stop whose last line is `TAKEOVER DONE: <what>` (no-code fix) | `completed`, no PR (lands in /today's accept bucket) |
| SessionEnd (not `/clear`) or gone (60 s tick: no registered session with that task id and claude not in front of its herdr pane, 2 ticks in a row, once seen live, or after a 3 min start grace, or `herdr agent get` fails) | one last gh check, else `blocked` `Takeover ended without a PR — <original blocker>` (how-to ref kept); the workspace is closed once its pane is at the shell |
| Turso down at the finish | run stays `finishing`; the tick retries |

Finish is guarded on `running AND owner = companion:takeover:<name>` (first of Stop / SessionEnd / tick wins).
The owner stays on the row afterwards. A Companion restart only re-arms the tick (herdr sessions survive it).
Re-takeover with a finished run's leftover agent (no session): that workspace is closed first. Abort = `/exit`.

### Interplay

- Opus and the repo-card Yes leave a task blocked `Takeover ended…` / `Takeover failed to start…` alone (held: "taken over").
- `POST /api/orchestrator/task/<id>/{cancel,requeue,unblock}` on a running takeover → 409 `under_takeover {session}`.
- The 48 h PR safety net skips `companion:takeover:%` rows (a park still shows them); never auto-merged (`dispatch/` only).
- dispatch-run's stall sweep skips `companion:%` owners, so a running takeover is never reaped.
- `orchestrator_task` frames of a running takeover carry `sessionKey` (the session on the host that runs it).
