import { BRAIN_THREAD } from "./brain"
import { type Turn, type TurnCard, appendTurn, findA2UITurn, getTurn, setTurnCard } from "./orchestrator-chat"
import { broadcast as defaultBroadcast } from "../state"
import { orchEmit } from "../wiring/orchestrator"

// Google A2UI v1.0 server-to-client wire contract, BasicCatalog allowlist,
// JSON-pointer state engine, and live WS patch broadcaster.

export const A2UI_VERSION = "1.0" as const
export const A2UI_BASIC_CATALOG_ID = "basic_catalog_1_0" as const

export const A2UI_BASIC_COMPONENTS = [
  "Column",
  "Row",
  "Card",
  "Text",
  "Button",
  "CheckBox",
  "ChoicePicker",
  "Badge",
  "Divider",
  "TextField",
] as const

export type A2UIComponentType = (typeof A2UI_BASIC_COMPONENTS)[number]

const ALLOWED_COMPONENTS = new Set<string>(A2UI_BASIC_COMPONENTS)
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Matches HTML/script tags, HTML comments, inline JS handlers, or javascript: URIs. */
const HTML_OR_SCRIPT_RE = /<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*|\/?)>|<!--|-->|javascript\s*:|\bon(?:error|load|click|mouseover|focus|submit|input|change)\s*=/i

export interface A2UIPathBinding {
  "@path": string
}

export interface A2UIActionSpec {
  name: string
  context?: Record<string, unknown>
}

export interface A2UIComponent {
  id: string
  component: A2UIComponentType
  children?: string[]
  text?: string | A2UIPathBinding
  label?: string | A2UIPathBinding
  variant?: string
  tone?: string
  value?: unknown
  checked?: boolean | A2UIPathBinding
  options?: Array<{ value: string; label: string }>
  multiple?: boolean
  action?: A2UIActionSpec
  disabled?: boolean | A2UIPathBinding
  placeholder?: string
}

export interface A2UICreateSurfacePayload {
  surfaceId: string
  catalogId: string
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
}

export interface A2UIUpdateDataModelPayload {
  surfaceId: string
  path: string
  value: unknown
}

export interface A2UIUpdateComponentsPayload {
  surfaceId: string
  components: A2UIComponent[]
}

export type A2UICreateSurfaceMessage = { version: "1.0"; createSurface: A2UICreateSurfacePayload }
export type A2UIUpdateDataModelMessage = { version: "1.0"; updateDataModel: A2UIUpdateDataModelPayload }
export type A2UIUpdateComponentsMessage = { version: "1.0"; updateComponents: A2UIUpdateComponentsPayload }

export type A2UIMessage =
  | A2UICreateSurfaceMessage
  | A2UIUpdateDataModelMessage
  | A2UIUpdateComponentsMessage

export interface A2UIFrame {
  type: "a2ui"
  threadId: string
  turnId: string
  surfaceId: string
  messages: A2UIMessage[]
}

export interface A2UIActionRequest {
  surfaceId: string
  turnId: string
  action: {
    name: string
    context?: Record<string, unknown>
  }
  actionKey: string
}

export const SURFACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/
export const ACTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
export const ACTION_KEY_RE = /^[\w:.-]{1,128}$/

/** Recursively check any value for HTML/script injection. */
export function containsHtmlOrScript(val: unknown, depth = 0): boolean {
  if (depth > 24) return true
  if (typeof val === "string") return HTML_OR_SCRIPT_RE.test(val)
  if (Array.isArray(val)) return val.some((item) => containsHtmlOrScript(item, depth + 1))
  if (val && typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k) || HTML_OR_SCRIPT_RE.test(k) || containsHtmlOrScript(v, depth + 1)) return true
    }
  }
  return false
}

/** RFC 6901 JSON Pointer parser. Returns path segments or null if invalid/unsafe. */
export function parseJsonPointer(path: string): string[] | null {
  if (typeof path !== "string") return null
  if (path === "") return []
  if (!path.startsWith("/")) return null
  const tokens = path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"))
  if (tokens.some((t) => !t || DANGEROUS_KEYS.has(t))) return null
  return tokens
}

export function isValidJsonPointer(path: string): boolean {
  return parseJsonPointer(path) !== null
}

