// A request's JSON object body. A body that parses to anything else (null,
// array, number, string) throws BadJsonBody, which the route chain answers
// with 400 bad_json (companion-server.ts), so no route guards it itself.

export class BadJsonBody extends Error {}

/** `onMalformed`: what an unparsable or empty body gives instead of throwing, for routes where the body is optional. */
export async function jsonObject<T = Record<string, unknown>>(req: Request, onMalformed?: T): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    if (onMalformed !== undefined) return onMalformed
    throw new BadJsonBody()
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BadJsonBody()
  return body as T
}
