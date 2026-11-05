# Blocked dispatch worker alerts

A herdr dispatch worker (`dispatch-<id8>`) sitting on an interactive dialog (permission prompt, question) is surfaced to Jeremie as a card + push; he answers once, the runner types the key. Server: `server/lib/worker-blocked.ts`, `server/routes/worker-blocked.ts`. Runner: claude-config `tools/dispatch-runner.ts`.

## Runner → server (`/hooks/*`: loopback peer or Bearer, like `/hooks/dispatch-event`)

| method | path | body | answer |
|---|---|---|---|
| POST | `/hooks/worker-blocked` | `{taskId, title, worker, dialog, options:[{key, label}]}` + `Idempotency-Key` (one per dialog) | 201 `{ok, id, state:"open", choice:null}` · same key → 200 replay, same id · 422 `not_dispatch_worker` · 400 `taskId_required` / `dialog_required` / `options_invalid` |
| GET | `/hooks/worker-blocked/<id>` | | `{ok, id, state, choice:{key, label}\|null}` · 404 `no_such_alert` |
| POST | `/hooks/worker-blocked/<id>/close` | | the runner gave up or the dialog left the screen: an open card → `expired`; an answered one stays answered |

- `worker` must match `^dispatch-[0-9a-f]{8}$` (never `cc-*`, `builder-*`, `tko-*`).
- `key` is one character the runner sends to the pane (`"1"`, `"3"`). An option whose label mentions "auto mode" or "don't ask again" is dropped (never offered). Max 9 options.
- `dialog` and labels are passed through `redactSecrets` server-side too (the runner redacts first). Dialog ≤ 2000 chars.
- An open alert expires 30 min after it was posted (`ALERT_TTL_MS`), the runner's extended give-up. A sweep every minute flips it (and re-sends the card) even if nobody reads it.
- Both replay keys are stored on the card (`postKey`, `answerKey`), so replays hold across a server restart.
- The push is retried 3 times (5 s, 30 s, 2 min) when every token fails transiently, with the same collapse id.

## Phone → server (Bearer)

`POST /api/orchestrator/worker-blocked/<id>/choose` `{optionId}` + `Idempotency-Key` → 200 `{ok, id, state:"answered", choice}`.
One answer per alert: the same key + option replays (`Idempotent-Replayed: true`), any other answer is 409 `already_answered` (+ `choice`), an expired alert is 410 `expired`, an option not on the card 400 `unknown_option`.

## Card

An `orchestrator` turn in the brain thread (`#General` off the brain host), re-sent with the same id on every state change:

```
turn.card = {kind:"worker_blocked", source:"app", taskId, worker, title, dialog,
             options:[{id, label}], state:"open"|"answered"|"expired", chosen?, expiresAt,
             brief, postKey?, answerKey?}
```

## The brain

On the brain host the card lands in the brain thread, so the brain hears it, but only `card.brief`: task id, worker and the tool (the first word of the dialog's first line), plus "never answer it, type into or drive that worker's pane". The dialog text and the options never reach the brain: delivery, the boot seed and `bin/thread` all read `brainText` in `lib/brain.ts`. Answering is the phone's Bearer endpoint only.

`turn.text` carries the dialog and the numbered options, so a build that does not know the card still shows them. Shipped iOS builds decode `card` with `try?` and `kind` as a `String` (claude-companion-ios `BrainTrace.swift`), so the new kind never fails a turn. Push: category `dispatch_task`, time-sensitive, `userInfo {kind:"worker_blocked", turnId, taskId, channel}`.
