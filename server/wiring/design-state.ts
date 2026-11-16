import { mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { type DesignStatePatch, type DesignStateService, type DesignStateSnapshot, createDesignStateService, registerActiveDesignPromptProvider, withDesignStatePrompt } from "../lib/design-state"
import { broadcast } from "../state"

let service: DesignStateService | null = null
let activeForHooks = false
let unsub: (() => void) | null = null

function defaultStateDir(): string {
  if (process.env.COMPANION_DESIGN_STATE_DIR) return process.env.COMPANION_DESIGN_STATE_DIR
  if (process.env.NODE_ENV === "test") return mkdtempSync(join(tmpdir(), "cc-design-state-"))
  return join(homedir(), ".claude-companion")
}

function getService(): DesignStateService {
  if (!service) {
    service = createDesignStateService({ stateDir: defaultStateDir() })
    unsub = service.onChange((state) => {
      broadcast({ type: "design_state", state })
    })
  }
  return service
}

function ensureActive(): DesignStateService {
  activeForHooks = true
  const svc = getService()
  registerActiveDesignPromptProvider(() => (activeForHooks ? svc.promptContext(420) : ""))
  return svc
}

export function startDesignStateWatcher(): void {
  ensureActive().start()
}

export function stopDesignStateWatcher(): void {
  activeForHooks = false
  registerActiveDesignPromptProvider(null)
  service?.stop()
  unsub?.()
  unsub = null
}

export function getDesignStateSnapshot(): DesignStateSnapshot {
  return getService().snapshot()
}

export function designStateSnapshotFrame(): { type: "design_state"; state: DesignStateSnapshot } | null {
  if (!activeForHooks) return null
  try {
    const state = getService().snapshot()
    if (!state.activeFile && !state.pickedDirection && state.availableFiles.length === 0 && state.updatedAt === 0) {
      return null
    }
    return { type: "design_state", state }
  } catch {
    return null
  }
}

export async function refreshDesignState(opts?: { probeMcp?: boolean }): Promise<DesignStateSnapshot> {
  return ensureActive().refresh(opts)
}

export async function updateDesignState(patch: DesignStatePatch): Promise<DesignStateSnapshot> {
  return ensureActive().update(patch)
}

export async function syncDesignStateFromCanvasPick(node: { id: string; kind: string; ref: string; data: Record<string, unknown> }): Promise<DesignStateSnapshot> {
  return ensureActive().syncCanvasPick(node)
}

export function designStateHookContext(maxChars = 420): string {
  if (!activeForHooks) return ""
  try {
    return getService().promptContext(maxChars)
  } catch {
    return ""
  }
}

export function appendDesignStatePrompt(prompt: string, maxChars = 420): string {
  if (!activeForHooks) return prompt
  try {
    return withDesignStatePrompt(prompt, getService().snapshot(), maxChars)
  } catch {
    return prompt
  }
}

export async function renderFigcraftNodePreview(opts: { file?: string; nodeId?: string; scale?: number }) {
  return getService().renderPreview(opts)
}

export async function exportDesignTokens() {
  activeForHooks = true
  return getService().exportTokens()
}