export function getJsonPointer(root: unknown, path: string): unknown {
  const tokens = parseJsonPointer(path)
  if (!tokens) return undefined
  let cur: unknown = root
  for (const token of tokens) {
    if (!cur || typeof cur !== "object") return undefined
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(token) ? Number(token) : -1
      cur = idx >= 0 && idx < cur.length ? cur[idx] : undefined
    } else {
      cur = (cur as Record<string, unknown>)[token]
    }
  }
  return cur
}

export function setJsonPointer(root: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const tokens = parseJsonPointer(path)
  if (!tokens) throw new Error(`Invalid JSON pointer: ${path}`)
  const clone = structuredClone(root)
  if (tokens.length === 0) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Root updateDataModel requires an object")
    return structuredClone(value as Record<string, unknown>)
  }
  let cur: Record<string, unknown> | unknown[] = clone
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(token) ? Number(token) : -1
      if (idx < 0 || idx >= cur.length || !cur[idx] || typeof cur[idx] !== "object") {
        throw new Error(`Invalid array index in JSON pointer: ${path}`)
      }
      cur = cur[idx] as Record<string, unknown> | unknown[]
    } else {
      const next = cur[token]
      if (!next || typeof next !== "object") {
        cur[token] = {}
      }
      cur = cur[token] as Record<string, unknown> | unknown[]
    }
  }
  const last = tokens[tokens.length - 1]!
  if (Array.isArray(cur)) {
    if (last === "-") cur.push(structuredClone(value))
    else {
      const idx = /^\d+$/.test(last) ? Number(last) : -1
      if (idx < 0 || idx > cur.length) throw new Error(`Invalid array index in JSON pointer: ${path}`)
      cur[idx] = structuredClone(value)
    }
  } else {
    cur[last] = structuredClone(value)
  }
  return clone
}

export function isPathBinding(val: unknown): val is A2UIPathBinding {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false
  const keys = Object.keys(val)
  return keys.length === 1 && keys[0] === "@path" && typeof (val as Record<string, unknown>)["@path"] === "string"
}

/** Resolve any `{ "@path": "/..." }` bindings inside an action context against the surface's dataModel. */
export function resolveA2UIContext(
  context: Record<string, unknown> | undefined,
  dataModel: Record<string, unknown>,
): Record<string, unknown> {
  if (!context || typeof context !== "object" || Array.isArray(context)) return {}
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(context)) {
    if (isPathBinding(v)) {
      resolved[k] = getJsonPointer(dataModel, v["@path"])
    } else {
      resolved[k] = v
    }
  }
  return resolved
}

export function validateA2UIComponent(raw: unknown): { ok: true; component: A2UIComponent } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_component" }
  if (containsHtmlOrScript(raw)) return { ok: false, error: "html_not_allowed" }
  const c = raw as Record<string, unknown>
  const id = typeof c.id === "string" ? c.id.trim() : ""
  if (!id || id.length > 128) return { ok: false, error: "component_id_required" }
  const rawType = typeof c.component === "string" ? c.component.trim() : typeof c.type === "string" ? c.type.trim() : ""
  if (!ALLOWED_COMPONENTS.has(rawType)) return { ok: false, error: `unregistered_component:${rawType || "missing"}` }
  if (c.children !== undefined) {
    if (!Array.isArray(c.children) || !c.children.every((ch) => typeof ch === "string" && ch.trim().length > 0)) {
      return { ok: false, error: "invalid_component_children" }
    }
  }
  if (c.action !== undefined) {
    if (!c.action || typeof c.action !== "object" || Array.isArray(c.action)) return { ok: false, error: "invalid_component_action" }
    const act = c.action as Record<string, unknown>
    if (typeof act.name !== "string" || !ACTION_NAME_RE.test(act.name)) return { ok: false, error: "invalid_action_name" }
    if (act.context !== undefined && (!act.context || typeof act.context !== "object" || Array.isArray(act.context))) {
      return { ok: false, error: "invalid_action_context" }
    }
  }
  if (c.options !== undefined) {
    if (!Array.isArray(c.options) || !c.options.every((o) => o && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string" && typeof (o as Record<string, unknown>).label === "string")) {
      return { ok: false, error: "invalid_component_options" }
    }
  }
  const normalized: A2UIComponent = {
    ...(c as unknown as A2UIComponent),
    id,
    component: rawType as A2UIComponentType,
  }
  delete (normalized as unknown as Record<string, unknown>).type
  return { ok: true, component: normalized }
}

