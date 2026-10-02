# Companion Vault API

Server: `server/routes/vault.ts` (HTTP), `server/lib/secret-store.ts` (store + `/key`),
`server/lib/vault-guard.ts` (network gate + rate limits).

Store: `~/.config/tls-agent/secrets.env`, one line per key:
`NAME='value'  # host [host ...] [scripts|plain]`. Every write is atomic, mode 0600,
touches one line only, then runs `~/.claude/tools/tls-secrets.py sync` (sandbox
masking). If sync fails the file is rolled back. Successful writes append to
`~/.config/tls-agent/vault-audit.jsonl`.

**Values are write-only.** No response, log line, broadcast, feed item or audit
entry ever contains a value.

## Gates (in order, on every `/api/vault*` and `POST /api/secret`)

| # | Gate | Fail |
|---|---|---|
| 1 | Network: loopback (`127.0.0.0/8`, `::1`), Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), or `tailscale serve` (loopback peer + `X-Forwarded-For` in those ranges, not Funnel) | `403 {ok:false, error:"forbidden_network"}` |
| 2 | `Authorization: Bearer <token>` header. `?token=` is refused, even when valid | `401` (plain text, `WWW-Authenticate: Bearer`) |
| 3 | Rate limit, global. Writes: 10/min shared by POST/PATCH/DELETE and `/key`. GET: 60/min | `429 {ok:false, error:"rate_limited", retry_after:<s>}` + `Retry-After: <s>` |
| 4 | Writable host: `tls-secrets.py` must exist. Writes only; GET still lists | `501 {ok:false, error:"vault_unavailable"}`. secrets.env is not read or written |

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
| 404 | `not_found` | PATCH or DELETE on an unknown name |
| 405 | `method_not_allowed` | Any other method |
| 429 | `rate_limited` | Over budget. See `retry_after` and `Retry-After` |
| 500 | `sync_failed` | `tls-secrets.py sync` failed. The store was rolled back and the value is redacted from the detail |
| 501 | `vault_unavailable` | `tls-secrets.py` is absent on this host |

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

## Audit line

```json
{"ts":"…","action":"created|updated|hosts|deleted","name":"FAL_KEY","hosts":["*.fal.run"],
 "device_claimed":"iPhone 17","transport":"tailscale-serve|loopback|tailnet|chat","peer":"100.x.y.z"}
```

- `device_claimed` is the client's own `x-companion-device` header, with `User-Agent` as fallback. Anyone can spoof it, so treat it as informative only.
- `transport` and `peer` are the server's own view of the connection.

## iOS client rules

1. **Face ID gate.** Require `LAContext` `.deviceOwnerAuthentication` before showing the Vault screen and before each write (add, rotate, hosts, delete).
2. **SecureField** for the value. No autocorrect, no smart punctuation, no suggestions. Don't put the value in `UIPasteboard` and don't offer copy.
3. **Never persist or log the value.** Keep it out of `UserDefaults`, Keychain, Core Data and files, out of `print`/`os_log`/crash breadcrumbs, and out of URL query strings. Clear the field state after the request completes, on success or failure.
4. **Header auth only.** Send `Authorization: Bearer <token>`. Never send `?token=`, because the vault answers it with 401.
5. **`x-companion-device` header** on every vault request, for example `UIDevice.current.name`, ≤ 64 printable ASCII chars.
6. Go through the Tailscale HTTPS URL (tailscale serve). A LAN IP gets 403.
7. Handle `writable:false` and 501 by showing the vault as read-only. On 429, wait `Retry-After` seconds.
8. When a write succeeds, show `message`. The new value is live in the **next** agent session.
