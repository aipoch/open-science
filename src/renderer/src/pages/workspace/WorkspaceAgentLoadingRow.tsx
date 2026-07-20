import { useEffect, useState } from 'react'

import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'

type WorkspaceAgentLoadingRowProps = {
  sessionId: string
}

const assistantMessageSurfaceClassName =
  'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'

// Past this, a silent turn is likely waiting on something slow (a retrying/backing-off model request),
// so we add a gentle hint rather than leaving the user staring at a bare spinner.
const SLOW_HINT_AFTER_MS = 20_000

// Formats an elapsed millisecond span as M:SS.
const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const AgentLoadingDots = (): React.JSX.Element => (
  <span className="flex items-center gap-1.5" aria-hidden="true">
    <span className="size-1.5 animate-pulse rounded-full bg-text-300 opacity-80" />
    <span className="size-1.5 animate-pulse rounded-full bg-text-300 opacity-80 [animation-delay:150ms]" />
    <span className="size-1.5 animate-pulse rounded-full bg-text-300 opacity-80 [animation-delay:300ms]" />
  </span>
)

// Interim assistant row shown before the first streamed chunk. Beyond the bare animated dots it shows
// how long the turn has been running (ticking) and the latest agent status line when one exists, so a
// long wait reads as "still working" instead of a frozen spinner.
const AgentLoadingIndicator = ({ sessionId }: WorkspaceAgentLoadingRowProps): React.JSX.Element => {
  const startedAt = useSessionStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.activeRun?.startedAt
  )
  const status = useSessionStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.agentStatus
  )
  const [now, setNow] = useState(() => Date.now())

  // Tick once a second so the elapsed label stays live while the turn runs.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [])

  const elapsedMs = startedAt ? now - startedAt : 0
  const slow = elapsedMs >= SLOW_HINT_AFTER_MS

  return (
    <div className="flex min-h-5 flex-col gap-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-text-300">
        <span className="sr-only">Agent is responding</span>
        <AgentLoadingDots />
        {startedAt ? (
          <span className="tabular-nums" aria-hidden="true">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
        {slow ? <span aria-hidden="true">· taking longer than usual</span> : null}
      </div>
      {status ? (
        <span className="truncate text-[11px] text-text-300/80" title={status}>
          {status}
        </span>
      ) : null}
    </div>
  )
}

// Places the loading indicator in the same transcript geometry as assistant messages.
const WorkspaceAgentLoadingRow = ({
  sessionId
}: WorkspaceAgentLoadingRowProps): React.JSX.Element => (
  <MessageScrollerItem
    key={`${sessionId}-agent-loading`}
    messageId={`${sessionId}-agent-loading`}
    className="min-w-0"
  >
    <div className="px-4 pb-1 pt-5 md:px-6">
      <div className={cn(assistantMessageSurfaceClassName, 'rounded-2xl bg-bg-200 px-3 py-2')}>
        <AgentLoadingIndicator sessionId={sessionId} />
      </div>
    </div>
  </MessageScrollerItem>
)

// AgentLoadingIndicator is exported for unit tests (WorkspaceAgentLoadingRow needs a MessageScroller
// context, whereas the elapsed/status logic under test lives entirely in the indicator).
export { AgentLoadingIndicator, WorkspaceAgentLoadingRow }
