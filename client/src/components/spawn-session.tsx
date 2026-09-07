import { useState } from "react"
import type { Session } from "@/hooks/use-companion"

const DEFAULT_SPAWN_CWDS = [
  "~/Cherrypik",
  "~/tls-dashboard-v2",
  "~/claude-companion",
  "~/tls-vault",
  "~",
]

async function spawnClaudeSession(cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/spawn-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    })
    const data = await res.json()
    return res.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function SpawnSession({ sessions }: { sessions: Session[] }) {
  const [spawning, setSpawning] = useState(false)
  const [spawnCwd, setSpawnCwd] = useState("")
  const [spawnBusy, setSpawnBusy] = useState(false)
  const [spawnError, setSpawnError] = useState("")

  // Recent cwds derived from the session list, deduped + sorted by lastSeen.
  const recentCwds = Array.from(new Map(
    [...sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(s => [s.cwd, s.cwd]),
  ).keys()).filter(Boolean)
  const spawnSuggestions = Array.from(new Set([...recentCwds, ...DEFAULT_SPAWN_CWDS]))

  async function doSpawn(cwd: string): Promise<void> {
    setSpawnError("")
    setSpawnBusy(true)
    const r = await spawnClaudeSession(cwd)
    setSpawnBusy(false)
    if (!r.ok) { setSpawnError(r.error ?? "failed"); return }
    setSpawning(false)
    setSpawnCwd("")
  }

  return (
    <>
      <button
        onClick={() => { setSpawning(v => !v); setSpawnError("") }}
        className="w-full text-left px-3 py-3 min-h-[44px] rounded-lg text-[12px] flex items-center gap-2 text-fg hover:bg-fg/5 active:scale-[0.98]"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 shrink-0" />
        <span className="font-semibold">+ New Claude session</span>
        <span className="text-muted/60 text-[11px]">opens a new Terminal window on the Mac</span>
      </button>
      {spawning && (
        <div className="px-2 py-2 space-y-1">
          <div className="flex gap-1">
            <input
              type="text"
              value={spawnCwd}
              onChange={(e) => setSpawnCwd(e.target.value)}
              placeholder="~/path/to/project or /absolute/path"
              className="flex-1 bg-transparent border border-fg/10 rounded-md px-3 py-2 text-[12px] font-mono text-fg placeholder:text-muted/40 focus:outline-none focus:border-fg/30"
            />
            <button
              onClick={() => doSpawn(spawnCwd)}
              disabled={spawnBusy || !spawnCwd.trim()}
              className="px-3 py-2 text-[11px] font-semibold rounded-md bg-accent text-bg disabled:opacity-30 active:scale-95"
            >
              {spawnBusy ? "…" : "Spawn"}
            </button>
          </div>
          {spawnError && (
            <p className="text-[11px] text-red px-1">{spawnError}</p>
          )}
          <div className="space-y-0.5 pt-1">
            {spawnSuggestions.slice(0, 8).map((cwd) => (
              <button
                key={cwd}
                onClick={() => doSpawn(cwd)}
                disabled={spawnBusy}
                className="w-full text-left px-3 py-2 min-h-[40px] rounded-md text-[11px] font-mono text-muted/80 hover:bg-fg/5 hover:text-fg active:scale-[0.98] disabled:opacity-40"
              >
                {cwd}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
