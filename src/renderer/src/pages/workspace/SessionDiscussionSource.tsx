import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { composerContextRowClassName, SessionDiscussionBar } from './SessionDiscussionBar'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createSessionReplayItem } from './workspace-session-actions'
import { requestReplaySeek } from './replay/replay-context'
import type { SessionRuntimeContext } from '../../../../shared/session-runtime-context'
import { sessionReadingPositions } from '../../../../shared/session-reading'

type ReadingAction = { sourceSessionId: string; contextId?: string }

export const SessionDiscussionSource = ({
  projectId,
  sessionId,
  context
}: {
  projectId: string
  sessionId: string
  context?: SessionRuntimeContext
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [error, setError] = useState<ReadingAction>()
  const [pending, setPending] = useState<ReadingAction>()
  const bindings = context?.sessionContext?.bindings ?? []
  const binding = bindings.at(-1)
  if (!binding) return null
  const act = async (action: ReadingAction): Promise<void> => {
    const binding = bindings.find((row) => row.sessionId === action.sourceSessionId)
    if (!binding || !context || pending) return
    setPending(action)
    setError(undefined)
    try {
      if (!action.contextId) {
        await window.api.sessionReplay.unlinkSession({
          projectId,
          sessionId,
          sourceSessionId: binding.sessionId,
          expectedRevision: context.revision
        })
      } else {
        const snapshot = await window.api.sessionReplay.getSelectionSnapshot({
          projectId: binding.projectId,
          id: action.contextId
        })
        if (!snapshot) throw new Error('Source unavailable')
        if (
          useNavigationStore.getState().activeProjectId !== projectId ||
          useSessionStore.getState().selectedSessionId !== sessionId
        )
          return
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(
            createSessionReplayItem(binding.projectId, binding.sessionId, binding.title, projectId)
          )
        requestReplaySeek({ ...snapshot, stepOffsetMs: snapshot.stepOffsetMs ?? 0 })
      }
    } catch {
      setError(action)
    } finally {
      setPending(undefined)
    }
  }
  return (
    <div data-testid="session-discussion-source" className="min-w-0" aria-busy={Boolean(pending)}>
      <div className={composerContextRowClassName}>
        <SessionDiscussionBar
          scope={binding.scope}
          title={binding.title}
          steps={sessionReadingPositions(binding).map((position) => ({
            id: position.contextId,
            title: position.stepTitle ?? binding.title,
            branchIndex: position.branchIndex,
            stepNumber: position.stepNumber
          }))}
          disabled={Boolean(pending)}
          pending={Boolean(pending)}
          onReveal={(contextId) => void act({ sourceSessionId: binding.sessionId, contextId })}
          onRemove={() => void act({ sourceSessionId: binding.sessionId })}
          removeLabel={t('Unlink Session')}
          removeHint={t('Stop future reading. Sent messages are kept.')}
        />
      </div>
      {pending ? (
        <span role="status" className="sr-only">
          {t('Loading…')}
        </span>
      ) : null}
      {error ? (
        <div className="mt-2 border-b border-border-200 pb-2">
          <ErrorNotice
            inline
            tone="amber"
            description={
              error.contextId
                ? t('Could not open this source. Retry or unlink the Session.')
                : t('Could not unlink the Session. Please retry.')
            }
            primaryButton={{
              label: t('Retry'),
              disabled: Boolean(pending),
              onClick: () => void act(error)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
