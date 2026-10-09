import { useTranslation } from 'react-i18next'
import type { ResearchDemoQuestion } from '../../../../../shared/research-demo'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import {
  useRunObservationQuestionStore,
  type ObservationQuestionDestination,
  type ObservationQuestionSelection
} from '@/stores/run-observation-question-store'
import { ordinaryDraftKey, researchDraftKey } from '../research-draft-identity'
import {
  openResearchWorkspace,
  researchSourceFromSession
} from '../workspace-discussion-navigation'

export type ObservationQuestionRecovery = {
  label: string
  onClick: (selection: ObservationQuestionSelection, signal?: AbortSignal) => void | Promise<void>
}

const stageRecoveredQuestion = (
  selection: ObservationQuestionSelection,
  destination: ObservationQuestionDestination,
  signal?: AbortSignal,
  demo?: Pick<ResearchDemoQuestion, 'source' | 'requestId' | 'purpose'>
): void => {
  const revision = useNavigationStore.getState().explicitNavigationRevision
  useRunObservationQuestionStore.getState().recover(
    selection,
    destination,
    () => {
      const navigation = useNavigationStore.getState()
      const sessionId = useSessionStore.getState().selectedSessionId
      const selected = useSessionStore.getState().sessions.find((row) => row.id === sessionId)
      const inlineSource = researchSourceFromSession(selected)
      const research =
        inlineSource ??
        (!sessionId
          ? useResearchWorkspaceStore.getState().draftResearchByProject[destination.projectId]
          : undefined)
      const draftKey = research
        ? researchDraftKey(research)
        : (sessionId ?? ordinaryDraftKey(destination.projectId))
      return (
        !signal?.aborted &&
        navigation.explicitNavigationRevision === revision &&
        navigation.view === 'workspace' &&
        navigation.activeProjectId === destination.projectId &&
        (inlineSource ? !destination.sessionId : sessionId === destination.sessionId) &&
        draftKey === destination.draftKey
      )
    },
    demo
  )
}

/** A deliberate recovery action reuses the existing research/Session navigation and its guards. */
export const useObservationQuestionRecovery = (
  target?: {
    projectId: string
    sessionId: string
  },
  demo?: Pick<ResearchDemoQuestion, 'source' | 'requestId' | 'purpose'>
): ObservationQuestionRecovery | undefined => {
  const { t } = useTranslation()
  const session = useSessionStore((state) =>
    state.sessions.find(
      (item) =>
        item.projectId === target?.projectId &&
        item.id === target?.sessionId &&
        !item.isPending &&
        item.archivedAt === undefined
    )
  )
  const source = researchSourceFromSession(session)
  if (!session || !target) return undefined
  return source
    ? {
        label: t('Discuss'),
        onClick: async (selection, signal) => {
          if (
            !(await openResearchWorkspace(source, {
              preservePreview: true,
              signal,
              afterNavigate: (destination) =>
                stageRecoveredQuestion(selection, destination, signal, demo)
            }))
          )
            throw new Error('Research discussion is unavailable.')
        }
      }
    : {
        label: t('Open source Session'),
        onClick: (selection, signal) => {
          if (signal?.aborted) return
          useNavigationStore
            .getState()
            .openSession(target.projectId, target.sessionId, 'user', () =>
              stageRecoveredQuestion(
                selection,
                { ...target, draftKey: target.sessionId },
                signal,
                demo
              )
            )
        }
      }
}
