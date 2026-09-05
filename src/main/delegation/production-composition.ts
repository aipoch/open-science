import { join } from 'node:path'

import type {
  AcpAgentRuntimeUpdate,
  AcpPermissionRequest,
  AcpPermissionResponse,
  DelegatedWorkUnavailableReason
} from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { SpecialistView } from '../../shared/specialist'
import type { AgentFrameworkId } from '../../shared/settings'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { DelegatedQuestionAnswer } from '../../shared/session-persistence'
import { getAgentFramework } from '../agent-framework'
import {
  createDelegatedArtifactEvidence,
  type DelegatedArtifactEvidenceOptions
} from './delegated-artifact-evidence'
import {
  createDelegatedReviewEvidence,
  type DelegatedReviewEvidenceOptions
} from './delegated-review-evidence'
import type { DelegatedWorkRecordCommands, SessionKey } from './session-records'
import type {
  DelegateExecution,
  DelegateMessageAcceptanceEvidence,
  DelegatedExecutionModelAdmission
} from './execution-port'
import {
  createDurableDelegatedWork,
  DurableDelegatedWorkError,
  type DurableDelegatedWork,
  type ParentMessageDelivery,
  type RootDelegatePermissionEvent,
  type RootDelegatePermissionRequest
} from './durable-delegated-work'

import { createProductionFrameWorkspace, type ResolvedImmutableInput } from './frame-workspace'
import { createSessionDelegatedWorkRecords } from './session-record-adapter'
import {
  DelegationSettlementWakeOwner,
  type DelegationSettlementDispatch,
  type DelegationSettlementSnapshot
} from './delegation-settlement-wake-owner'

type CertifiedSessionFramework = Readonly<{
  frameworkId: AgentFrameworkId
  execution: DelegateExecution
  assertAvailable(): Promise<void> | void
}>

type ProductionDelegatedWorkOptions = Readonly<{
  dataRoot: string
  sessions: Readonly<{
    commands: DelegatedWorkRecordCommands
    readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
    findSessions?(sessionId: string): Promise<readonly PersistedChatSession[]>
  }>
  resolveInput(identity: string, session: SessionKey): Promise<ResolvedImmutableInput>
  frameworks: Readonly<{
    forSession(session: PersistedChatSession): Promise<CertifiedSessionFramework>
  }>
  resolveSpecialist?(
    profileId: string
  ): Promise<SpecialistView | undefined> | SpecialistView | undefined
  resolveSpecialistReference?(
    profileReference: string
  ): Promise<SpecialistView | undefined> | SpecialistView | undefined
  artifactEvidence?: DelegatedArtifactEvidenceOptions
  reviewEvidence?: DelegatedReviewEvidenceOptions
  parentMessages?: Readonly<{
    deliver(delivery: ParentMessageDelivery): Promise<DelegateMessageAcceptanceEvidence>
  }>
  onAgentRuntimeUpdate?(update: AcpAgentRuntimeUpdate): void
  resolveExecutionModel(session: PersistedChatSession): Promise<DelegatedExecutionModelAdmission>
  settlementContinuations?: Readonly<{
    dispatch(request: DelegationSettlementDispatch): Promise<void> | void
  }>
}>

type RootDelegatedWorkEvent =
  | Readonly<{ kind: 'permission-requested'; request: AcpPermissionRequest }>
  | Readonly<{ kind: 'permission-settled'; requestId: string }>
  | Readonly<{ kind: 'records-changed'; sessionId: string }>
  | Readonly<{ kind: 'admission-rejected'; sessionId: string; reason: string }>
  | Readonly<{ kind: 'unavailable-reason-cleared'; sessionId: string }>

