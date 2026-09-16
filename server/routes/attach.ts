import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveSession } from "../lib/sessions"

// Attachments from the phone (PRJ-OR1T Phase 17).
//
// From the second device report: the Claude app has a + button — camera,
// photo, files — and we had no way to get anything from the phone into a
// session. The mechanism, measured 2026-09-16: a prompt containing
// `@/absolute/path.png` makes Claude Code Read the file as an image
// (`⎿ Read red.png (122 bytes)` → "Red."). So an attachment is a file on the
// session's host plus an @-mention in the prompt — the phone uploads here,
// gets the path back, and prepends `@path` when it sends.
//
// The file must land on the machine the session runs on, which is why the
// iOS client pins this request to the session's origin host rather than
// letting failover pick one.

const ROOT = join(homedir(), ".claude-companion", "attachments")
const MAX_BYTES = 25 * 1024 * 1024
// Keep the original name readable but never let it steer the path.
const SAFE_NAME = /[^A-Za-z0-9._-]+/g

function log(msg: string): void {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
  process.stderr.write(`${dim}[companion]${reset} ${cyan}attach${reset} ${msg}\n`)
}

export async function handleAttachRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Upload one file for a session ──
  // multipart/form-data: key=<session key>, file=<the file>. Returns the
  // absolute path on this host, ready to be @-mentioned.
  if (url.pathname === "/api/attach" && req.method === "POST") {
    // Inferred, not annotated: Bun's FormData and undici's disagree on the
    // iterator type and the annotation picks the wrong one.
    const form = await req.formData().catch(() => null)
    if (!form) return Response.json({ ok: false, error: "bad_form" }, { status: 400 })
    const key = String(form.get("key") ?? "").trim()
    const file = form.get("file")
    if (!(file instanceof File)) return Response.json({ ok: false, error: "no_file" }, { status: 400 })
    if (file.size === 0) return Response.json({ ok: false, error: "empty_file" }, { status: 400 })
    if (file.size > MAX_BYTES) return Response.json({ ok: false, error: "too_large", max: MAX_BYTES }, { status: 413 })

    // The session must be one of ours — the file is only useful on the host
    // that runs it, and a stray upload to the wrong machine is just litter.
    const session = key ? resolveSession(key) : null
    if (!session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })

    const day = new Date().toISOString().slice(0, 10)
    const dir = join(ROOT, day)
    mkdirSync(dir, { recursive: true })
    const base = (file.name || "attachment").replace(SAFE_NAME, "_").replace(/^_+|_+$/g, "") || "attachment"
    const path = join(dir, `${crypto.randomUUID().slice(0, 8)}-${base}`)
    try {
      await Bun.write(path, file)
    } catch {
      return Response.json({ ok: false, error: "write_failed" }, { status: 500 })
    }
    log(`${base} (${(file.size / 1024).toFixed(0)} KB, ${file.type || "?"}) → ${path} for ${session.label || session.key}`)
    return Response.json({ ok: true, key: session.key, path, name: base, size: file.size, type: file.type })
  }

  return null
}