export function validateA2UIMessage(raw: unknown): { ok: true; message: A2UIMessage; surfaceId: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_message" }
  if (containsHtmlOrScript(raw)) return { ok: false, error: "html_not_allowed" }
  const m = raw as Record<string, unknown>
  if (m.version !== A2UI_VERSION) return { ok: false, error: "unsupported_version" }

  const hasCreate = m.createSurface !== undefined
  const hasUpdateData = m.updateDataModel !== undefined
  const hasUpdateComps = m.updateComponents !== undefined
  if (Number(hasCreate) + Number(hasUpdateData) + Number(hasUpdateComps) !== 1) {
    return { ok: false, error: "exactly_one_envelope_required" }
  }

  if (hasCreate) {
    if (!m.createSurface || typeof m.createSurface !== "object" || Array.isArray(m.createSurface)) {
      return { ok: false, error: "invalid_create_surface" }
    }
    const cs = m.createSurface as Record<string, unknown>
    const surfaceId = typeof cs.surfaceId === "string" && SURFACE_ID_RE.test(cs.surfaceId) ? cs.surfaceId : ""
    if (!surfaceId) return { ok: false, error: "invalid_surface_id" }
    const catalogId = typeof cs.catalogId === "string" && cs.catalogId.trim() ? cs.catalogId.trim() : A2UI_BASIC_CATALOG_ID
    if (!Array.isArray(cs.components) || cs.components.length === 0) return { ok: false, error: "components_required" }
    const components: A2UIComponent[] = []
    for (const item of cs.components) {
      const v = validateA2UIComponent(item)
      if (!v.ok) return v
      components.push(v.component)
    }
    const dataModel = cs.dataModel && typeof cs.dataModel === "object" && !Array.isArray(cs.dataModel)
      ? (cs.dataModel as Record<string, unknown>)
      : null
    if (!dataModel) return { ok: false, error: "invalid_data_model" }
    return {
      ok: true,
      surfaceId,
      message: {
        version: A2UI_VERSION,
        createSurface: { surfaceId, catalogId, components, dataModel },
      },
    }
  }

  if (hasUpdateData) {
    if (!m.updateDataModel || typeof m.updateDataModel !== "object" || Array.isArray(m.updateDataModel)) {
      return { ok: false, error: "invalid_update_data_model" }
    }
    const udm = m.updateDataModel as Record<string, unknown>
    const surfaceId = typeof udm.surfaceId === "string" && SURFACE_ID_RE.test(udm.surfaceId) ? udm.surfaceId : ""
    if (!surfaceId) return { ok: false, error: "invalid_surface_id" }
    const path = typeof udm.path === "string" ? udm.path : ""
    if (!isValidJsonPointer(path)) return { ok: false, error: "invalid_json_pointer" }
    if (!("value" in udm)) return { ok: false, error: "value_required" }
    return {
      ok: true,
      surfaceId,
      message: {
        version: A2UI_VERSION,
        updateDataModel: { surfaceId, path, value: udm.value },
      },
    }
  }

  if (!m.updateComponents || typeof m.updateComponents !== "object" || Array.isArray(m.updateComponents)) {
    return { ok: false, error: "invalid_update_components" }
  }
  const uc = m.updateComponents as Record<string, unknown>
  const surfaceId = typeof uc.surfaceId === "string" && SURFACE_ID_RE.test(uc.surfaceId) ? uc.surfaceId : ""
  if (!surfaceId) return { ok: false, error: "invalid_surface_id" }
  if (!Array.isArray(uc.components) || uc.components.length === 0) return { ok: false, error: "components_required" }
  const components: A2UIComponent[] = []
  for (const item of uc.components) {
    const v = validateA2UIComponent(item)
    if (!v.ok) return v
    components.push(v.component)
  }
  return {
    ok: true,
    surfaceId,
    message: {
      version: A2UI_VERSION,
      updateComponents: { surfaceId, components },
    },
  }
}

