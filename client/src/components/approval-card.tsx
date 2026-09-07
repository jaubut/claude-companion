import type { ApprovalRequest, Session } from "@/hooks/use-companion"
import { SessionBadge } from "@/components/session-badge"
import { TOOL_ICONS, getToolSummary } from "@/lib/tool-summary"
import { Terminal, X, Check } from "lucide-react"

export function ApprovalCard({
  request,
  sessions,
  onApprove,
  onDeny,
}: {
  request: ApprovalRequest
  sessions: Session[]
  onApprove: (id: string) => void
  onDeny: (id: string) => void
}) {
  const Icon = TOOL_ICONS[request.tool] ?? Terminal
  const summary = getToolSummary(request.tool, request.input)
  const session = request.cwd ? sessions.find(s => s.cwd === request.cwd) : undefined

  return (
    <div className="shrink-0 px-5 pt-2">
      <div className="w-full flex flex-col glass-card border border-accent/20">
        <div className="flex flex-col px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 mb-3">
            {session && <SessionBadge session={session} />}
            <span className="text-[10px] uppercase tracking-wider text-accent/80 font-semibold">approval needed</span>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-accent-dim flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5 text-accent" />
            </div>
            <span className="text-[18px] font-bold tracking-tight text-fg">{request.tool}</span>
          </div>
          {summary && (
            <div className="text-[12px] font-mono text-muted leading-relaxed whitespace-pre-wrap break-all max-h-[22dvh] overflow-y-auto">
              {summary}
            </div>
          )}
        </div>

        <div className="flex gap-2 px-3 pb-3">
          <button
            onClick={() => onDeny(request.id)}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-red/8 text-red font-semibold text-sm active:scale-[0.97] transition-transform"
          >
            <X className="w-4 h-4" strokeWidth={2.5} />
            Deny
          </button>
          <button
            onClick={() => onApprove(request.id)}
            className="flex-[2] flex items-center justify-center gap-2 py-3 rounded-xl bg-green/10 text-green font-semibold text-sm active:scale-[0.97] transition-transform"
          >
            <Check className="w-4 h-4" strokeWidth={2.5} />
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
