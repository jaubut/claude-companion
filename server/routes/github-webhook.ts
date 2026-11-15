import { checkBearer } from "../lib/auth"
import { getGithubWebhookSecret, verifyGithubSignature } from "../lib/github-webhook"
import { HOST_INFO } from "../state"
import { type GithubWebhookDispatcher, githubWebhookDispatcher } from "../wiring/github-webhook"

export interface GithubWebhookRouteDeps {
  dispatcher?: GithubWebhookDispatcher
  getSecret?: () => string
  authorizeBearer?: (req: Request) => boolean
  localHost?: string
}

export const GITHUB_WEBHOOK_PATH = "/webhooks/github"

export function createGithubWebhookRoute(deps: GithubWebhookRouteDeps = {}) {
  const dispatcher = deps.dispatcher ?? githubWebhookDispatcher
  const getSecret = deps.getSecret ?? (() => getGithubWebhookSecret())
  const authorizeBearer = deps.authorizeBearer ?? checkBearer
  const localHost = deps.localHost ?? HOST_INFO.name

  return async function handleGithubWebhookRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== GITHUB_WEBHOOK_PATH) return null

    if (req.method === "GET") {
      return Response.json({ ok: true, service: "github-webhook", host: localHost })
    }
    if (req.method !== "POST") {
      return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 })
    }

    const rawBody = await req.text()
    const signature = req.headers.get("x-hub-signature-256")
    const isFunnel = req.headers.has("tailscale-funnel-request")

    if (signature !== null) {
      let secret = ""
      try { secret = getSecret() } catch { secret = "" }
      if (!verifyGithubSignature(rawBody, signature, secret)) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 })
      }
    } else if (isFunnel || !authorizeBearer(req)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
    }

    let payload: unknown = null
    try {
      payload = JSON.parse(rawBody) as unknown
    } catch {
      return Response.json({ ok: false, error: "bad_json" }, { status: 400 })
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 })
    }

    const eventName = req.headers.get("x-github-event")
    const deliveryId = req.headers.get("x-github-delivery")
    const result = await dispatcher.handleEvent(eventName, deliveryId, payload)
    if (!result.ok) {
      return Response.json(result, { status: result.httpStatus })
    }
    return Response.json(result)
  }
}

export const handleGithubWebhookRoute = createGithubWebhookRoute()
