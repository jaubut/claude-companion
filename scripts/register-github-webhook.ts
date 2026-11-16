#!/usr/bin/env bun
import { getGithubWebhookSecret } from "../server/lib/github-webhook"
import { tailscaleNameOf } from "../server/lib/request-gate"

interface ExistingHook {
  id: number
  active?: boolean
  events?: string[]
  config?: { url?: string; content_type?: string }
}

function usage(): never {
  console.error("Usage: bun scripts/register-github-webhook.ts <owner/repo> [--url <https-url>] [--dry-run]")
  process.exit(1)
}

function parseArgs(argv: string[]): { repoFull: string; url: string | null; dryRun: boolean } {
  let repoFull = ""
  let url: string | null = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--url") {
      url = argv[++i]?.trim() || null
      if (!url) usage()
    } else if (a === "--dry-run") {
      dryRun = true
    } else if (a.startsWith("-")) {
      usage()
    } else if (!repoFull) {
      repoFull = a.trim()
    } else {
      usage()
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/.test(repoFull)) usage()
  return { repoFull, url, dryRun }
}

async function resolveDefaultUrl(): Promise<string> {
  const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  const tsName = code === 0 ? tailscaleNameOf(out) : ""
  if (!tsName) {
    throw new Error("Could not determine Tailscale DNS name; pass --url https://<host>/webhooks/github explicitly")
  }
  return `https://${tsName}:8443/webhooks/github`
}

async function runGh(args: string[], stdinText?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdinText !== undefined ? new Response(stdinText) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const { repoFull, url: rawUrl, dryRun } = parseArgs(process.argv.slice(2))
  const webhookUrl = rawUrl ?? (await resolveDefaultUrl())
  if (!/^https:\/\/.+/.test(webhookUrl)) {
    throw new Error(`Webhook URL must be HTTPS: ${webhookUrl}`)
  }

  const secret = getGithubWebhookSecret()
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is unset; provision it in ~/.config/tls-agent/env and load it before registration")
  const listRes = await runGh(["api", `repos/${repoFull}/hooks`])
  if (listRes.code !== 0) {
    throw new Error(`gh api repos/${repoFull}/hooks failed: ${listRes.stderr.trim() || listRes.stdout.trim()}`)
  }
  const existing = parseJsonSafe<ExistingHook[]>(listRes.stdout)
  if (!Array.isArray(existing)) {
    throw new Error("Unexpected response from GitHub hooks API")
  }

  const matched = existing.find((h) => h.config?.url === webhookUrl)
    ?? existing.find((h) => (h.config?.url ?? "").endsWith("/webhooks/github"))

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      action: matched ? "update" : "create",
      hookId: matched?.id ?? null,
      repo: repoFull,
      url: webhookUrl,
      secretSource: "GITHUB_WEBHOOK_SECRET",
      events: ["issues"],
    }, null, 2))
    return
  }

  const payload = JSON.stringify({
    ...(matched ? {} : { name: "web" }),
    active: true,
    events: ["issues"],
    config: {
      url: webhookUrl,
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  })

  const endpoint = matched ? `repos/${repoFull}/hooks/${matched.id}` : `repos/${repoFull}/hooks`
  const method = matched ? "PATCH" : "POST"
  const writeRes = await runGh(["api", "-X", method, endpoint, "--input", "-"], payload)
  if (writeRes.code !== 0) {
    throw new Error(`gh api ${method} ${endpoint} failed: ${writeRes.stderr.trim() || writeRes.stdout.trim()}`)
  }
  const saved = parseJsonSafe<ExistingHook>(writeRes.stdout)
  const hookId = saved?.id ?? matched?.id ?? null
  if (matched && hookId) {
    await runGh(["api", "-X", "POST", `repos/${repoFull}/hooks/${hookId}/pings`])
  }
  console.log(JSON.stringify({
    ok: true,
    action: matched ? "updated" : "created",
    repo: repoFull,
    hookId,
    url: saved?.config?.url ?? webhookUrl,
    events: saved?.events ?? ["issues"],
    active: saved?.active ?? true,
    secretSource: "GITHUB_WEBHOOK_SECRET",
  }, null, 2))
}

if (import.meta.main) {
  await main()
}