type RootDelegatedWorkControl = Readonly<{
  pendingPermissions(): readonly AcpPermissionRequest[]
  unavailableReasons?(): Readonly<Record<string, DelegatedWorkUnavailableReason>>
  clearUnavailableReason?(sessionId: string): void
  subscribe(listener: (event: RootDelegatedWorkEvent) => void): () => void
  respondToPermission(response: AcpPermissionResponse): Promise<boolean>
  setPermissionProfile(sessionId: string, profile: PermissionProfileId): Promise<void>
  cancelTurn?(sessionId: string, initiatingTurnMessageId: string): Promise<void>
  stopActiveBranch?(sessionId: string): Promise<void>
  stopSession(sessionId: string): Promise<void>
  respondQuestion?(
    input: Readonly<{
      projectId: string
      sessionId: string
      requestId: string
      action: 'draft' | 'confirm'
      answers: readonly DelegatedQuestionAnswer[]
      questionIndex?: number
    }>
  ): Promise<void>
  wakeMessages?(sessionId: string): Promise<void>
  rootTurnStarted?(
    input: Readonly<{
      sessionId: string
      originatingPromptId: string
    }>
  ): Promise<string | undefined>
  rootTurnEnded?(
    input: Readonly<{
      sessionId: string
      originatingPromptId: string
      clean: boolean
      leaseId?: string
    }>
  ): Promise<void>
  settlementPromptEnded?(sessionId: string, promptId: string): Promise<void>
  // Cancel current work and notifications while retaining the ability to observe future turns.
  stopAll(): Promise<void>
  shutdown(): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  deleteProject(projectId: string): Promise<void>
}>

type ProductionDelegatedWorkComposition = Readonly<{
  host: Pick<
    DurableDelegatedWork,
    | 'delegate'
    | 'children'
    | 'collect'
    | 'stopChildren'
    | 'sendMessage'
    | 'messageReceipt'
    | 'resolveMessage'
    | 'submitOutput'
    | 'requestUserInput'
    | 'readAgentFrame'
  > &
    Readonly<{ isDelegationAllowed(session: SessionKey): Promise<boolean> }>
  root: RootDelegatedWorkControl
}>

type ScopedWork = Readonly<{ key: SessionKey; work: DurableDelegatedWork }>

const keyOf = (key: SessionKey): string => `${key.projectId}\u0000${key.sessionId}`

const permissionPublicId = (session: SessionKey, request: RootDelegatePermissionRequest): string =>
  `delegated:${encodeURIComponent(session.projectId)}:${encodeURIComponent(session.sessionId)}:${encodeURIComponent(request.frameId)}:${encodeURIComponent(request.attemptId)}:${encodeURIComponent(request.requestId)}`

const settlementSnapshot = (
  session: PersistedChatSession
): DelegationSettlementSnapshot | undefined => {
  const graph = materializeSessionConversationGraph(session).conversationGraph
  if (!graph) return undefined
  const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
  if (!rootFrame) return undefined
  const rootBranch = graph.branches.find(({ id }) => id === rootFrame.activeBranchId)
  if (!rootBranch) return undefined
  const activeRootMessages = resolveActiveConversationMessages({
    ...graph,
    activeFrameId: graph.rootFrameId
  })
  const durableRootRuntimeSegmentIds = new Set(
    graph.runtimeSegments
      .filter(({ agentFrameId }) => agentFrameId === graph.rootFrameId)
      .map(({ id }) => id)
  )
  const records = session.runtimeContext?.delegatedWork?.records ?? []
  return {
    projectId: session.projectId,
    sessionId: session.id,
    rootFrameId: graph.rootFrameId,
    rootBranchId: rootBranch.id,
    activeRootPromptIds: activeRootMessages.map(({ id }) => id),
    rootPromptRuntimeSegments: Object.fromEntries(
      activeRootMessages.flatMap(({ id, runtimeSegmentId }) =>
        runtimeSegmentId && durableRootRuntimeSegmentIds.has(runtimeSegmentId)
          ? [[id, runtimeSegmentId]]
          : []
      )
    ),
    attempts: records.flatMap((record) => {
      const frame = graph.frames.find(({ id }) => id === record.agentFrameId)
      if (!frame) return []
      return record.attempts.flatMap((attempt) =>
        attempt.initiatingTurnMessageId
          ? [
              {
                frameId: record.agentFrameId,
                attemptId: attempt.id,
                parentFrameId: frame.parentFrameId ?? '',
                originatingPromptId: attempt.initiatingTurnMessageId,
                name: frame.delegateName ?? frame.agentName ?? record.agentFrameId,
                status: attempt.status
              }
            ]
          : []
      )
    })
  }
}

