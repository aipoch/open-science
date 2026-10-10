import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import type { ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import type { WorkspaceConversationController } from './workspace-conversation-controller'
import { researchIdentity } from './research-draft-identity'
import {
  ResearchRunLauncher,
  ResearchRunStatus,
  type ResearchRunLaunchSelection
} from './ResearchRunLauncher'
import { buildResearchRunRequest, researchRunSelectionMatches } from './research-run-request'
import { useResearchRunObserver } from './use-research-run-observer'

type Options = {
  source?: ResearchMembership
  activeSession?: ChatSession
  currentDraftKey: string
  conversation: WorkspaceConversationController
}

/** Lives at WorkspacePage, above the conversation panel's source -> discussion remount. */
export const useResearchRunLauncher = (options: Options): React.ReactNode => {
  const { t } = useTranslation()
  const { source, activeSession, conversation } = options
  const current = useRef(options)
  useLayoutEffect(() => {
    current.current = options
  }, [options])
  const pending = useRef(false)
  const observer = useResearchRunObserver({ source, title: t('Observe run') })
  const inProgress =
    observer.request?.stage === 'preparing' || observer.request?.stage === 'running'
  const blockedReason =
    !conversation.availability.researchRun || inProgress
      ? t(
          'This discussion cannot start a run yet. Finish the current task or check the Agent configuration.'
        )
      : undefined
  const start = async ({ inspection, plan }: ResearchRunLaunchSelection): Promise<void> => {
    if (!source || pending.current || blockedReason) {
      throw new Error(
        t(
          'This discussion cannot start a run yet. Finish the current task or check the Agent configuration.'
        )
      )
    }
    pending.current = true
    const origin = current.current
    const revision = useNavigationStore.getState().explicitNavigationRevision
    const requestId = crypto.randomUUID()
    let begun = false
    try {
      const fresh = await window.api.researchRuns
        .inspect({
          projectId: source.sourceProjectId,
          sourceSessionId: source.sourceSessionId,
          sourceImportId: source.sourceImportId,
          descriptorVersionId: inspection.descriptor?.versionId,
          expectedSourceIdentity: inspection.source.identity
        })
        .catch(() => {
          throw new Error(t('Could not inspect this research. Please retry.'))
        })
      const latest = current.current
      if (
        !latest.source ||
        researchIdentity(latest.source) !== researchIdentity(source) ||
        latest.currentDraftKey !== origin.currentDraftKey ||
        latest.activeSession?.id !== origin.activeSession?.id ||
        useNavigationStore.getState().explicitNavigationRevision !== revision
      )
        throw new Error(t('The research or destination changed. Open Run again.'))
      if (!researchRunSelectionMatches(source, inspection, plan, fresh))
        throw new Error(t('The selected plan is no longer ready. Open Run again.'))
      const currentPlan = fresh.plans.find((row) => row.key === plan.key)!
      observer.begin(requestId, source)
      begun = true
      await latest.conversation.actions.submit.researchRun({
        requestId,
        source,
        text: buildResearchRunRequest(requestId, fresh, currentPlan),
        onMessageAppended: (message) => observer.bind(requestId, message),
        onSettled: (result) => observer.settle(requestId, result),
        onRejected: () => observer.reject(requestId)
      })
    } catch (error) {
      if (begun) observer.reject(requestId)
      throw error
    } finally {
      pending.current = false
    }
  }
  if (!source) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      {observer.request ? (
        <ResearchRunStatus
          stage={observer.request.stage}
          onOpen={
            observer.request.target
              ? () => {
                  observer.open()
                }
              : undefined
          }
          onRetry={observer.retry}
        />
      ) : null}
      <ResearchRunLauncher
        source={source}
        destination={
          activeSession
            ? { kind: 'current-discussion', title: activeSession.title }
            : { kind: 'new-discussion' }
        }
        blockedReason={blockedReason}
        onStart={start}
      />
    </div>
  )
}