export function validateA2UIMessages(raw: unknown): { ok: true; messages: A2UIMessage[]; surfaceId: string } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return { ok: false, error: "messages_required" }
  const messages: A2UIMessage[] = []
  let surfaceId = ""
  for (const item of list) {
    const v = validateA2UIMessage(item)
    if (!v.ok) return v
    if (!surfaceId) surfaceId = v.surfaceId
    else if (v.surfaceId !== surfaceId) return { ok: false, error: "surface_id_mismatch" }
    messages.push(v.message)
  }
  return { ok: true, messages, surfaceId }
}

export function validateA2UIActionRequest(raw: unknown): { ok: true; request: A2UIActionRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_json" }
  if (containsHtmlOrScript(raw)) return { ok: false, error: "html_not_allowed" }
  const b = raw as Record<string, unknown>
  const surfaceId = typeof b.surfaceId === "string" && SURFACE_ID_RE.test(b.surfaceId) ? b.surfaceId : ""
  if (!surfaceId) return { ok: false, error: "surfaceId_required" }
  const turnId = typeof b.turnId === "string" && b.turnId.trim() ? b.turnId.trim() : ""
  if (!turnId) return { ok: false, error: "turnId_required" }
  const actionKey = typeof b.actionKey === "string" && ACTION_KEY_RE.test(b.actionKey) ? b.actionKey : ""
  if (!actionKey) return { ok: false, error: "actionKey_required" }
  if (!b.action || typeof b.action !== "object" || Array.isArray(b.action)) return { ok: false, error: "action_required" }
  const act = b.action as Record<string, unknown>
  const name = typeof act.name === "string" && ACTION_NAME_RE.test(act.name) ? act.name : ""
  if (!name) return { ok: false, error: "action_name_required" }
  const context = act.context === undefined
    ? undefined
    : act.context && typeof act.context === "object" && !Array.isArray(act.context)
      ? (act.context as Record<string, unknown>)
      : null
  if (context === null) return { ok: false, error: "invalid_action_context" }
  return {
    ok: true,
    request: {
      surfaceId,
      turnId,
      action: { name, ...(context ? { context } : {}) },
      actionKey,
    },
  }
}

export interface A2UIEngineDeps {
  appendTurn?: typeof appendTurn
  findTurn?: typeof findA2UITurn
  getTurn?: typeof getTurn
  setCard?: typeof setTurnCard
  broadcast?: (frame: Record<string, unknown>) => void
  emitTurn?: (turn: Turn) => void
  /** Optional target turnId so updates mutate and broadcast for an exact turn even when surfaceIds collide. */
  turnId?: string
}

/** Extract the current folded dataModel from an A2UI TurnCard. */
export function getSurfaceDataModel(card: TurnCard): Record<string, unknown> {
  let model: Record<string, unknown> = {}
  for (const msg of card.messages ?? []) {
    if ("createSurface" in msg) {
      model = structuredClone(msg.createSurface.dataModel)
    } else if ("updateDataModel" in msg) {
      model = setJsonPointer(model, msg.updateDataModel.path, msg.updateDataModel.value)
    }
  }
  return model
}

/** Create and broadcast a new A2UI surface turn in the Brain thread. */
export function createSurfaceTurn(
  input: { surfaceId: string; text: string; messages: A2UIMessage[]; threadId?: string },
  deps: A2UIEngineDeps = {},
): Turn {
  const append = deps.appendTurn ?? appendTurn
  const emit = deps.emitTurn ?? orchEmit
  const card: TurnCard = {
    kind: "a2ui",
    source: "app",
    surfaceId: input.surfaceId,
    messages: input.messages,
  }
  const turn = append("orchestrator", input.text, null, input.threadId ?? BRAIN_THREAD, card)
  emit(turn)
  return turn
}

/**
 * Fold a JSON-pointer updateDataModel patch directly into the persisted SQLite TurnCard
 * and broadcast a live `{ type: "a2ui" }` WS frame to connected clients.
 */
