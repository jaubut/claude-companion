// A request's JSON object body. A body that parses to anything else (null,
// array, number, string) throws BadJsonBody, which the route chain answers
// with 400 bad_json (companion-server.ts), so no route guards it itself.

export class BadJsonBody extends Error {}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** `onMalformed`: what an unparsable or empty body gives instead of throwing, for routes where the body is optional. */
export async function jsonObject<T = Record<string, unknown>>(req: Request, onMalformed?: T): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    if (onMalformed !== undefined) return onMalformed
    throw new BadJsonBody()
  }
  if (!isObject(body)) throw new BadJsonBody()
  return body as T
}

/** `body`, once each listed field is absent, null or of its type. A wrong type throws BadJsonBody, for a 400 instead of a crash on first use. */
export function checked<T extends object>(body: T, fields: Partial<Record<keyof T, "string" | "boolean" | "object">>): T {
  for (const [name, type] of Object.entries(fields)) {
    const v = (body as Record<string, unknown>)[name]
    if (v !== undefined && v !== null && !(type === "object" ? isObject(v) : typeof v === type)) throw new BadJsonBody()
  }
  return body
}
