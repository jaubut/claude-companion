# Companion Vault API

Server: `server/routes/vault.ts` (HTTP), `server/lib/secret-store.ts` (store + `/key`),
`server/lib/vault-guard.ts` (network gate + rate limits).

Store: `~/.config/tls-agent/secrets.env`, one line per key:
`NAME='value'  # host [host ...] [scripts|plain]`. Every write is atomic, mode 0600,
touches one line only, then runs `~/.claude/tools/tls-secrets.py sync` (sandbox
masking). If sync fails the file is rolled back. Successful writes append to
`~/.config/tls-agent/vault-audit.jsonl`.

**Values are write-only, with one exception.** No response, log line, broadcast,
feed item or audit entry ever contains a value, except the body of a 200 from
`POST /api/vault/:name/reveal` (decision 2026-10-02: the iOS Vault shows a value
behind Face ID). See [Reveal](#reveal-post-apivaultnamereveal).

## Gates (in order, on every `/api/vault*` and `POST /api/secret`)

| # | Gate | Fail |
|---|---|---|
| 1 | Network: loopback (`127.0.0.0/8`, `::1`), Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), or `tailscale serve` (loopback peer + `X-Forwarded-For` in those ranges, not Funnel) | `403 {ok:false, error:"forbidden_network"}` |
| 2 | `Authorization: Bearer <token>` header. `?token=` is refused, even when valid | `401` (plain text, `WWW-Authenticate: Bearer`) |
| 3 | Rate limit, global. Writes: 10/min shared by POST/PATCH/DELETE and `/key`. GET: 60/min. Reveal: 5/min, its own budget | `429 {ok:false, error:"rate_limited", retry_after:<s>}` + `Retry-After: <s>` |
| 4 | Writable host: `tls-secrets.py` must exist. Writes only; GET and reveal still work | `501 {ok:false, error:"vault_unavailable"}`. secrets.env is not read or written |

`X-Forwarded-For` is honoured only when the TCP peer is loopback, which means
tailscaled's serve proxy on the same host. tailscaled overwrites that header, so
a client can't spoof it. Any `Tailscale-Funnel-Request` header means a 403.

## Endpoints

| Method | Path | Body | 200 response |
|---|---|---|---|
| GET | `/api/vault` | none | `{ok:true, writable:boolean, secrets:[{name, hosts:string[], scripts:boolean, updated_at:string\|null}]}` |
| POST | `/api/vault` | `{name, value, hosts?:string[]}` | `{ok:true, name, hosts, action:"created"\|"updated", message}` |
| POST | `/api/secret` | same as above | Alias of `POST /api/vault` |
| PATCH | `/api/vault/:name` | `{hosts:string[]}` | `{ok:true, name, hosts, action:"hosts", message}`. The value is untouched |
| DELETE | `/api/vault/:name` | none | `{ok:true, name, hosts:[], action:"deleted", message}` |
| POST | `/api/vault/:name/reveal` | none (empty) | `{ok:true, name, value}`. The **only** response that carries a value |

`writable:false` means the app should hide or disable add, rotate, edit and delete.

Every response is JSON with `Cache-Control: no-store`, except the 401.
`message` is a French string you can show to the user.

### Validation

- `name`: `^[A-Z][A-Z0-9_]{1,63}$`. `:name` is not URL-decoded.
- `value`: 1–8192 chars. No `'`, `"` or control characters (including newlines). Spaces are OK over HTTP.
- `hosts`: at most 5, each like `api.example.com`, `*.example.com` or `host.io:443`.

