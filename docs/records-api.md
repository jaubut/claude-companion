# Companion ID Records API

Server: `server/routes/records.ts` (HTTP), `server/lib/records-store.ts` (store + audit),
`server/lib/records-expiry.ts` (expiry pushes). Guards are reused from
`server/lib/vault-guard.ts`, upstream forwarding from `server/lib/vault-upstream.ts`.

Store: `~/.config/tls-agent/records.json`, dir `0700`, file `0600`, atomic write
(tmp + rename) under one global write lock:

```json
{"version":1,"records":[{"id":"k3m9x2a7q4pz","type":"passport","label":"Passport · CA",
  "fields":{"expiry_date":"2031-07-16","…":"…"},"created_at":"…","updated_at":"…"}]}
```

**Decision (Jeremie, 2026-10-02).** Passport and driver's licence details live
here **in plaintext at rest** (no encryption). They are never exported into agent
sessions, never written to `secrets.env`, and never mirrored to the Mac. Field
values leave the store only in the body of a 200 from
`POST /api/records/:id/reveal`, and the expiry push carries the label and the
expiry date only.

## Types and fields

All values are strings. Every field is optional except `expiry_date`.

| Type | Fields |
|---|---|
| `passport` | `full_name`, `nationality`, `document_number`, `date_of_birth`, `place_of_birth`, `sex`, `issue_date`, `expiry_date` (required), `issuing_authority`, `notes` |
| `driver_license` | `full_name`, `licence_number`, `date_of_birth`, `address`, `class`, `conditions`, `issue_date`, `expiry_date` (required), `issuing_region`, `notes` |

- `date_of_birth`, `issue_date`, `expiry_date`: `YYYY-MM-DD`, a real calendar date.
- Values: ≤ 200 chars, no control characters. `notes`: ≤ 2000 chars, newline allowed.
- A field that isn't in the type's list is rejected (`bad_field`).
- `label`: ≤ 60 chars, no control characters. Missing or `""` → default:
  `Passport · <nationality>` or `Driver licence · <issuing_region>` (or just `Passport` / `Driver licence`).
- `id`: 12 random base32 chars (`[a-z2-7]{12}`). Anything else in a path is `404 not_found`.

## Gates (in order, on every `/api/records*`)

| # | Gate | Fail |
|---|---|---|
| 1 | Network: loopback, tailnet, or `tailscale serve` (same rule as the vault, see `docs/vault-api.md`) | `403 {ok:false, error:"forbidden_network"}` |
| 2 | `Authorization: Bearer <token>` header. `?token=` is refused, even when valid | `401` (plain text) |
| – | Upstream mode only: a call that carries `x-companion-vault-hop` | `508 {ok:false, error:"upstream_loop"}` |
| 3 | Rate limit, global, the records' own budgets (not the vault's). Writes (POST/PATCH/DELETE): 10/min shared. Reveal: 5/min. GET: 60/min | `429 {ok:false, error:"rate_limited", retry_after}` + `Retry-After` |

## Endpoints

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/api/records` | none | `200 {ok:true, writable:true, records:[{id, type, label, expiry_date, updated_at}]}` sorted by `expiry_date`. The list never carries any other field |
| POST | `/api/records` | `{type, label?, fields}` | `201 {ok:true, id}` |
| PATCH | `/api/records/:id` | `{label?, fields?}` | `200 {ok:true, id}`. `fields` merge into the record; a field set to `""` is deleted. `expiry_date` can't be deleted |
| DELETE | `/api/records/:id` | none | `200 {ok:true, id}` |
| POST | `/api/records/:id/reveal` | none (empty) | `200 {ok:true, record:{id, type, label, fields, created_at, updated_at}}` |

Every JSON response has `Cache-Control: no-store`. Reveal responses (success and
error) also have `Pragma: no-cache`. Reveal is POST only: a GET is `405`.

## Error codes

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_json` | Body is not a JSON object (POST, PATCH) |
| 400 | `bad_type` | `type` is not `passport` or `driver_license` |
| 400 | `bad_field` | Unknown field, value not a string / too long / control char, bad `label`, `fields` not an object, PATCH with neither `label` nor `fields` |
| 400 | `bad_date` | A date field is not a real `YYYY-MM-DD` |
| 400 | `missing_expiry` | No `expiry_date` on create, or a PATCH that would delete it |
| 401 | (text) | No header bearer, wrong token, or `?token=` |
| 403 | `forbidden_network` | Not loopback / tailnet / tailscale serve |
| 404 | `not_found` | Unknown or malformed id |
| 405 | `method_not_allowed` | Any other method |
| 429 | `rate_limited` | Over budget; see `Retry-After` |
| 500 | `audit_failed` | Reveal only: the audit line could not be written, so nothing was returned |
| 500 | `store_unreadable` | `records.json` exists but isn't valid; nothing is written over it |
| 502 | `upstream_unreachable` | Upstream mode: no answer in 10 s, network error, or a redirect |
| 508 | `upstream_loop` | Upstream mode: the call was itself forwarded |

