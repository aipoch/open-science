import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import {
  normalizeDelegationPolicy,
  type DelegationPolicy
} from '../../../../shared/session-persistence'
import {
  annotationRequiresImageInput,
  sideChatAnnotationText,
  type Annotation
} from '../../../../shared/annotations'
import { VISION_MODEL_NOT_CONFIGURED_MESSAGE } from '../../../../shared/run-error-classification'
import { imageAttachmentMimeType } from '../../../../shared/uploads'
import type {
  ChatMessage,
  ChatSession,
  SessionActionabilityProjection
} from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import {
  docIsEmpty,
  docToArtifactRefs,
  docToMessageParts,
  docToSkillIds,
  docToText,
  type ComposerDoc
} from './composer/composer-doc'
import { selectActiveBranchPlan } from './session-plan/active-branch-plan'
import { respondToSessionPlan } from './session-plan/respond-to-session-plan'
import type { WorkspaceComposerController } from './workspace-composer-controller'
import type { EditedMessageSendResult } from './workspace-edited-message'
import {
  useWorkspaceMessageQueueController,
  type WorkspaceMessageQueueController
} from './workspace-message-queue-controller'
import { isWorkspacePresentationRevealing } from './workspace-presentation-revealing'
import type { WorkspaceSessionController } from './workspace-session-controller'
import { hasMainConversation } from './use-side-chat-controller'

type WorkspaceConversationRuntime = Pick<
  WorkspaceAgentRuntime,
  | 'sendMessage'
  | 'resendEditedMessage'
  | 'cancelRun'
  | 'resumeInterruptedSession'
  | 'ensureSessionReady'
>

type DraftSubmitIntent = {
  forcedSkillIds: string[]
  mode?: 'continue' | 'branch' | 'plan-first' | 'retry-reconfigure'
}

type RestoredPlanResponse = { decision: 'approved' | 'rejected' } | { feedback: string }

type PlanProjectionRecoveryPorts = {
  getProjection: (projectId: string, sessionId: string) => Promise<ActivePlanProjection | null>
  getSession: (sessionId: string) => ChatSession | undefined
  setProjection: (sessionId: string, projection: ActivePlanProjection) => void
  finishRun: (sessionId: string) => void
}

type ConversationComposer = {
  view: Pick<
    WorkspaceComposerController['view'],
    'doc' | 'annotations' | 'attachments' | 'transfers' | 'readingContext'
  >
  actions: Pick<WorkspaceComposerController['actions'], 'setError'>
  lifecycle: Pick<
    WorkspaceComposerController['lifecycle'],
    'captureSend' | 'clearDraft' | 'restoreFailedSend' | 'discardSnapshot' | 'captureRevision'
  >
}