## Error codes

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_json` | The body is not a JSON object |
| 400 | `bad_name` | The name fails validation |
| 400 | `bad_value` | The value is empty, too long, or contains a quote or control character |
| 400 | `bad_hosts` | A host is malformed, or there are more than 5 |
| 400 | `bad_key_command` | `/key` grammar error (chat only) |
| 401 | (text) | No `Authorization: Bearer` header, a wrong token, or `?token=` |
| 403 | `forbidden_network` | The peer is not loopback, tailnet or tailscale serve |
| 403 | `reveal_forbidden` | Reveal of a vault bootstrap key (`PHASE_SERVICE_TOKEN`, `PHASE_HOST`) |
| 404 | `not_found` | PATCH, DELETE or reveal on an unknown name |
| 405 | `method_not_allowed` | Any other method |
| 429 | `rate_limited` | Over budget. See `retry_after` and `Retry-After` |
| 500 | `audit_failed` | Reveal only: the audit line could not be written, so no value was returned |
| 500 | `sync_failed` | `tls-secrets.py sync` failed. The store was rolled back and the value is redacted from the detail |
| 501 | `vault_unavailable` | `tls-secrets.py` is absent on this host |
| 502 | `upstream_unreachable` | Upstream mode: the upstream did not answer in 10 s, failed, or redirected |
| 508 | `upstream_loop` | Upstream mode: the call was itself forwarded by another Companion |

## Reveal (`POST /api/vault/:name/reveal`)

Returns one secret's value so the iOS Vault can show it behind Face ID.

- **POST, never GET**, empty body. A GET (or any other method) is `405`. The name is in the path, the value only in the 200 body, so it never sits in a URL, a cache or an access log.
- Gates 1–2 as above, then its **own** rate limit: 5/min, global, separate from the write budget (`429 rate_limited` + `Retry-After`). A bad or forbidden name still spends a slot. Gate 4 does not apply: a host without `tls-secrets.py` can still reveal.
- Responses: `200 {ok:true, name, value}`, `400 bad_name`, `403 reveal_forbidden`, `404 not_found`, all with `Cache-Control: no-store` and `Pragma: no-cache`.
- Never revealed, even to a valid caller: `PHASE_SERVICE_TOKEN`, `PHASE_HOST` (the vault's own bootstrap). Constant `REVEAL_FORBIDDEN` in `server/lib/secret-store.ts`.
- `NAME='v'`, `NAME="v"` and `export NAME=v` lines all reveal `v`. First occurrence wins, as in the list.
- Each 200 appends `{ts, action:"revealed", name, device_claimed, transport, peer}` to the audit file (no value), and logs `vault reveal <name> via=<transport> from=<peer>`. Failures log the error code, never a malformed name. A `revealed` line does not change `updated_at`.
- If the audit line can't be written: `500 {ok:false, error:"audit_failed"}`. No audit, no value.
- The value never goes to `companion.log`/stderr, WS frames, the feed, the audit file or an error message.

**Threat note.** This relaxes the write-only rule for one endpoint. Anyone holding
the Companion bearer token on the tailnet (or on the host) can now **read** any
vault value except the two bootstrap keys, at 5 per minute, each one audited with
its claimed device and network origin. Before, a leaked token could overwrite or
delete secrets but not read them. Face ID is a client-side gate only: the server
can't verify it. Protect the token like the secrets themselves.

## `/key` chat command

Typed in any chat entry point: session inject, WS `input`, orchestrator send.
It is intercepted before the text can reach a pane, transcript or log.

```
/key NAME VALUE
/key NAME VALUE --hosts api.example.com,*.example.com
```

- `VALUE` is one whitespace-free token. To store a value with a space, use the Vault screen (HTTP).
- Hosts go only in `--hosts`, as a comma-joined list with no spaces.
- Anything else is rejected with `bad_key_command` and nothing is stored, including
  - extra words after the value
  - a bare trailing host (the old `/key NAME value host` form)
  - `--hosts` without a list

  Text after the value is never treated as hosts.
- The command shares the 10/min write budget (`429 rate_limited`) and the `501 vault_unavailable` check.
- The audit entry has `transport:"chat"`. `peer` is `"unknown"` until the chat entry points pass their origin through.

## Upstream mode (one vault for every host)

A Companion server can use **another** Companion server's vault as its single
source of truth (e.g. the Mac uses Zettlab's `secrets.env`). Code:
`server/lib/vault-upstream.ts`.

| Env | Value | Invalid → |
|---|---|---|
| `COMPANION_VAULT_UPSTREAM` | Base URL of the other server. `https://…`, or `http://` only for `127.0.0.1` / `localhost` / `[::1]`. No credentials, query or fragment | ignored (local store), one log line |
| `COMPANION_VAULT_PULL_CMD` | Optional. Absolute path of an executable file | ignored, one log line |