export function updateSurfaceData(
  surfaceId: string,
  path: string,
  value: unknown,
  deps: A2UIEngineDeps = {},
): { ok: true; turn: Turn; frame: A2UIFrame } | { ok: false; status: number; error: string } {
  if (!SURFACE_ID_RE.test(surfaceId)) return { ok: false, status: 400, error: "invalid_surface_id" }
  if (!isValidJsonPointer(path)) return { ok: false, status: 400, error: "invalid_json_pointer" }
  if (containsHtmlOrScript(value)) return { ok: false, status: 400, error: "html_not_allowed" }

  const find = deps.findTurn ?? findA2UITurn
  const get = deps.getTurn ?? getTurn
  const setCard = deps.setCard ?? setTurnCard
  const bcast = deps.broadcast ?? defaultBroadcast

  const byTurnId = deps.turnId ? get(deps.turnId) : null
  const existing = deps.turnId
    ? (byTurnId && byTurnId.card?.kind === "a2ui" && byTurnId.card.surfaceId === surfaceId ? byTurnId : null)
    : find(surfaceId)
  if (!existing || existing.card?.kind !== "a2ui") {
    return { ok: false, status: 404, error: "surface_not_found" }
  }

  const messages = structuredClone(existing.card.messages ?? [])
  const createMsg = messages.find((m): m is A2UICreateSurfaceMessage => "createSurface" in m)
  try {
    if (createMsg) {
      createMsg.createSurface.dataModel = setJsonPointer(createMsg.createSurface.dataModel, path, value)
    } else {
      messages.push({ version: A2UI_VERSION, updateDataModel: { surfaceId, path, value: structuredClone(value) } })
    }
  } catch {
    return { ok: false, status: 400, error: "invalid_json_pointer_target" }
  }

  const updated = setCard(existing.id, { messages }) ?? { ...existing, card: { ...existing.card, messages } }
  const patchMsg: A2UIUpdateDataModelMessage = {
    version: A2UI_VERSION,
    updateDataModel: { surfaceId, path, value },
  }
  const frame: A2UIFrame = {
    type: "a2ui",
    threadId: updated.threadId,
    turnId: updated.id,
    surfaceId,
    messages: [patchMsg],
  }
  bcast(frame as unknown as Record<string, unknown>)
  return { ok: true, turn: updated, frame }
}

/**
 * Fold an updateComponents patch directly into the persisted SQLite TurnCard
 * and broadcast a live `{ type: "a2ui" }` WS frame to connected clients.
 */
export function updateSurfaceComponents(
  surfaceId: string,
  components: A2UIComponent[],
  deps: A2UIEngineDeps = {},
): { ok: true; turn: Turn; frame: A2UIFrame } | { ok: false; status: number; error: string } {
  if (!SURFACE_ID_RE.test(surfaceId)) return { ok: false, status: 400, error: "invalid_surface_id" }
  if (!Array.isArray(components) || components.length === 0) return { ok: false, status: 400, error: "components_required" }
  const validated: A2UIComponent[] = []
  for (const item of components) {
    const v = validateA2UIComponent(item)
    if (!v.ok) return { ok: false, status: 400, error: v.error }
    validated.push(v.component)
  }

  const find = deps.findTurn ?? findA2UITurn
  const get = deps.getTurn ?? getTurn
  const setCard = deps.setCard ?? setTurnCard
  const bcast = deps.broadcast ?? defaultBroadcast

  const byTurnId = deps.turnId ? get(deps.turnId) : null
  const existing = deps.turnId
    ? (byTurnId && byTurnId.card?.kind === "a2ui" && byTurnId.card.surfaceId === surfaceId ? byTurnId : null)
    : find(surfaceId)
  if (!existing || existing.card?.kind !== "a2ui") {
    return { ok: false, status: 404, error: "surface_not_found" }
  }

  const messages = structuredClone(existing.card.messages ?? [])
  const createMsg = messages.find((m): m is A2UICreateSurfaceMessage => "createSurface" in m)
  if (createMsg) {
    const cs = createMsg.createSurface
    for (const comp of validated) {
      const idx = cs.components.findIndex((c: A2UIComponent) => c.id === comp.id)
      if (idx >= 0) cs.components[idx] = comp
      else cs.components.push(comp)
    }
  } else {
    messages.push({ version: A2UI_VERSION, updateComponents: { surfaceId, components: validated } })
  }

  const updated = setCard(existing.id, { messages }) ?? { ...existing, card: { ...existing.card, messages } }
  const patchMsg: A2UIUpdateComponentsMessage = {
    version: A2UI_VERSION,
    updateComponents: { surfaceId, components: validated },
  }
  const frame: A2UIFrame = {
    type: "a2ui",
    threadId: updated.threadId,
    turnId: updated.id,
    surfaceId,
    messages: [patchMsg],
  }
  bcast(frame as unknown as Record<string, unknown>)
  return { ok: true, turn: updated, frame }
}
