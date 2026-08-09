import { useEffect, useState } from 'react'

import { OpenScienceThinkingIndicator } from '@/components/OpenScienceThinkingIndicator'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/session-store'
import { getAgentThinkingStartedAt, type AgentLoadingPhase } from './agent-loading-message'

type WorkspaceAgentLoadingRowProps = {
  sessionId: string
  phase: Exclude<AgentLoadingPhase, 'hidden'> | 'resuming'
}

const assistantMessageSurfaceClassName =
  'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'

// Past this, the current visible wait is likely stalled on something slow, so we add a gentle hint
// rather than leaving the user staring at a bare spinner.
const SLOW_HINT_AFTER_MS = 20_000

// Formats an elapsed millisecond span as M:SS.
const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const ThinkingLoadingContent = ({ sessionId }: { sessionId: string }): React.JSX.Element => {
  const session = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)
  )
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  // Tick once a second so the elapsed label stays live while the turn runs.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [])

  const elapsedMs = now - (getAgentThinkingStartedAt(session) ?? mountedAt)
  const slow = elapsedMs >= SLOW_HINT_AFTER_MS

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-text-000/70">
        <OpenScienceThinkingIndicator />
        <span>Thinking</span>
        <span className="tabular-nums" aria-hidden="true">
          {formatElapsed(elapsedMs)}
        </span>
        {slow ? <span aria-hidden="true">· taking longer than usual</span> : null}
      </div>
      {session?.agentStatus ? (
        <span className="truncate text-[11px] text-text-000/70" title={session.agentStatus}>
          {session.agentStatus}
        </span>
      ) : null}
    </>
  )
}

// The row remains present for every non-text phase, with phase-specific detail kept intentionally
// small so tool cards remain the primary source of execution progress.
const AgentLoadingIndicator = ({
  sessionId,
  phase
}: WorkspaceAgentLoadingRowProps): React.JSX.Element => {
  return (
    <div className="flex min-h-5 flex-col gap-1" role="status" aria-live="polite">
      {phase === 'thinking' ? (
        <ThinkingLoadingContent sessionId={sessionId} />
      ) : (
        <div className="flex items-center gap-2 text-xs text-text-000/70">
          <OpenScienceThinkingIndicator />
          <span>{phase === 'resuming' ? 'Resuming session' : 'Interacting with tools'}</span>
        </div>
      )}
    </div>
  )
}

// Places the loading indicator in the same transcript geometry as assistant messages.
const WorkspaceAgentLoadingRow = ({
  sessionId,
  phase
}: WorkspaceAgentLoadingRowProps): React.JSX.Element => (
  <MessageScrollerItem
    key={`${sessionId}-agent-loading`}
    messageId={`${sessionId}-agent-loading`}
    className="min-w-0"
  >
    <div className="px-4 pb-1 pt-5 md:px-6">
      <div className={cn(assistantMessageSurfaceClassName, 'px-0 py-2')}>
        <AgentLoadingIndicator sessionId={sessionId} phase={phase} />
      </div>
    </div>
  </MessageScrollerItem>
)

// AgentLoadingIndicator is exported for unit tests because the row shell needs MessageScroller
// context, while phase content and timer behavior can be validated independently.
export { AgentLoadingIndicator, WorkspaceAgentLoadingRow }