Error `message`s are French and never echo a value, a label or an unknown field name.

## Audit and logs

Every successful create / update / delete / reveal appends to
`~/.config/tls-agent/records-audit.jsonl` (0600):

```json
{"ts":"…","action":"created|updated|deleted|revealed","id":"k3m9x2a7q4pz","type":"passport",
 "device_claimed":"iPhone 17","transport":"tailscale-serve","peer":"100.x.y.z"}
```

No field value and no label. A reveal whose audit line can't be written returns
`500 audit_failed` and no record. Log lines: `records <action> <id> <type> via=<transport> from=<peer>`,
errors as `records <error> via=… from=…`. Never a value, a label, the URL or the body.

## Upstream mode

When `COMPANION_VAULT_UPSTREAM` is set (the Mac), every `/api/records*` call runs
gates 1–3 locally, then is forwarded to the upstream's same path exactly like the
vault: this server's bearer in the header, `x-companion-device: <device> via <host>`,
`x-companion-vault-hop: 1`, 10 s timeout, redirects not followed. Status, body and
`Retry-After` come back unchanged; `GET` adds `upstream: "<host[:port]>"`.
`bad_json` and a malformed id are answered locally and never forwarded.
`COMPANION_VAULT_PULL_CMD` never runs for records. The forwarding host never
reads or writes a local `records.json`, audit or alerts file, and its expiry timer is off.

## Expiry alerts

Store host only (upstream unset). Checked at startup, then every 24 h
(`setTimeout` chain, unref'd).

| Phase | Alert |
|---|---|
| Passport ≤ 300 days left, licence ≤ 60 days left | first alert, then every 30 days |
| Last 14 days (including the expiry day) | daily |
| Expired | one alert on crossing, then weekly |

- APNs push via the existing sender (`pushToAll`), category `briefing`, title
  `Document expiry`, body like `Passport · CA expires in 287 days (2027-07-16)`,
  `collapseId: record-<id>`, `userInfo: {kind:"record_expiry", id}`. Label + date only.
- Log line `records alert <id> <type> sent=<n>`. No feed item (feed kinds are an iOS contract).
- Last alerts persist in `~/.config/tls-agent/records-alerts.json` (0600):
  `{version:1, alerts:{<id>:{expiry_date, last_alert_at, last_days_left}}}`.
  A restart doesn't re-alert. A new `expiry_date` (renewal) restarts the schedule.
  Deleted records are pruned. An alert that reached no device is not recorded, so it
  retries on the next daily check.

## Threat model

- **At rest.** Plaintext JSON, `0600` in a `0700` dir. Anyone with the server
  user's shell (or a backup of `~/.config/tls-agent`) reads every field. Accepted
  by decision; disk/backup encryption is the mitigation.
- **Agent sessions.** The store is not in `secrets.env`, not read by `tls-secrets.py`,
  and no route exports it into a session or a pane. A Claude agent running as the
  same user can still `cat` the file: the sandbox's filesystem rules are the only
  barrier there.
- **Bearer token.** Anyone holding the Companion token on the tailnet (or on the
  host) can reveal every record at 5/min, each one audited with claimed device and
  network origin. Face ID on iOS is a client-side gate only.
- **Mac.** In upstream mode nothing is stored locally; values transit the Mac only
  in the forwarded reveal response body, never logged.