type ConversationSession = {
  view: {
    deletingIds: WorkspaceSessionController['view']['deletingIds']
    specialist: Pick<
      WorkspaceSessionController['view']['specialist'],
      'barrierInFlight' | 'sendAvailable'
    >
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
  persistenceBlockedSessionIds: readonly string[]
  isPersistenceReady: boolean
  supportsImageInput: boolean | undefined
  agentConfiguration: SessionAgentConfiguration | undefined
  agentConfigurationReady: boolean
  permissionProfile: PermissionProfileId
  isReviewing: boolean
  isTurnAdmissionBlocked: boolean
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  saveAsSkillInFlightSessionIds: string[]
  actionability: SessionActionabilityProjection | undefined
  hasPendingPermissionRequest: (sessionId: string) => boolean
  newConversationAutoReviewEnabled: boolean
  newConversationMemoryEnabled?: boolean
  newConversationDelegationPolicyOverride?: DelegationPolicy
  newConversationEnabledComputeHosts: string[]
  newConversationSelectedComputeHosts?: string[]
  composer: ConversationComposer
  session: ConversationSession
  runtime: WorkspaceConversationRuntime
  sideChat?: Readonly<{ start: (text: string) => Promise<boolean> }>
  sideChatOpen: boolean
  setAutoReviewEnabled: (sessionId: string, enabled: boolean) => void
  resetNewConversationSettings: () => void
  abortFixLoop: (request: { projectId: string; appSessionId: string }) => Promise<unknown>
  getSession: (sessionId: string) => ChatSession | undefined
  subscribeSessionChanges: (listener: () => void) => () => void
  onSessionSizeLimit: (sessionId: string) => void
  planProjectionRecovery?: PlanProjectionRecoveryPorts
}

type WorkspaceConversationController = {
  optimisticMessage: ChatMessage | undefined
  planProjectionRecoveryError: boolean
  availability: {
    submit: boolean
    submitMode: 'send' | 'queue' | undefined
    revise: boolean
    resume: boolean
    branch: boolean
    planResponse: boolean
  }
  actions: {
    submit: {
      draft: (intent: DraftSubmitIntent) => void
      restoredPlan: (response: RestoredPlanResponse) => Promise<void>
    }
    revise: (
      messageId: string,
      doc: ComposerDoc,
      annotations: Annotation[]
    ) => Promise<EditedMessageSendResult>
    branch: (messageId: string) => void
    sideChat: { start: () => void }
    reportSessionSizeLimit: (sessionId: string) => void
    resume: () => Promise<void>
    cancel: () => Promise<void>
    delete: () => void
  }
  queue: Omit<WorkspaceMessageQueueController, 'lifecycle'>
  admitApplicationMessage: WorkspaceMessageQueueController['lifecycle']['enqueueApplication']
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const resolveDelegationPolicyForSend = (
  branchInNewSession: boolean,
  activeSession: ChatSession | undefined,
  newConversationPolicyOverride: DelegationPolicy | undefined
): DelegationPolicy | undefined => {
  if (branchInNewSession) {
    return (
      newConversationPolicyOverride ?? normalizeDelegationPolicy(activeSession?.delegationPolicy)
    )
  }
  if (!activeSession) return newConversationPolicyOverride ?? 'allow'
  return undefined
}

const usePlanProjectionRecovery = (
  activeSession: ChatSession | undefined,
  ports: PlanProjectionRecoveryPorts | undefined
): boolean => {
  const [errorSessionId, setErrorSessionId] = useState<string>()
  const sessionId = activeSession?.id
  const projectId = activeSession?.projectId
  const status = activeSession?.status
  const projection = activeSession?.activePlanProjection
  const hasRuntimePlan = Boolean(activeSession?.runtimeContext?.plan)

  useEffect(() => {
    if (
      !sessionId ||
      !projectId ||
      projection ||
      !ports ||
      (status !== 'waiting-plan-approval' && !hasRuntimePlan)
    ) {
      return
    }
    let cancelled = false
    let retryTimer: number | undefined
    let retryAttempt = 0
    const refresh = async (): Promise<void> => {
      try {
        const currentProjection = await ports.getProjection(projectId, sessionId)
        if (cancelled) return
        setErrorSessionId((current) => (current === sessionId ? undefined : current))
        if (currentProjection) {
          ports.setProjection(sessionId, currentProjection)
          return
        }
        const currentSession = ports.getSession(sessionId)
        if (
          currentSession?.status === 'waiting-plan-approval' &&
          !currentSession.activePlanProjection
        ) {
          ports.finishRun(sessionId)
        }
      } catch {
        if (cancelled) return
        setErrorSessionId(sessionId)
        retryTimer = window.setTimeout(
          () => void refresh(),
          Math.min(1_000 * 2 ** retryAttempt++, 30_000)
        )
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [hasRuntimePlan, ports, projectId, projection, sessionId, status])

  return Boolean(
    ports &&
    sessionId &&
    !projection &&
    (status === 'waiting-plan-approval' || hasRuntimePlan) &&
    errorSessionId === sessionId
  )
}

const hasRuntimeInteraction = (options: WorkspaceConversationControllerOptions): boolean => {
  const sessionId = options.activeSession?.id
  return Boolean(
    sessionId &&
    (options.promptInFlightSessionIds.includes(sessionId) ||
      options.sendPreparationInFlightSessionIds.includes(sessionId) ||
      options.saveAsSkillInFlightSessionIds.includes(sessionId))
  )
}

const canSubmitImmediately = (options: WorkspaceConversationControllerOptions): boolean => {
  const { activeSession, composer, session } = options
  return (
    options.isPersistenceReady &&
    options.agentConfigurationReady &&
    !options.sideChatOpen &&
    composer.view.transfers.length === 0 &&
    !composer.view.readingContext.isPending &&
    (!docIsEmpty(composer.view.doc) ||
      composer.view.attachments.length > 0 ||
      composer.view.annotations.length > 0) &&
    (options.actionability?.actions.startTurn.allowed ?? true) &&
    !hasRuntimeInteraction(options) &&
    !options.isTurnAdmissionBlocked &&
    !activeSession?.fixLoopActive &&
    !activeSession?.conversationGraphSyncBlocked &&
    !activeSession?.compacting &&
    !session.view.specialist.barrierInFlight
  )
}

const canQueueDraft = (options: WorkspaceConversationControllerOptions): boolean => {
  const { activeSession, composer, session } = options
  return Boolean(
    options.isPersistenceReady &&
    options.agentConfigurationReady &&
    !options.sideChatOpen &&
    activeSession?.status === 'running' &&
    composer.view.transfers.length === 0 &&
    !composer.view.readingContext.isPending &&
    (!docIsEmpty(composer.view.doc) ||
      composer.view.attachments.length > 0 ||
      composer.view.annotations.length > 0) &&
    !options.sendPreparationInFlightSessionIds.includes(activeSession.id) &&
    !options.saveAsSkillInFlightSessionIds.includes(activeSession.id) &&
    !options.isTurnAdmissionBlocked &&
    !activeSession.fixLoopActive &&
    !activeSession.conversationGraphSyncBlocked &&
    !activeSession.compacting &&
    !session.lifecycle.isBarrierInFlight(activeSession.id)
  )
}

const canRevise = (options: WorkspaceConversationControllerOptions): boolean => {
  const { activeSession, composer, session } = options
  return (
    options.isPersistenceReady &&
    options.agentConfigurationReady &&
    !options.sideChatOpen &&
    composer.view.transfers.length === 0 &&
    (options.actionability?.actions.revise.allowed ?? true) &&
    !hasRuntimeInteraction(options) &&
    !options.isReviewing &&
    !options.isTurnAdmissionBlocked &&
    !activeSession?.fixLoopActive &&
    !activeSession?.conversationGraphSyncBlocked &&
    !activeSession?.compacting &&
    !session.view.deletingIds.has(activeSession?.id ?? '')
  )
}

const canQueueRevision = (options: WorkspaceConversationControllerOptions): boolean => {
  const { activeSession, composer, session } = options
  return Boolean(
    options.isPersistenceReady &&
    options.agentConfigurationReady &&
    !options.sideChatOpen &&
    activeSession?.status === 'running' &&
    composer.view.transfers.length === 0 &&
    !options.isReviewing &&
    !options.sendPreparationInFlightSessionIds.includes(activeSession.id) &&
    !options.saveAsSkillInFlightSessionIds.includes(activeSession.id) &&
    !options.isTurnAdmissionBlocked &&
    !activeSession.fixLoopActive &&
    !activeSession.conversationGraphSyncBlocked &&
    !activeSession.compacting &&
    !session.lifecycle.isBarrierInFlight(activeSession.id) &&
    !session.view.deletingIds.has(activeSession.id)
  )
}

const canBranch = (options: WorkspaceConversationControllerOptions): boolean =>
  Boolean(
    options.isPersistenceReady &&
    options.agentConfigurationReady &&
    options.activeSession &&
    !options.activeSession.activeRun &&
    options.actionability?.actions.branchFromMessage.allowed !== false &&
    !options.isTurnAdmissionBlocked &&
    !options.activeSession.fixLoopActive &&
    !options.activeSession.compacting &&
    !options.activeSession.branchSwitchBlocked &&
    !options.activeSession.conversationGraphSyncBlocked &&
    !options.session.view.specialist.barrierInFlight &&
    options.session.view.specialist.sendAvailable &&
    !hasRuntimeInteraction(options) &&
    !options.session.view.deletingIds.has(options.activeSession.id)
  )

const canStartSideChat = (options: WorkspaceConversationControllerOptions): boolean =>
  Boolean(
    options.sideChat &&
    options.activeSession &&
    hasMainConversation(options.activeSession) &&
    !options.sideChatOpen &&
    options.isPersistenceReady &&
    options.agentConfigurationReady &&
    options.actionability?.actions.startSideChat.allowed !== false &&
    options.composer.view.transfers.length === 0 &&
    options.composer.view.attachments.length === 0 &&
    (docToText(options.composer.view.doc).trim() || options.composer.view.annotations.length > 0)
  )

const useWorkspaceConversationController = (
  options: WorkspaceConversationControllerOptions
): WorkspaceConversationController => {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  const inFlightDraftKeysRef = useRef(new Set<string>())
  const [optimisticMessages, setOptimisticMessages] = useState<Record<string, ChatMessage>>({})
  const planProjectionRecoveryError = usePlanProjectionRecovery(
    options.activeSession,
    options.planProjectionRecovery
  )
  const messageQueue = useWorkspaceMessageQueueController({
    activeSession: options.activeSession,
    promptInFlightSessionIds: options.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds: options.sendPreparationInFlightSessionIds,
    saveAsSkillInFlightSessionIds: options.saveAsSkillInFlightSessionIds,
    isSideChatOpen: (sessionId) =>
      optionsRef.current.activeSession?.id === sessionId && optionsRef.current.sideChatOpen,
    composer: {
      setError: options.composer.actions.setError,
      restoreQueuedDraft: (snapshot) =>
        options.composer.lifecycle.restoreFailedSend(snapshot, true),
      discardSnapshot: options.composer.lifecycle.discardSnapshot
    },
    runtime: options.runtime,
    isBarrierInFlight: options.session.lifecycle.isBarrierInFlight,
    isPresentationRevealing: isWorkspacePresentationRevealing,
    isSpecialistReady: (sessionId) => {
      const current = optionsRef.current
      return current.session.lifecycle.canStartSend(sessionId)
    },
    isPersistenceBlocked: (sessionId) =>
      optionsRef.current.persistenceBlockedSessionIds.includes(sessionId),
    hasPendingPermissionRequest: options.hasPendingPermissionRequest,
    abortFixLoop: options.abortFixLoop,
    getSession: options.getSession,
    subscribeSessionChanges: options.subscribeSessionChanges
  })
  const [actions] = useState<WorkspaceConversationController['actions']>(() => {
    const submitDraft = ({ forcedSkillIds, mode = 'continue' }: DraftSubmitIntent): void => {
      const current = optionsRef.current
      const { activeSession, composer, session, runtime } = current
      if (!current.agentConfiguration) return
      const reconfigureRetry = mode === 'retry-reconfigure'
      if (reconfigureRetry && !session.actions.beginReconfigureRetry()) return
      const queueDraft = mode === 'continue' && canQueueDraft(current)
      if (!queueDraft && !reconfigureRetry && !session.lifecycle.canStartSend()) return
      const queueBlocksImmediateSend = Boolean(
        activeSession && messageQueue.lifecycle.blocksImmediateSend(activeSession.id)
      )
      if (!queueDraft && (queueBlocksImmediateSend || !canSubmitImmediately(current))) return

      const branchInNewSession = mode === 'branch'
      if (branchInNewSession && !activeSession) return
      if (branchInNewSession && !canBranch(current)) return
      if (activeSession && session.lifecycle.isBarrierInFlight(activeSession.id)) return
      if (
        current.supportsImageInput !== true &&
        (composer.view.attachments.some(
          (attachment) =>
            imageAttachmentMimeType(attachment.name, attachment.mimeType) !== undefined
        ) ||
          composer.view.annotations.some(annotationRequiresImageInput))
      ) {
        composer.actions.setError(VISION_MODEL_NOT_CONFIGURED_MESSAGE)
        return
      }
      if (queueDraft && activeSession) {
        const { hasPendingSwitch } = session.lifecycle.captureSendIntent(false)
        if (hasPendingSwitch) return
        const snapshot = composer.lifecycle.captureSend()
        if (
          messageQueue.lifecycle.enqueue({
            session: activeSession,
            snapshot,
            text: docToText(snapshot.doc),
            forcedSkillIds,
            permissionProfile: current.permissionProfile,
            agentConfiguration: current.agentConfiguration,
            specialistId: activeSession.specialistId
          })
        ) {
          composer.lifecycle.clearDraft(snapshot.draftKey, snapshot.version)
        }
        return
      }

      const snapshot = composer.lifecycle.captureSend(!branchInNewSession)
      if (inFlightDraftKeysRef.current.has(snapshot.draftKey)) return
      inFlightDraftKeysRef.current.add(snapshot.draftKey)

      const wasNewConversation = !activeSession
      const autoReviewEnabled = current.newConversationAutoReviewEnabled
      const memoryEnabled = activeSession
        ? activeSession.memoryEnabled !== false
        : current.newConversationMemoryEnabled !== false
      const computeHosts = current.newConversationEnabledComputeHosts
      const selectedComputeHosts = current.newConversationSelectedComputeHosts ?? []
      const { draftSpecialistId, hasPendingSwitch, pendingSpecialistId } =
        session.lifecycle.captureSendIntent(branchInNewSession)

      const dispatch = (sessionId: string | undefined): void => {
        const optimisticMessage = sessionId
          ? {
              id: `optimistic-${snapshot.draftKey}-${snapshot.version}`,
              role: 'user' as const,
              content: docToText(snapshot.doc),
              status: 'complete' as const,
              eventIds: [],
              uploads: snapshot.attachments,
              annotations: snapshot.annotations,
              parts: docToMessageParts(snapshot.doc),
              pdfContext: snapshot.pdfContext,
              createdAt: 0,
              updatedAt: 0
            }
          : undefined
        if (sessionId && optimisticMessage) {
          setOptimisticMessages((current) => ({ ...current, [sessionId]: optimisticMessage }))
        }
        void runtime
          .sendMessage({
            sessionId,
            ...(branchInNewSession && activeSession
              ? { branchSourceSessionId: activeSession.id }
              : {}),
            text: docToText(snapshot.doc),
            attachments: snapshot.attachments,
            annotations: snapshot.annotations,
            referencedArtifacts: docToArtifactRefs(snapshot.doc),
            parts: docToMessageParts(snapshot.doc),
            pdfContext: snapshot.pdfContext,
            pdfReadingPosition: snapshot.pdfReadingPosition,
            pendingPdfContextAttachmentIds: snapshot.pendingPdfContextAttachmentIds,
            pendingPdfContextVersions: snapshot.pendingPdfContextVersions,
            cwd: activeSession?.cwd,
            projectId: activeSession?.projectId ?? current.projectId,
            permissionProfile: current.permissionProfile,
            agentConfiguration: current.agentConfiguration,
            memoryEnabled,
            delegationPolicy: resolveDelegationPolicyForSend(
              branchInNewSession,
              activeSession,
              current.newConversationDelegationPolicyOverride
            ),
            forcedSkillIds,
            ...(mode === 'plan-first' ? { turnIntent: 'plan-first' as const } : {}),
            specialistId: draftSpecialistId,
            ...(wasNewConversation && computeHosts.length > 0
              ? {
                  enabledComputeHosts: computeHosts,
                  selectedComputeHosts
                }
              : {})
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
            if (snapshot.annotations.length > 0) {
              composer.lifecycle.clearDraft(snapshot.draftKey, snapshot.version)
            }
            if (wasNewConversation && autoReviewEnabled) {
              current.setAutoReviewEnabled(result.sessionId, true)
            }
            current.resetNewConversationSettings()
            session.actions.resetNewConversationSpecialist()
          })
          .finally(() => {
            inFlightDraftKeysRef.current.delete(snapshot.draftKey)
            if (!sessionId || !optimisticMessage) return
            setOptimisticMessages((current) => {
              if (current[sessionId]?.id !== optimisticMessage.id) return current
              const next = { ...current }
              delete next[sessionId]
              return next
            })
          })
      }

      if (hasPendingSwitch && activeSession) {
        void session.lifecycle
          .prepareSpecialistSend(activeSession.id, pendingSpecialistId)
          .then((ready) => {
            if (!ready) {
              inFlightDraftKeysRef.current.delete(snapshot.draftKey)
              return
            }
            if (snapshot.annotations.length === 0) composer.lifecycle.clearDraft(activeSession.id)
            dispatch(activeSession.id)
          })
        return
      }

      if (snapshot.annotations.length === 0) composer.lifecycle.clearDraft(current.currentDraftKey)
      dispatch(branchInNewSession ? undefined : activeSession?.id)
    }

    const submitRestoredPlan = async (response: RestoredPlanResponse): Promise<void> => {
      const { activeSession, agentConfigurationReady, isPersistenceReady, runtime, sideChatOpen } =
        optionsRef.current
      if (!isPersistenceReady) throw new Error('Session persistence is unavailable.')
      const session = activeSession ? optionsRef.current.getSession(activeSession.id) : undefined
      const plan = selectActiveBranchPlan(session)
      if (sideChatOpen || !session || session.activeRun || plan?.approval !== 'pending') {
        throw new Error('The pending Plan is no longer available for a response.')
      }
      if (!agentConfigurationReady) {
        throw new Error('The Session model is unavailable.')
      }
      await runtime.ensureSessionReady(session.id)
      await respondToSessionPlan(
        { projectId: session.projectId, sessionId: session.id, projection: plan },
        response,
        { onSessionSizeLimit: optionsRef.current.onSessionSizeLimit }
      )
    }

    return {
      submit: { draft: submitDraft, restoredPlan: submitRestoredPlan },
      revise: async (messageId, doc, annotations = []): Promise<EditedMessageSendResult> => {
        const current = optionsRef.current
        const sessionId = current.activeSession?.id
        if (!sessionId || (docIsEmpty(doc) && annotations.length === 0)) return { ok: false }
        if (current.supportsImageInput !== true && annotations.some(annotationRequiresImageInput)) {
          current.composer.actions.setError(VISION_MODEL_NOT_CONFIGURED_MESSAGE)
          return { ok: false, displayMessage: VISION_MODEL_NOT_CONFIGURED_MESSAGE }
        }
        const queueRevision =
          messageQueue.lifecycle.blocksImmediateSend(sessionId) || canQueueRevision(current)
        if (queueRevision) {
          if (!current.agentConfiguration || (!canRevise(current) && !canQueueRevision(current)))
            return { ok: false }
          const snapshot = current.composer.lifecycle.captureRevision(doc, annotations)
          const queued = messageQueue.lifecycle.enqueue({
            session: current.activeSession!,
            snapshot,
            text: docToText(doc),
            forcedSkillIds: docToSkillIds(doc),
            permissionProfile: current.permissionProfile,
            agentConfiguration: current.agentConfiguration,
            specialistId: current.activeSession?.specialistId,
            revisionMessageId: messageId
          })
          return queued ? { ok: true, disposition: 'queued' } : { ok: false }
        }
        if (!canRevise(current)) return { ok: false }
        try {
          const sent = await current.runtime.resendEditedMessage(sessionId, messageId, {
            text: docToText(doc),
            annotations,
            parts: docToMessageParts(doc),
            forcedSkillIds: docToSkillIds(doc),
            referencedArtifacts: docToArtifactRefs(doc)
          })
          return sent ? { ok: true, disposition: 'sent' } : { ok: false }
        } catch (error) {
          const message = errorMessage(error)
          current.composer.actions.setError(message)
          return { ok: false, displayMessage: message }
        }
      },
      branch: (messageId): void => {
        const current = optionsRef.current
        if (!current.agentConfiguration) return
        const sourceSessionId = current.activeSession?.id
        if (!sourceSessionId || !canBranch(current)) return
        if (current.session.lifecycle.isBarrierInFlight(sourceSessionId)) return
        if (!current.session.lifecycle.canStartSend()) return
        const { draftSpecialistId } = current.session.lifecycle.captureSendIntent(true)
        void current.runtime
          .sendMessage({
            branchSourceSessionId: sourceSessionId,
            branchSourceMessageId: messageId,
            text: '',
            agentConfiguration: current.agentConfiguration,
            delegationPolicy: resolveDelegationPolicyForSend(
              true,
              current.activeSession,
              current.newConversationDelegationPolicyOverride
            ),
            specialistId: draftSpecialistId
          })
          .then((result) => {
            if (!result) return
            current.resetNewConversationSettings()
            current.session.actions.resetNewConversationSpecialist()
          })
          .catch((error: unknown) => current.composer.actions.setError(errorMessage(error)))
      },
      sideChat: {
        start: (): void => {
          const current = optionsRef.current
          if (!canStartSideChat(current) || !current.sideChat) return
          const snapshot = current.composer.lifecycle.captureSend()
          void current.sideChat
            .start(sideChatAnnotationText(docToText(snapshot.doc), snapshot.annotations))
            .then((admitted) => {
              if (admitted) {
                current.composer.lifecycle.clearDraft(snapshot.draftKey, snapshot.version)
              }
            })
            .catch((error: unknown) => current.composer.actions.setError(errorMessage(error)))
        }
      },
      reportSessionSizeLimit: (sessionId): void => optionsRef.current.onSessionSizeLimit(sessionId),
      resume: async (): Promise<void> => {
        const current = optionsRef.current
        if (!current.isPersistenceReady || !current.activeSession || current.sideChatOpen) return
        await current.runtime.resumeInterruptedSession(current.activeSession.id)
      },
      cancel: async (): Promise<void> => {
        const current = optionsRef.current
        if (current.sideChatOpen) return
        const session = current.activeSession
        if (!session) return
        const fixLoopCancellation = session.fixLoopActive
          ? current
              .abortFixLoop({ projectId: session.projectId, appSessionId: session.id })
              .catch((error: unknown) => console.warn('Failed to abort fix loop:', error))
          : Promise.resolve()
        await Promise.all([fixLoopCancellation, current.runtime.cancelRun(session.id)])
      },
      delete: (): void => optionsRef.current.session.actions.confirmDelete()
    }
  })

  const queueBlocksActiveSession = Boolean(
    options.activeSession && messageQueue.lifecycle.blocksImmediateSend(options.activeSession.id)
  )
  const submitImmediately = !queueBlocksActiveSession && canSubmitImmediately(options)
  const queueDraft = canQueueDraft(options)

  return {
    admitApplicationMessage: messageQueue.lifecycle.enqueueApplication,
    optimisticMessage: options.activeSession
      ? optimisticMessages[options.activeSession.id]
      : undefined,
    planProjectionRecoveryError,
    availability: {
      submit: submitImmediately || queueDraft,
      submitMode: submitImmediately ? 'send' : queueDraft ? 'queue' : undefined,
      revise: canRevise(options) || canQueueRevision(options),
      resume: options.isPersistenceReady && !options.sideChatOpen,
      branch: !queueBlocksActiveSession && canBranch(options),
      planResponse: options.isPersistenceReady
    },
    actions,
    queue: {
      items: messageQueue.items,
      hasPendingWork: messageQueue.hasPendingWork,
      announcement: messageQueue.announcement,
      actions: messageQueue.actions
    }
  }
}

export { useWorkspaceConversationController }
export type {
  DraftSubmitIntent,
  RestoredPlanResponse,
  WorkspaceConversationController,
  WorkspaceConversationControllerOptions
}
