import type { SafeParseResult } from "./feature-flags"
import type { DynamicSkillRegistry } from "./skill-retrieval"
import { LoadSkillInputSchema, executeLoadSkill, loadSkillToolDefinition } from "./skill-tools"

export const MAX_TOOL_SCHEMA_RETRIES = 2

export interface ToolSchema<T> {
  safeParse(input: unknown): SafeParseResult<T>
}

export type InferToolSchema<S> = S extends ToolSchema<infer T> ? T : never

export interface ToolExecutionResult {
  success: boolean
  output: string
  isSchemaValidationError?: boolean
}

export interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface NativeToolDefinition<T> {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
  schema: ToolSchema<T>
  handler: (args: T) => Promise<string> | string
}

export interface ExecutableNativeTool {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
  execute(rawArgs: unknown): Promise<ToolExecutionResult>
}

export function defineNativeTool<T>(def: NativeToolDefinition<T>): ExecutableNativeTool {
  return {
    name: def.name,
    description: def.description,
    parametersJsonSchema: def.parametersJsonSchema,
    execute: (rawArgs: unknown) => executeNativeTool(def.schema, rawArgs, def.handler),
  }
}

/**
 * Spec §4 Native Tool Invocation & Zod-Compatible Self-Correction Guard.
 * Validates raw model-supplied arguments before handler execution and formats schema errors
 * into a structured self-correction prompt rather than throwing or crashing with exit code 1.
 */
export async function executeNativeTool<S extends ToolSchema<unknown>>(
  schema: S,
  rawArgs: unknown,
  handler: (args: InferToolSchema<S>) => Promise<string> | string,
): Promise<ToolExecutionResult> {
  const parseResult = schema.safeParse(rawArgs)

  if (!parseResult.success) {
    const formattedError = parseResult.error.issues
      .map((i) => `Field '${i.path.join(".")}': ${i.message}`)
      .join("; ")

    return {
      success: false,
      isSchemaValidationError: true,
      output: `[TOOL_SCHEMA_VALIDATION_ERROR]: Invalid parameters provided. Details: ${formattedError}. Please correct the parameters and retry.`,
    }
  }

  try {
    const result = await handler(parseResult.data as InferToolSchema<S>)
    return { success: true, output: result }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: `[TOOL_EXECUTION_ERROR]: ${msg}` }
  }
}

export interface FieldRule {
  type: "string" | "number" | "boolean"
  description?: string
  required?: boolean
  minLength?: number
  maxLength?: number
  enum?: readonly string[]
  pattern?: RegExp
}

/**
 * Lightweight zero-dependency object schema builder producing both a Zod-compatible `ToolSchema<T>`
 * and a Gemini Function Calling `parameters` JSON Schema object.
 */
export function defineObjectToolSchema<T extends Record<string, unknown>>(
  fields: Record<keyof T & string, FieldRule>,
): { schema: ToolSchema<T>; jsonSchema: Record<string, unknown> } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, rule] of Object.entries(fields)) {
    const prop: Record<string, unknown> = { type: rule.type }
    if (rule.description) prop.description = rule.description
    if (rule.enum) prop.enum = [...rule.enum]
    properties[key] = prop
    if (rule.required !== false) required.push(key)
  }

  const jsonSchema: Record<string, unknown> = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  }

  const schema: ToolSchema<T> = {
    safeParse(input: unknown): SafeParseResult<T> {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {
          success: false,
          error: { issues: [{ path: ["root"], message: "Expected an object with tool arguments" }] },
        }
      }
      const record = input as Record<string, unknown>
      const issues: Array<{ path: string[]; message: string }> = []
      const out: Record<string, unknown> = {}

      for (const [key, rule] of Object.entries(fields)) {
        const val = record[key]
        if (val === undefined || val === null) {
          if (rule.required !== false) {
            issues.push({ path: [key], message: "Required field is missing" })
          }
          continue
        }
        if (typeof val !== rule.type) {
          issues.push({ path: [key], message: `Expected ${rule.type}, received ${typeof val}` })
          continue
        }
        if (rule.type === "string" && typeof val === "string") {
          if (rule.minLength !== undefined && val.trim().length < rule.minLength) {
            issues.push({ path: [key], message: `Must be at least ${rule.minLength} character(s)` })
            continue
          }
          if (rule.maxLength !== undefined && val.length > rule.maxLength) {
            issues.push({ path: [key], message: `Must be at most ${rule.maxLength} characters` })
            continue
          }
          if (rule.enum && !rule.enum.includes(val)) {
            issues.push({ path: [key], message: `Must be one of: ${rule.enum.join(", ")}` })
            continue
          }
          if (rule.pattern && !rule.pattern.test(val)) {
            issues.push({ path: [key], message: "Invalid format" })
            continue
          }
        }
        if (rule.type === "number" && typeof val === "number" && !Number.isFinite(val)) {
          issues.push({ path: [key], message: "Must be a finite number" })
          continue
        }
        out[key] = val
      }

      if (issues.length > 0) {
        return { success: false, error: { issues } }
      }
      return { success: true, data: out as T }
    },
  }

  return { schema, jsonSchema }
}

/** Convert registered native tools into Gemini 4 `tools: [{ functionDeclarations }]` format. */
export function buildGeminiFunctionDeclarations(
  tools: ReadonlyArray<Pick<ExecutableNativeTool, "name" | "description" | "parametersJsonSchema">>,
): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: "object",
      ...(t.parametersJsonSchema.properties ? { properties: t.parametersJsonSchema.properties } : {}),
      ...(Array.isArray(t.parametersJsonSchema.required) ? { required: t.parametersJsonSchema.required } : {}),
    },
  }))
}

/** Create a native Gemini 4 `load_skill` tool definition backed by a `DynamicSkillRegistry`. */
export function createNativeLoadSkillTool(registry: DynamicSkillRegistry): ExecutableNativeTool {
  return defineNativeTool({
    name: loadSkillToolDefinition.name,
    description: loadSkillToolDefinition.description,
    parametersJsonSchema: loadSkillToolDefinition.jsonSchema,
    schema: LoadSkillInputSchema,
    handler: async (args) => {
      const res = executeLoadSkill(registry, args)
      return res.output
    },
  })
}
