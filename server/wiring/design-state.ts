import { registerActiveDesignPromptProvider } from "../lib/design-state"

// FigCraft is retired (canvas-strip S1, 2026-11-18): no watcher, no design_state frame, and no
// "[Active Design State]" in any prompt. The names stay so the S2 callers compile until S2 deletes them.

export function startDesignStateWatcher(): void {
  registerActiveDesignPromptProvider(null)
}

export function stopDesignStateWatcher(): void {
  registerActiveDesignPromptProvider(null)
}

export function designStateSnapshotFrame(): null {
  return null
}

export async function syncDesignStateFromCanvasPick(_node: { id: string; kind: string; ref: string; data: Record<string, unknown> }): Promise<void> {}

export function designStateHookContext(_maxChars = 420): string {
  return ""
}

export function appendDesignStatePrompt(prompt: string, _maxChars = 420): string {
  return prompt
}
