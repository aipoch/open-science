import { useLayoutEffect, useRef, useState } from 'react'

import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import type { ChatSession } from '@/stores/session-store'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import {
  docIsEmpty,
  docToArtifactRefs,
  docToSkillIds,
  docToText,
  type ComposerDoc
} from './composer/composer-doc'
import { selectActiveBranchPlan } from './session-plan/active-branch-plan'
import type { WorkspaceComposerController } from './workspace-composer-controller'
import type { WorkspaceSessionController } from './workspace-session-controller'

type WorkspaceConversationRuntime = Pick<
  WorkspaceAgentRuntime,
  'sendMessage' | 'resendEditedMessage' | 'cancelRun' | 'resumeInterruptedSession'
>

type DraftSubmitIntent = {
  forcedSkillIds: string[]
  mode?: 'continue' | 'branch' | 'plan-first' | 'retry-reconfigure'
}

type RestoredPlanResponse = { decision: 'approved' | 'rejected' } | { feedback: string }

type ConversationComposer = {
  view: Pick<WorkspaceComposerController['view'], 'doc' | 'attachments' | 'transfers'>
  actions: Pick<WorkspaceComposerController['actions'], 'setError'>
  lifecycle: Pick<
    WorkspaceComposerController['lifecycle'],
    'captureSend' | 'clearDraft' | 'restoreFailedSend'
  >
}

type ConversationSession = {
  view: {
    deletingIds: WorkspaceSessionController['view']['deletingIds']
    specialist: Pick<WorkspaceSessionController['view']['specialist'], 'barrierInFlight'>
  }
  actions: Pick<
    WorkspaceSessionController['actions'],
    'beginReconfigureRetry' | 'resetNewConversationSpecialist' | 'confirmDelete'
  >
  lifecycle: Pick<
    WorkspaceSessionController['lifecycle'],
    'canStartSend' | 'captureSendIntent' | 'prepareSpecialistSend' | 'isBarrierInFlight'
  >
}

type WorkspaceConversationControllerOptions = {
  activeSession: ChatSession | undefined
  projectId: string
  currentDraftKey: string
  isPersistenceReady: boolean
  supportsImageInput: boolean | undefined
  permissionProfile: PermissionProfileId
  isReviewing: boolean
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  newConversationAutoReviewEnabled: boolean
  newConversationEnabledComputeHosts: string[]
  composer: ConversationComposer
  session: ConversationSession
  runtime: WorkspaceConversationRuntime
  setAutoReviewEnabled: (sessionId: string, enabled: boolean) => void
  setEnabledComputeHosts: (sessionId: string, providerIds: string[]) => void
  resetNewConversationSettings: () => void
  syncComputeHosts: (sessionId: string, providerIds: string[]) => Promise<unknown>
  abortFixLoop: (request: { projectId: string; appSessionId: string }) => Promise<unknown>
  getSession: (sessionId: string) => ChatSession | undefined
}