const createProductionDelegatedWorkComposition = (
  options: ProductionDelegatedWorkOptions
): ProductionDelegatedWorkComposition => {
  const workspace = createProductionFrameWorkspace({
    root: join(options.dataRoot, 'delegation'),
    resolveInput: options.resolveInput
  })
  const works = new Map<string, Promise<ScopedWork>>()
  const permissions = new Map<
    string,
    Readonly<{ key: SessionKey; request: RootDelegatePermissionRequest }>
  >()
  const listeners = new Set<(event: RootDelegatedWorkEvent) => void>()
  const unavailableReasons = new Map<string, DelegatedWorkUnavailableReason>()
  const cancelledTurns = new Set<string>()
  const cancelledSessionTurns = new Set<string>()
  const cancelledTurnKey = (key: SessionKey, messageId: string): string =>
    `${keyOf(key)}\u0000${messageId}`
  const artifactEvidence = options.artifactEvidence
    ? createDelegatedArtifactEvidence(options.artifactEvidence)
    : undefined
  const reviewEvidence = options.reviewEvidence
    ? createDelegatedReviewEvidence(options.reviewEvidence)
    : undefined
  const settlementWake = options.settlementContinuations
    ? new DelegationSettlementWakeOwner({
        readSnapshot: async (sessionId) => {
          const sessions = (await options.sessions.findSessions?.(sessionId)) ?? []
          const matches = sessions.filter(({ id }) => id === sessionId)
          return matches.length === 1 ? settlementSnapshot(matches[0]) : undefined
        },
        dispatch: (request) => options.settlementContinuations!.dispatch(request)
      })
    : undefined

  const publish = (event: RootDelegatedWorkEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const projectPermission = (
    key: SessionKey,
    request: RootDelegatePermissionRequest
  ): AcpPermissionRequest => ({
    requestId: permissionPublicId(key, request),
    sessionId: key.sessionId,
    toolCallId: request.frameId,
    title: request.action,
    options: request.options.map((option) => ({ ...option })),
    delegated: {
      frameId: request.frameId,
      attemptId: request.attemptId,
      childTitle: request.childTitle,
      riskScope: request.riskScope
    }
  })
  const observePermission = (key: SessionKey, event: RootDelegatePermissionEvent): void => {
    const publicId = permissionPublicId(key, event.request)
    if (event.kind === 'requested') {
      permissions.set(publicId, { key, request: event.request })
      publish({ kind: 'permission-requested', request: projectPermission(key, event.request) })
      return
    }
    if (permissions.delete(publicId)) publish({ kind: 'permission-settled', requestId: publicId })
  }

  const createScopedWork = async (key: SessionKey): Promise<ScopedWork> => {
    const session = await options.sessions.readSession(key)
    if (!session || session.id !== key.sessionId || session.projectId !== key.projectId) {
      throw new Error('Delegated Work Session is unavailable.')
    }
    if (!session.agentFrameworkId) {
      throw new Error('Delegated Work requires a durable Session framework identity.')
    }
    const framework = await options.frameworks.forSession(session)
    if (framework.frameworkId !== session.agentFrameworkId) {
      throw new Error('Delegated Work framework composition does not match the durable Session.')
    }
    const records = createSessionDelegatedWorkRecords(
      {
        commands: options.sessions.commands,
        readSession: options.sessions.readSession,
        frameworkId: framework.frameworkId,
        onRecordsChanged: () => {
          publish({ kind: 'records-changed', sessionId: key.sessionId })
          void settlementWake?.onRecordsChanged(key.sessionId)
        }
      },
      key
    )
    const work = createDurableDelegatedWork({
      execution: framework.execution,
      records,
      resolveExecutionModel: async () => {
        try {
          return await options.resolveExecutionModel(session)
        } catch (error) {
          throw new DurableDelegatedWorkError(
            'admission_rejection',
            `configured Subagent model is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            'The configured Subagent model is unavailable. Open Settings → Model → Scenario models and choose an available model.'
          )
        }
      },
      assertAvailable: framework.assertAvailable,
      resolveSpecialist: options.resolveSpecialist,
      resolveSpecialistReference: options.resolveSpecialistReference,
      validateInput: (identity) => workspace.validateInput(identity, key),
      workspace,
      artifactEvidence,
      reviewEvidence,
      deliverToParent: options.parentMessages?.deliver,
      onRootPermissionEvent: (event) => observePermission(key, event),
      onAgentRuntimeUpdate: options.onAgentRuntimeUpdate,
      assertTurnOpen: (session, messageId) => {
        if (
          cancelledTurns.has(cancelledTurnKey(session, messageId)) ||
          cancelledSessionTurns.has(`${session.sessionId}\u0000${messageId}`)
        ) {
          throw new DurableDelegatedWorkError(
            'conflict',
            'the initiating Conversation Turn is cancelled and cannot admit delegated work'
          )
        }
      }
    })
    await work.recoverInterrupted()
    return Object.freeze({ key, work })
  }

  const workFor = (key: SessionKey): Promise<ScopedWork> => {
    const identity = keyOf(key)
    const existing = works.get(identity)
    if (existing) return existing
    const created = createScopedWork(key)
    works.set(identity, created)
    void created.catch(() => {
      if (works.get(identity) === created) works.delete(identity)
    })
    return created
  }
  const worksForSession = async (sessionId: string): Promise<ScopedWork[]> =>
    Promise.all(
      [...works.entries()]
        .filter(([identity]) => identity.endsWith(`\u0000${sessionId}`))
        .map(([, work]) => work)
    )
  const worksForProject = async (projectId: string): Promise<ScopedWork[]> =>
    Promise.all(
      [...works.entries()]
        .filter(([identity]) => identity.startsWith(`${projectId}\u0000`))
        .map(([, work]) => work)
    )

  const host: ProductionDelegatedWorkComposition['host'] = Object.freeze({
    async isDelegationAllowed(session) {
      return (await options.sessions.readSession(session))?.delegationPolicy !== 'deny'
    },
    async delegate(caller, request, delegateOptions) {
      try {
        const policySession = await options.sessions.readSession(caller.session)
        if (policySession?.delegationPolicy === 'deny') {
          throw DurableDelegatedWorkError.delegationDisabled()
        }
        const result = await (
          await workFor(caller.session)
        ).work.delegate(caller, request, delegateOptions)
        const unobserved =
          result.kind === 'receipts'
            ? result.children
            : result.kind === 'observations'
              ? result.children.filter(
                  ({ status }) => status === 'running' || status === 'awaiting_user'
                )
              : []
        if (unobserved.length > 0) {
          settlementWake?.trackUnobservedAttempts({
            sessionId: caller.session.sessionId,
            originatingPromptId: caller.originMessageId,
            attempts: unobserved
          })
        }
        unavailableReasons.delete(caller.session.sessionId)
        return result
      } catch (error) {
        const session = await options.sessions.readSession(caller.session)
        if (
          error instanceof DurableDelegatedWorkError &&
          error.userFacingUnavailableReason &&
          (session?.runtimeContext?.delegatedWork?.records.length ?? 0) === 0
        ) {
          const reason = error.userFacingUnavailableReason
          unavailableReasons.set(caller.session.sessionId, {
            kind: error.unavailableKind ?? 'unavailable',
            reason
          })
          publish({
            kind: 'admission-rejected',
            sessionId: caller.session.sessionId,
            reason
          })
        }
        throw error
      }
    },
    async children(caller, frameIds) {
      return (await workFor(caller.session)).work.children(caller, frameIds)
    },
    async collect(caller, selectors, collectOptions) {
      const observations = await (
        await workFor(caller.session)
      ).work.collect(caller, selectors, collectOptions)
      const observed = observations.filter(
        ({ status }) => status !== 'running' && status !== 'awaiting_user'
      )
      if (observed.length > 0) {
        settlementWake?.markAttemptsObserved({
          sessionId: caller.session.sessionId,
          originatingPromptId: caller.originMessageId,
          attempts: observed
        })
      }
      return observations
    },
    async submitOutput(caller, value) {
      return (await workFor(caller.session)).work.submitOutput(caller, value)
    },
    async requestUserInput(caller, request, requestId) {
      return (await workFor(caller.session)).work.requestUserInput(caller, request, requestId)
    },
    async stopChildren(caller, frameIds) {
      return (await workFor(caller.session)).work.stopChildren(caller, frameIds)
    },
    async sendMessage(caller, targetFrameId, message, messageOptions) {
      return (await workFor(caller.session)).work.sendMessage(
        caller,
        targetFrameId,
        message,
        messageOptions
      )
    },
    async messageReceipt(caller, selector, receiptOptions) {
      return (await workFor(caller.session)).work.messageReceipt(caller, selector, receiptOptions)
    },
    async resolveMessage(caller, messageId, resolveOptions) {
      return (await workFor(caller.session)).work.resolveMessage(caller, messageId, resolveOptions)
    },
    async readAgentFrame(session, frameId) {
      return (await workFor(session)).work.readAgentFrame(session, frameId)
    }
  })

  const stopScopedWork = async (): Promise<void> => {
    const scoped = await Promise.all([...works.values()])
    await Promise.all(scoped.map(({ key, work }) => work.stopSession(key)))
  }

  const root: RootDelegatedWorkControl = Object.freeze({
    pendingPermissions: () =>
      Object.freeze(
        [...permissions.values()].map(({ key, request }) => projectPermission(key, request))
      ),
    unavailableReasons: () => Object.freeze(Object.fromEntries(unavailableReasons)),
    // Re-enabling Delegation for a Session invalidates the last admission rejection; clearing it
    // unpublishes the stale notice in the next runtime state snapshot.
    clearUnavailableReason(sessionId: string) {
      if (!unavailableReasons.delete(sessionId)) return
      publish({ kind: 'unavailable-reason-cleared', sessionId })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async respondToPermission(response) {
      const pending = permissions.get(response.requestId)
      if (!pending) {
        if (response.requestId.startsWith('delegated:')) {
          throw new Error('Delegated permission request is no longer active.')
        }
        return false
      }
      const scoped = await workFor(pending.key)
      await scoped.work.respondToPermission(pending.key, {
        frameId: pending.request.frameId,
        attemptId: pending.request.attemptId,
        requestId: pending.request.requestId,
        ...(response.optionId ? { optionId: response.optionId } : {}),
        ...(response.cancelled ? { cancelled: true } : {})
      })
      return true
    },
    async setPermissionProfile(sessionId, profile) {
      const scoped = await worksForSession(sessionId)
      await Promise.all(scoped.map(({ key, work }) => work.setPermissionProfile(key, profile)))
    },
    async cancelTurn(sessionId, initiatingTurnMessageId) {
      const settlementInvalidation = settlementWake?.invalidateBranch(
        sessionId,
        initiatingTurnMessageId
      )
      cancelledSessionTurns.add(`${sessionId}\u0000${initiatingTurnMessageId}`)
      const pendingScoped = [...works.entries()].filter(([identity]) =>
        identity.endsWith(`\u0000${sessionId}`)
      )
      // Fence synchronously, before the first await. Host admissions already holding this scoped work
      // re-check the composition-owned fence immediately before their durable commit.
      for (const [identity] of pendingScoped) {
        cancelledTurns.add(`${identity}\u0000${initiatingTurnMessageId}`)
      }
      const scoped = await Promise.all(pendingScoped.map(([, work]) => work))
      await Promise.all([
        settlementInvalidation,
        ...scoped.map(({ key, work }) => work.cancelTurn(key, initiatingTurnMessageId))
      ])
    },
    async stopActiveBranch(sessionId) {
      const scoped = await worksForSession(sessionId)
      const results = await Promise.allSettled(
        scoped.map(({ key, work }) => work.stopActiveBranch(key))
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more Subagent Attempts could not be stopped.')
      }
    },
    async stopSession(sessionId) {
      settlementWake?.invalidateSession(sessionId)
      const scoped = await worksForSession(sessionId)
      await Promise.all(scoped.map(({ key, work }) => work.stopSession(key)))
    },
    async respondQuestion(input) {
      const key = { projectId: input.projectId, sessionId: input.sessionId }
      const work = (await workFor(key)).work
      if (input.action === 'draft') {
        if (input.questionIndex === undefined) {
          throw new Error('Delegated question draft requires a question index.')
        }
        await work.updateQuestionDraft(key, {
          requestId: input.requestId,
          draftAnswers: input.answers,
          questionIndex: input.questionIndex
        })
        return
      }
      await work.confirmQuestion(key, { requestId: input.requestId, answers: input.answers })
    },
    async wakeMessages(sessionId) {
      const durableSessions = (await options.sessions.findSessions?.(sessionId)) ?? []
      await Promise.all(
        durableSessions
          .filter((session) => session.id === sessionId)
          .filter(
            (session) =>
              session.agentFrameworkId === undefined ||
              getAgentFramework(session.agentFrameworkId).supportsDelegatedWork
          )
          // A pre-framework-identity Session cannot contain app-owned delegated work. Let its ACP
          // resume return the resolved framework so the existing renderer persistence path can
          // durably adopt it. If delegated state exists, keep createScopedWork's strict identity
          // check because guessing would risk replaying work through the wrong framework.
          .filter(
            (session) =>
              session.agentFrameworkId !== undefined ||
              session.runtimeContext?.delegatedWork !== undefined
          )
          .map((session) => workFor({ projectId: session.projectId, sessionId: session.id }))
      )
      const scoped = await worksForSession(sessionId)
      await Promise.all(scoped.map(({ work }) => work.wakeMessages()))
    },
    async rootTurnEnded(input) {
      await settlementWake?.onRootTurnEnded(input)
    },
    async rootTurnStarted(input) {
      return settlementWake?.onRootTurnStarted(input)
    },
    async settlementPromptEnded(sessionId, promptId) {
      await settlementWake?.onWakePromptEnded(sessionId, promptId)
    },
    async stopAll() {
      settlementWake?.invalidateAll()
      await stopScopedWork()
    },
    async shutdown() {
      settlementWake?.shutdown()
      await stopScopedWork()
    },
    async deleteSession(sessionId) {
      settlementWake?.invalidateSession(sessionId)
      const scoped = await worksForSession(sessionId)
      const durableSessions = (await options.sessions.findSessions?.(sessionId)) ?? []
      const keys = new Map<string, SessionKey>()
      for (const { key } of scoped) keys.set(keyOf(key), key)
      for (const session of durableSessions) {
        if (session.id === sessionId) {
          const key = { projectId: session.projectId, sessionId: session.id }
          keys.set(keyOf(key), key)
        }
      }
      const workDeletion = await Promise.allSettled(
        scoped.map(({ key, work }) => work.deleteSession(key))
      )
      // Workspace deletion is an independent durable cleanup boundary. Repeat it for every Session
      // identity so a restart (with an empty work cache) and a failed work teardown both remove the
      // stable Frame subtree.
      const workspaceDeletion = await Promise.allSettled(
        [...keys.values()].map((key) => workspace.deleteSession(key))
      )
      for (const { key } of scoped) works.delete(keyOf(key))
      for (const [requestId, pending] of permissions) {
        if (pending.key.sessionId === sessionId) permissions.delete(requestId)
      }
      unavailableReasons.delete(sessionId)
      const failures = [...workDeletion, ...workspaceDeletion].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(failures, `Delegated Session cleanup failed: ${sessionId}`)
      }
    },
    async deleteProject(projectId) {
      await settlementWake?.invalidateProject(projectId)
      const scoped = await worksForProject(projectId)
      const workDeletion = await Promise.allSettled(
        scoped.map(({ key, work }) => work.deleteSession(key))
      )
      // The stable Project directory is authoritative for dormant workspaces. Removing it directly
      // covers Sessions that have no in-memory work after restart as well as every cached Session
      // settled above.
      const workspaceDeletion = await Promise.allSettled([workspace.deleteProject(projectId)])
      for (const [index, result] of workDeletion.entries()) {
        if (result.status === 'rejected') continue
        const { key } = scoped[index]
        works.delete(keyOf(key))
        for (const [requestId, pending] of permissions) {
          if (pending.key.projectId === key.projectId && pending.key.sessionId === key.sessionId) {
            permissions.delete(requestId)
          }
        }
        unavailableReasons.delete(key.sessionId)
      }
      const failures = [...workDeletion, ...workspaceDeletion].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(failures, `Delegated Project cleanup failed: ${projectId}`)
      }
    }
  })

  return Object.freeze({ host, root })
}

export { createProductionDelegatedWorkComposition }
export type {
  CertifiedSessionFramework,
  ProductionDelegatedWorkComposition,
  ProductionDelegatedWorkOptions,
  RootDelegatedWorkControl,
  RootDelegatedWorkEvent
}
