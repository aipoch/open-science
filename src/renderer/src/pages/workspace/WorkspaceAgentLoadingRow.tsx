import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { OpenScienceThinkingIndicator } from '@/components/OpenScienceThinkingIndicator'
import { MessageScrollerItem } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import { useSessionStore } from '@/stores/session-store'
import { isTerminalProvisionPhase } from '../../../../shared/notebook-env'
import { getAgentThinkingStartedAt, type AgentLoadingPhase } from './agent-loading-message'
import { provisionProgressText } from './provision-progress-text'

type WorkspaceAgentLoadingRowProps = {
  sessionId: string
  phase: Exclude<AgentLoadingPhase, 'hidden'> | 'resuming'
  agentStatus?: string
  visiblePermissionPending?: boolean
}

type AgentLoadingIndicatorProps = Omit<WorkspaceAgentLoadingRowProps, 'sessionId'> & {
  sessionId?: string
}

const assistantMessageSurfaceClassName =
  'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'

// Formats an elapsed millisecond span as M:SS.
const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const ThinkingLoadingContent = ({
  sessionId,
  agentStatus
}: {
  sessionId?: string
  agentStatus?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const session = useSessionStore((state) =>
    sessionId ? state.sessions.find((candidate) => candidate.id === sessionId) : undefined
  )
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  // Tick once a second so the elapsed label stays live while the turn runs.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [])

  const elapsedMs = now - (getAgentThinkingStartedAt(session) ?? mountedAt)

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-text-000/70">
        <OpenScienceThinkingIndicator />
        <span>{t('Thinking')}</span>
        <span className="tabular-nums" aria-hidden="true">
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      {(agentStatus ?? session?.agentStatus) ? (
        <span
          className="truncate text-[11px] text-text-000/70"
          title={agentStatus ?? session?.agentStatus}
        >
          {agentStatus ?? session?.agentStatus}
        </span>
      ) : null}
    </>
  )
}

// The row remains present for every non-text phase, with phase-specific detail kept intentionally
// small so tool cards remain the primary source of execution progress.
const AgentLoadingIndicator = ({
  sessionId,
  phase,
  agentStatus,
  visiblePermissionPending = false
}: AgentLoadingIndicatorProps): React.JSX.Element => {
  const { t } = useTranslation()
  const environmentProgress = useNotebookEnvStore((state) => {
    const progress = state.progress
    return sessionId &&
      progress?.sessionId === sessionId &&
      !isTerminalProvisionPhase(progress.phase)
      ? progress
      : undefined
  })

  return (
    <div className="flex min-h-5 flex-col gap-1" role="status" aria-live="polite">
      {environmentProgress && !visiblePermissionPending && phase !== 'waiting-for-response' ? (
        <div className="flex items-center gap-2 text-xs text-text-000/70">
          <OpenScienceThinkingIndicator />
          <span>{provisionProgressText(t, environmentProgress.event)}</span>
          <span className="tabular-nums" aria-hidden="true">
            {Math.round(environmentProgress.progress * 100)}%
          </span>
        </div>
      ) : phase === 'thinking' ? (
        <ThinkingLoadingContent sessionId={sessionId} agentStatus={agentStatus} />
      ) : (
        <div className="flex items-center gap-2 text-xs text-text-000/70">
          <OpenScienceThinkingIndicator />
          <span>
            {phase === 'resuming'
              ? t('Resuming session')
              : phase === 'waiting-for-approval'
                ? t('Waiting for your approval')
                : phase === 'waiting-for-response'
                  ? t('Waiting for your response')
                  : t('Interacting with tools')}
          </span>
        </div>
      )}
    </div>
  )
}

// Places the loading indicator in the same transcript geometry as assistant messages.
const WorkspaceAgentLoadingRow = ({
  sessionId,
  phase,
  agentStatus,
  visiblePermissionPending
}: WorkspaceAgentLoadingRowProps): React.JSX.Element => (
  <MessageScrollerItem
    key={`${sessionId}-agent-loading`}
    messageId={`${sessionId}-agent-loading`}
    className="min-w-0"
  >
    <div className="px-4 pb-1 pt-5 md:px-6">
      <div className={cn(assistantMessageSurfaceClassName, 'px-0 py-2')}>
        <AgentLoadingIndicator
          sessionId={sessionId}
          phase={phase}
          agentStatus={agentStatus}
          visiblePermissionPending={visiblePermissionPending}
        />
      </div>
    </div>
  </MessageScrollerItem>
)

// AgentLoadingIndicator is exported for unit tests because the row shell needs MessageScroller
// context, while phase content and timer behavior can be validated independently.
export { AgentLoadingIndicator, WorkspaceAgentLoadingRow }