type WorkspaceConversationController = {
  availability: {
    submit: boolean
    revise: boolean
    resume: boolean
  }
  actions: {
    submit: {
      draft: (intent: DraftSubmitIntent) => void
      restoredPlan: (response: RestoredPlanResponse) => Promise<void>
    }
    revise: (messageId: string, doc: ComposerDoc) => void
    resume: () => Promise<void>
    cancel: () => void
    delete: () => void
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const hasRuntimeInteraction = (options: WorkspaceConversationControllerOptions): boolean => {
  const sessionId = options.activeSession?.id
  return Boolean(
    sessionId &&
    (options.promptInFlightSessionIds.includes(sessionId) ||
      options.sendPreparationInFlightSessionIds.includes(sessionId))
  )
}

const canSubmit = (options: WorkspaceConversationControllerOptions): boolean => {
  const { activeSession, composer, session } = options
  return (
    options.isPersistenceReady &&
    composer.view.transfers.length === 0 &&
    (!docIsEmpty(composer.view.doc) || composer.view.attachments.length > 0) &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-for-user' &&
    activeSession?.status !== 'waiting-permission' &&
    !hasRuntimeInteraction(options) &&
    !activeSession?.fixLoopActive &&
    !activeSession?.conversationGraphSyncBlocked &&
    !activeSession?.compacting &&
    !session.view.specialist.barrierInFlight
  )
}

const canRevise = (options: WorkspaceConversationControllerOptions): boolean => {
  const { activeSession, composer, session } = options
  return (
    options.isPersistenceReady &&
    composer.view.transfers.length === 0 &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-for-user' &&
    activeSession?.status !== 'waiting-permission' &&
    !hasRuntimeInteraction(options) &&
    !options.isReviewing &&
    !activeSession?.fixLoopActive &&
    !activeSession?.conversationGraphSyncBlocked &&
    !activeSession?.compacting &&
    !session.view.deletingIds.has(activeSession?.id ?? '')
  )
}

const useWorkspaceConversationController = (
  options: WorkspaceConversationControllerOptions
): WorkspaceConversationController => {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  const inFlightDraftKeysRef = useRef(new Set<string>())
  const [actions] = useState<WorkspaceConversationController['actions']>(() => {
    const submitDraft = ({ forcedSkillIds, mode = 'continue' }: DraftSubmitIntent): void => {
      const current = optionsRef.current
      const { activeSession, composer, session, runtime } = current
      if (mode === 'retry-reconfigure' && !session.actions.beginReconfigureRetry()) return
      if (!canSubmit(current)) return

      const branchInNewSession = mode === 'branch'
      if (branchInNewSession && !activeSession) return
      if (activeSession && session.lifecycle.isBarrierInFlight(activeSession.id)) return
      if (
        current.supportsImageInput !== true &&
        composer.view.attachments.some((attachment) => attachment.mimeType?.startsWith('image/'))
      ) {
        composer.actions.setError('The selected model is not configured for image input.')
        return
      }
      if (!session.lifecycle.canStartSend()) return

      const snapshot = composer.lifecycle.captureSend()
      if (inFlightDraftKeysRef.current.has(snapshot.draftKey)) return
      inFlightDraftKeysRef.current.add(snapshot.draftKey)

      const wasNewConversation = !activeSession
      const autoReviewEnabled = current.newConversationAutoReviewEnabled
      const computeHosts = current.newConversationEnabledComputeHosts
      const { draftSpecialistId, hasPendingSwitch, pendingSpecialistId } =
        session.lifecycle.captureSendIntent(branchInNewSession)

      const dispatch = (sessionId: string | undefined): void => {
        void runtime
          .sendMessage({
            sessionId,
            ...(branchInNewSession && activeSession
              ? { branchSourceSessionId: activeSession.id }
              : {}),
            text: docToText(snapshot.doc),
            attachments: snapshot.attachments,
            referencedArtifacts: docToArtifactRefs(snapshot.doc),
            parts: snapshot.doc.nodes,
            cwd: activeSession?.cwd,
            projectId: activeSession?.projectId ?? current.projectId,
            projectName: activeSession?.projectId ?? current.projectId,
            permissionProfile: current.permissionProfile,
            forcedSkillIds,
            ...(mode === 'plan-first' ? { turnIntent: 'plan-first' as const } : {}),
            specialistId: draftSpecialistId
          })
          .catch((error: unknown) => {
            composer.actions.setError(errorMessage(error))
            return undefined
          })
          .then((result) => {
            if (!result) {
              composer.lifecycle.restoreFailedSend(snapshot)
              return
            }
            if (wasNewConversation && autoReviewEnabled) {
              current.setAutoReviewEnabled(result.sessionId, true)
            }
            if (wasNewConversation && computeHosts.length > 0) {
              current.setEnabledComputeHosts(result.sessionId, computeHosts)
              void current
                .syncComputeHosts(result.sessionId, computeHosts)
                .catch((error: unknown) =>
                  console.warn(
                    'Failed to sync draft compute hosts to registry for new session',
                    error
                  )
                )
            }
            current.resetNewConversationSettings()
            session.actions.resetNewConversationSpecialist()
          })
          .finally(() => inFlightDraftKeysRef.current.delete(snapshot.draftKey))
      }

      if (hasPendingSwitch && activeSession) {
        void session.lifecycle
          .prepareSpecialistSend(activeSession.id, pendingSpecialistId)
          .then((ready) => {
            if (!ready) {
              inFlightDraftKeysRef.current.delete(snapshot.draftKey)
              return
            }
            composer.lifecycle.clearDraft(activeSession.id)
            dispatch(activeSession.id)
          })
        return
      }

      composer.lifecycle.clearDraft(current.currentDraftKey)
      dispatch(branchInNewSession ? undefined : activeSession?.id)
    }

    const submitRestoredPlan = async (response: RestoredPlanResponse): Promise<void> => {
      const { activeSession, runtime } = optionsRef.current
      const session = activeSession ? optionsRef.current.getSession(activeSession.id) : undefined
      const plan = selectActiveBranchPlan(session)
      if (!session || session.activeRun || plan?.approval !== 'pending') {
        throw new Error('The pending Plan is no longer available for a response.')
      }
      const pendingAction =
        'feedback' in response
          ? ('review' as const)
          : response.decision === 'approved'
            ? ('approve' as const)
            : ('reject' as const)
      const text =
        'feedback' in response
          ? response.feedback
          : response.decision === 'approved'
            ? 'Approve the current Plan and continue.'
            : 'Dismiss the current Plan.'
      const result = await runtime.sendMessage({
        sessionId: session.id,
        text,
        planContinuation: {
          artifactVersionId: plan.artifactVersionId,
          revision: plan.revision,
          pendingAction
        },
        attachments: [],
        cwd: session.cwd,
        projectId: session.projectId,
        projectName: session.projectId,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
      })
      if (!result) throw new Error('Unable to respond to the Plan.')
    }

    return {
      submit: { draft: submitDraft, restoredPlan: submitRestoredPlan },
      revise: (messageId, doc): void => {
        const current = optionsRef.current
        const sessionId = current.activeSession?.id
        if (!sessionId || !canRevise(current) || docIsEmpty(doc)) return
        void current.runtime.resendEditedMessage(sessionId, messageId, {
          text: docToText(doc),
          parts: doc.nodes,
          forcedSkillIds: docToSkillIds(doc),
          referencedArtifacts: docToArtifactRefs(doc)
        })
      },
      resume: async (): Promise<void> => {
        const current = optionsRef.current
        if (!current.isPersistenceReady || !current.activeSession) return
        await current.runtime.resumeInterruptedSession(current.activeSession.id)
      },
      cancel: (): void => {
        const current = optionsRef.current
        const session = current.activeSession
        if (!session) return
        if (session.fixLoopActive) {
          void current
            .abortFixLoop({ projectId: session.projectId, appSessionId: session.id })
            .catch((error: unknown) => console.warn('Failed to abort fix loop:', error))
        }
        void current.runtime.cancelRun(session.id)
      },
      delete: (): void => optionsRef.current.session.actions.confirmDelete()
    }
  })

  return {
    availability: {
      submit: canSubmit(options),
      revise: canRevise(options),
      resume: options.isPersistenceReady
    },
    actions
  }
}

export { useWorkspaceConversationController }
export type {
  DraftSubmitIntent,
  RestoredPlanResponse,
  WorkspaceConversationController,
  WorkspaceConversationControllerOptions
}