When `COMPANION_VAULT_UPSTREAM` is set:

- Gates 1–3 (network, header-only bearer, rate limit) still run on **this** server first. Gate 4 (local `tls-secrets.py` / 501) is skipped.
- `GET/POST /api/vault`, `POST /api/secret`, `PATCH/DELETE /api/vault/:name`, `POST /api/vault/:name/reveal` and `/key` (inject, WS `input`, orchestrator send) are forwarded to the upstream's `/api/vault` REST API. `POST /api/secret` goes to `POST /api/vault`.
- Auth to the upstream is **this server's own token** in `Authorization: Bearer` (never `?token=`). Both servers must share the token.
- `x-companion-device` is forwarded as `<claimed device> via <this hostname>` (cut to 64 chars, the suffix kept), so the upstream audit line shows both.
- The value travels only in the POST body (JSON, re-serialized from the parsed body). `bad_json` and a malformed `:name` (`bad_name`) are answered locally and never forwarded.
- The upstream's status and body come back unchanged, including `Retry-After` on 429 and its plain-text 401. The upstream writes its own audit line; this server writes none.
- `GET /api/vault` adds `upstream: "<host[:port]>"`; `writable` is the upstream's.
- Upstream unreachable, 10 s timeout, or a redirect (not followed, so the bearer never goes elsewhere) → `502 {ok:false, error:"upstream_unreachable"}`.
- Forwarded calls carry `x-companion-vault-hop: 1`. A server in upstream mode answers such a call with `508 {ok:false, error:"upstream_loop"}` instead of forwarding again.
- Reveal: a malformed (`bad_name`) or bootstrap (`reveal_forbidden`) name is answered locally and never forwarded. The upstream's status and body (with the value) are passed through with `no-store` + `no-cache`; the body is never logged. This server logs `vault reveal <name> via=… from=… upstream=<status>` and writes no audit line; the upstream audits.
- After each 2xx write (not GET, not a reveal, not a failure), `COMPANION_VAULT_PULL_CMD` runs: no shell, no args, inherited env, stdin/stdout/stderr discarded, killed after 30 s. Fire-and-forget; only `vault pull exit=<code>` is logged.
- Logs carry the method and the upstream status only, never the value, the token, the URL query or the upstream's response body.

Unset (or invalid) → behaviour identical to the local store described above.

## Audit line

```json
{"ts":"…","action":"created|updated|hosts|deleted","name":"FAL_KEY","hosts":["*.fal.run"],
 "device_claimed":"iPhone 17","transport":"tailscale-serve|loopback|tailnet|chat","peer":"100.x.y.z"}
{"ts":"…","action":"revealed","name":"FAL_KEY","device_claimed":"iPhone 17","transport":"tailscale-serve","peer":"100.x.y.z"}
```

- `device_claimed` is the client's own `x-companion-device` header, with `User-Agent` as fallback. Anyone can spoof it, so treat it as informative only.
- `transport` and `peer` are the server's own view of the connection.

## iOS client rules

1. **Face ID gate.** Require `LAContext` `.deviceOwnerAuthentication` before showing the Vault screen and before each write (add, rotate, hosts, delete) and each reveal.
2. **SecureField** for the value. No autocorrect, no smart punctuation, no suggestions. Don't put the value in `UIPasteboard` and don't offer copy.
3. **Never persist or log the value** (typed or revealed). Keep it out of `UserDefaults`, Keychain, Core Data and files, out of `print`/`os_log`/crash breadcrumbs, and out of URL query strings. Clear the field state after the request completes, on success or failure.
4. **Header auth only.** Send `Authorization: Bearer <token>`. Never send `?token=`, because the vault answers it with 401.
5. **`x-companion-device` header** on every vault request, for example `UIDevice.current.name`, ≤ 64 printable ASCII chars.
6. Go through the Tailscale HTTPS URL (tailscale serve). A LAN IP gets 403.
7. Handle `writable:false` and 501 by showing the vault as read-only. On 429, wait `Retry-After` seconds.
8. When a write succeeds, show `message`. The new value is live in the **next** agent session.
