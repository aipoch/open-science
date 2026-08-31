import { randomUUID } from 'node:crypto'

import type { AcpAgentRuntimeUpdate } from '../../shared/acp'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  DelegateExecutionError,
  DelegateMessagePreAcceptanceError,
  type DelegateCapacityReservation,
  type DelegateExecutionBackendClaim,
  type DelegateExecution,
  type DelegateExecutionInput,
  type DelegateMessageAcceptanceEvidence
} from './execution-port'
import { RootDelegatePermissionOwner } from './delegated-work-permissions'
import { DelegatedWorkProjectionOwner } from './delegated-work-projection'
import { DelegatedWorkReadModel } from './delegated-work-read-model'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import { createAdmissionGate, DelegatedWorkAdmissionPolicy } from './delegated-work-admission'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { createInMemoryDelegatedWorkRecords } from './in-memory-delegated-work-records'
import {
  createAttemptRuntimeTranscriptStager,
  terminalizeUnsuccessfulAttempt
} from './attempt-runtime-transcript'
import {
  createDelegatedTurnLifecycle,
  type DelegatedArtifactEvidence,
  type DelegatedArtifactHandle,
  type DelegatedArtifactProjectionScope,
  type DelegatedArtifactScope
} from './delegated-turn-lifecycle'
import type {
  DelegatedWorkDurableRecords,
  DurableChild,
  DurableChildSummary,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableDelegateOutcome,
  DurableDelegateResult,
  DurableMessageCommand,
  DurablePendingMessage
} from './delegated-work-record-types'
import type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
import type {
  CreateDurableDelegatedWorkOptions,
  DelegatedReviewEvidence,
  DelegatedReviewProjectionScope,
  DurableDelegateRequest,
  DurableDelegatedWork,
  DurableSendMessageOutcome,
  DurableSendMessageOptions,
  ParentMessageDelivery,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  RootDelegatePermissionEvent,
  RootDelegatePermissionRequest,
  RootDelegatePermissionResponse,
  SessionKey,
  SessionSubagentSummary,
  SpecialistDelegationProfile,
  StopOutcome
} from './durable-delegated-work-contract'
import { submitStructuredOutput } from './structured-output-submission'
import { ReliableMessageDeliveryOwner } from './message-delivery-owner'
import { DelegatedUserQuestionOwner } from './delegated-user-question-owner'
import { toErrorMessage } from '../error-message'

const createDurableDelegatedWork = (
  options: CreateDurableDelegatedWorkOptions
): DurableDelegatedWork => {
  const now = options.now ?? Date.now
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const invocationOutcomes = new Map<string, Promise<DurableDelegateOutcome>>()
  const stoppingSessions = new Set<string>()
  const cancelledTurns = new Set<string>()
  const withAdmissionLock = createAdmissionGate()
  const turnIdentity = (session: SessionKey, messageId: string): string =>
    `${session.projectId}\u0000${session.sessionId}\u0000${messageId}`
  const assertTurnOpen = async (session: SessionKey, messageId: string): Promise<void> => {
    if (cancelledTurns.has(turnIdentity(session, messageId))) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'the initiating Conversation Turn is cancelled and cannot admit delegated work'
      )
    }
    await options.assertTurnOpen?.(session, messageId)
  }
  const permissionOwner = new RootDelegatePermissionOwner(
    options.records,
    options.onRootPermissionEvent
  )
  const projectionOwner = new DelegatedWorkProjectionOwner(
    options.records,
    options.artifactEvidence,
    options.reviewEvidence
  )
  const readModel = new DelegatedWorkReadModel(
    options.records,
    projectionOwner,
    options.collectPollIntervalMs ?? 10,
    options.collectMonotonicNow,
    (snapshot, child) =>
      snapshot.questionRequests.some(
        (request) => request.sourceFrameId === child.frameId && request.status === 'pending'
      )
  )
  const admissionPolicy = new DelegatedWorkAdmissionPolicy(
    options.resolveSpecialist,
    options.resolveSpecialistReference,
    options.validateInput
  )
  const running = new Map<
    string,
    {
      attemptId: string
      completion: Promise<void>
      deliver(message: DurablePendingMessage): Promise<DelegateMessageAcceptanceEvidence>
      setPermissionProfile(profile: PermissionProfileId): Promise<void>
      cancel(reason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'): Promise<void>
      executionStarted(): boolean
      reservation: DelegateCapacityReservation
      slotId: string
      artifact?: DelegatedArtifactHandle
    }
  >()

  const snapshotChild = async (frameId: string): Promise<DurableChild | undefined> =>
    (await options.records.snapshot()).records.find((child) => child.frameId === frameId) as
      DurableChild | undefined

  const launch = (
    child: DurableChild,
    session: SessionKey,
    reservation: DelegateCapacityReservation,
    slotId: string,
    task = child.task,
    continuation = false,
    executionBackendClaim?: DelegateExecutionBackendClaim
  ): Readonly<{
    completion: Promise<void>
    established: Promise<void>
    accepted: Promise<DelegateMessageAcceptanceEvidence>
  }> => {
    const attempt = currentAttempt(child)
    const runtimeSegmentId = createId('runtime')
    let handle: ReturnType<DelegateExecution['run']> | undefined
    let resolveHandle!: (value: ReturnType<DelegateExecution['run']>) => void
    let rejectHandle!: (error: unknown) => void
    let markEstablished!: () => void
    const established = new Promise<void>((resolve) => {
      markEstablished = resolve
    })
    const deliveryHandle = new Promise<ReturnType<DelegateExecution['run']>>((resolve, reject) => {
      resolveHandle = resolve
      rejectHandle = reject
    })
    void deliveryHandle.catch(() => undefined)
    const runtimeUpdates: AcpAgentRuntimeUpdate[] = []
    const turnLifecycle = createDelegatedTurnLifecycle({
      records: options.records,
      artifactEvidence: options.artifactEvidence,
      session,
      attemptId: attempt.id,
      agentFrameId: child.frameId,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      runtimeUpdates,
      now,
      createMessageId: () => createId('message')
    })
    let cancelRequested = false
    let cancellationReason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted' =
      'main_agent_stop'
    let context: Awaited<ReturnType<DelegatedWorkDurableRecords['startRuntime']>> | undefined
    const stageRuntimeTranscript = createAttemptRuntimeTranscriptStager({
      records: options.records,
      frameId: child.frameId,
      attemptId: attempt.id,
      updates: runtimeUpdates,
      runtimeScope: () => {
        const unstagedScope = turnLifecycle.unstagedRuntimeScope(context)
        return unstagedScope
          ? {
              runtimeSegmentId: unstagedScope.runtimeSegmentId,
              promptMessageId: unstagedScope.promptMessageId
            }
          : undefined
      },
      createMessageId: () => createId('message')
    })
    const completion = (async () => {
      try {
        const workspace = await options.workspace?.prepare(session, child.frameId, child.inputs)
        const startedContext = await options.records.startRuntime(
          child.frameId,
          attempt.id,
          runtimeSegmentId
        )
        context = startedContext
        const latest = await snapshotChild(child.frameId)
        if (cancelRequested || !latest || currentAttempt(latest).status !== 'running') {
          throw new Error('delegate execution was cancelled before launch establishment')
        }
        await turnLifecycle.openInitial(startedContext)
        const artifact = turnLifecycle.currentArtifact()
        const runningAttempt = running.get(child.frameId)
        if (runningAttempt?.attemptId === attempt.id) runningAttempt.artifact = artifact
        const ready = await snapshotChild(child.frameId)
        if (cancelRequested || !ready || currentAttempt(ready).status !== 'running') {
          throw new Error('delegate execution was cancelled before launch establishment')
        }
        const executionInput: DelegateExecutionInput = {
          session,
          frameId: child.frameId,
          attemptId: attempt.id,
          runtimeSegmentId,
          executionModel: attempt.executionModel!,
          ...(executionBackendClaim ? { executionBackend: executionBackendClaim.backend } : {}),
          task,
          inputs: child.inputs,
          ...(workspace ? { workspaceCwd: workspace.cwd } : {}),
          ...(attempt.resolvedAgent.kind === 'specialist'
            ? { profile: attempt.resolvedAgent.profileId }
            : {}),
          ...(artifact?.execution
            ? { artifactCurrentRunFile: artifact.execution.currentRunFile }
            : {}),
          ...(continuation || child.outputSchema === undefined
            ? {}
            : { outputSchema: structuredClone(child.outputSchema) }),
          continuation,
          turn: turnLifecycle.create(startedContext, true)
        }
        handle = options.execution.run(executionInput, slotId)
        resolveHandle(handle)
        markEstablished()
        const unsubscribe = handle.subscribe((event) => {
          permissionOwner.observe(child.frameId, attempt.id, child.title, handle!, event)
          if (event.kind !== 'runtime') return
          const { scope: eventScope } = event.update
          if (
            eventScope.projectId !== session.projectId ||
            eventScope.sessionId !== session.sessionId ||
            eventScope.agentFrameId !== child.frameId ||
            eventScope.attemptId !== attempt.id ||
            !eventScope.runtimeSegmentId ||
            !eventScope.promptMessageId
          ) {
            return
          }
          runtimeUpdates.push(event.update)
          options.onAgentRuntimeUpdate?.(event.update)
        })
        void handle.completion.finally(unsubscribe).catch(() => undefined)
        await Promise.race([handle.accepted, handle.completion.then(() => undefined)])
        const outcome = await handle.completion
        const endedAt = now()
        if (outcome.status === 'completed' && !cancelRequested) {
          const lastTurnMessage = turnLifecycle.lastTurnMessage()
          const transcript = lastTurnMessage
            ? undefined
            : await stageRuntimeTranscript({
                terminalStatus: 'completed',
                endedAt,
                fallbackResponse: outcome.response,
                ...(outcome.turnUsage
                  ? {
                      turnUsage: outcome.turnUsage,
                      ...(outcome.modelCallUsage ? { modelCallUsage: outcome.modelCallUsage } : {})
                    }
                  : outcome.turnUsageUnavailable
                    ? { turnUsageUnavailable: true }
                    : {})
              })
          const terminalMessage = lastTurnMessage ?? transcript?.terminalMessage
          if (!terminalMessage)
            throw new Error('Completed delegated runtime has no terminal Message.')
          if (!lastTurnMessage) await turnLifecycle.finalizeFallback(terminalMessage.id)
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'completed',
            endedAt,
            terminalMessage
          })
        } else {
          await stageRuntimeTranscript({ terminalStatus: 'cancelled', endedAt })
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'cancelled',
            endedAt,
            cancellationReason
          })
        }
      } catch (error) {
        rejectHandle(
          handle ? error : new DelegateMessagePreAcceptanceError(toErrorMessage(error), error)
        )
        try {
          const latest = await snapshotChild(child.frameId)
          if (latest && currentAttempt(latest).status === 'running') {
            const endedAt = now()
            try {
              await terminalizeUnsuccessfulAttempt(options.records, stageRuntimeTranscript, {
                frameId: child.frameId,
                attemptId: attempt.id,
                endedAt,
                error,
                ...(cancelRequested ? { cancellationReason } : {})
              })
            } catch (terminalizeError) {
              const settled = await snapshotChild(child.frameId)
              if (!settled || currentAttempt(settled).status === 'running') throw terminalizeError
            }
          }
        } finally {
          markEstablished()
        }
      } finally {
        permissionOwner.clearAttempt(child.frameId, attempt.id)
        await turnLifecycle.dispose()
        await executionBackendClaim?.release().catch(() => undefined)
        await reservation.release(slotId).catch(() => undefined)
        if (running.get(child.frameId)?.attemptId === attempt.id) running.delete(child.frameId)
      }
    })()
    running.set(child.frameId, {
      attemptId: attempt.id,
      completion,
      async deliver(message) {
        if (!context) throw new Error('delegate execution has no active child Turn')
        const pendingContext = {
          rootFrameId: context.rootFrameId,
          messageBranchId: context.messageBranchId,
          promptMessageId: createId('message'),
          runtimeSegmentId: createId('runtime')
        }
        const lifecycle = turnLifecycle.create(pendingContext, false)
        return (await deliveryHandle).sendMessage(message.text, {
          ...lifecycle,
          async begin() {
            context = await options.records.startPendingTurn(
              child.frameId,
              attempt.id,
              message.id,
              pendingContext.promptMessageId,
              pendingContext.runtimeSegmentId
            )
            await lifecycle.begin?.()
          }
        })
      },
      async setPermissionProfile(profile) {
        await (await deliveryHandle).setPermissionProfile(profile)
      },
      async cancel(reason) {
        cancelRequested = true
        cancellationReason = reason
        rejectHandle(new Error('delegate execution was cancelled before message delivery'))
        await handle?.cancel()
      },
      executionStarted: () => handle !== undefined,
      reservation,
      slotId
    })
    const accepted = deliveryHandle.then((candidate) => candidate.accepted)
    void accepted.catch(() => undefined)
    return { completion, established, accepted }
  }

  const prepareMessageContinuation = async (
    caller: AuthenticatedDelegateCaller,
    child: DurableChild,
    draft: DurableMessageCommand
  ): Promise<
    Readonly<{
      start(): Readonly<{ accepted: Promise<DelegateMessageAcceptanceEvidence> }>
      abort(): Promise<void>
    }>
  > => {
    const previous = currentAttempt(child)
    const priorExecution = running.get(child.frameId)
    if (priorExecution?.attemptId === previous.id) await priorExecution.completion
    try {
      await options.assertAvailable?.(caller)
    } catch (error) {
      if (error instanceof DurableDelegatedWorkError) throw error
      throw new DurableDelegatedWorkError('unsupported_framework', toErrorMessage(error))
    }
    const resolvedAgent =
      previous.resolvedAgent.kind === 'main'
        ? ({ kind: 'main' } as const)
        : await admissionPolicy.resolveAgent(previous.resolvedAgent.profileId)
    const executionModel = child.attempts[0]?.executionModel
    if (!executionModel) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'historical delegated work has no stable Subagent model snapshot'
      )
    }
    let reservation: DelegateCapacityReservation
    try {
      reservation = await options.execution.reserve(1)
    } catch (error) {
      if (error instanceof DelegateExecutionError) {
        throw new DurableDelegatedWorkError(error.code, error.message)
      }
      throw new DurableDelegatedWorkError('capacity', toErrorMessage(error))
    }
    const attemptId = createId('attempt')
    const command: DurableMessageCommand = { ...draft, continuationAttemptId: attemptId }
    try {
      await assertTurnOpen(caller.session, caller.originMessageId)
      await options.records.continueChild({
        frameId: child.frameId,
        previousAttemptId: previous.id,
        attemptId,
        userMessageId: createId('message'),
        message: command.text.trim(),
        resolvedAgent,
        executionModel,
        startedAt: now(),
        callerSource: {
          rootMessageId: caller.originMessageId,
          toolInvocationId: caller.toolInvocationId
        },
        initiatingTurnMessageId: caller.originMessageId,
        messageCommand: command
      })
    } catch (error) {
      await reservation.releaseAll()
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'revision-conflict' || error.code === 'attempt-conflict')
      ) {
        throw new DurableDelegatedWorkError(
          'conflict',
          `child ${child.frameId} changed while continuation was admitted`
        )
      }
      throw error
    }
    const continued = (await snapshotChild(child.frameId))!
    return {
      start: () =>
        launch(
          continued,
          caller.session,
          reservation,
          reservation.slotIds[0],
          command.text.trim(),
          true
        ),
      abort: () => reservation.releaseAll()
    }
  }

  const messageDeliveryOwner = new ReliableMessageDeliveryOwner({
    records: options.records,
    now,
    admission: withAdmissionLock,
    deliverToParent: options.deliverToParent,
    runningDelivery(frameId, attemptId) {
      const active = running.get(frameId)
      return active?.attemptId === attemptId ? active : undefined
    },
    prepareContinuation: prepareMessageContinuation
  })

  const questionOwner = new DelegatedUserQuestionOwner({
    records: options.records,
    now,
    createId,
    admission: withAdmissionLock,
    resolveAgent: (profileId) => admissionPolicy.resolveAgent(profileId),
    reserve: () => options.execution.reserve(1),
    waitForAttemptCompletion: async (frameId, attemptId) => {
      const active = running.get(frameId)
      if (active?.attemptId === attemptId) await active.completion
    },
    launchContinuation: ({ child, session, reservation, message }) => {
      launch(child, session, reservation, reservation.slotIds[0], message, true)
    }
  })

  const stopChild = async (
    child: DurableChild,
    reason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
  ): Promise<StopOutcome> => {
    await options.records.cancelQuestions(child.frameId, now(), 'Subagent was stopped.')
    const attempt = currentAttempt(child)
    if (attempt.status !== 'running') {
      return { frameId: child.frameId, status: 'already_terminal' }
    }
    const snapshot = await options.records.snapshot()
    const session = snapshot.session
    const scope = { session, frameId: child.frameId, attemptId: attempt.id }
    const pendingPermissions = permissionOwner.takeAttempt(child.frameId, attempt.id)
    const evidenceScope = projectionOwner.attemptScope(snapshot, child, attempt)
    try {
      if (evidenceScope) await options.artifactEvidence?.revoke?.(evidenceScope)
      const candidate = running.get(child.frameId)
      const active = candidate?.attemptId === attempt.id ? candidate : undefined
      await active?.artifact?.dispose()
      await options.revokeAttemptWrites?.(scope)
      const executionStarted = active?.executionStarted() === true
      await active?.cancel(reason).catch(() => undefined)
      await options.settleAttemptCleanup?.(scope)
      if (executionStarted) await active?.completion
      const latest = await snapshotChild(child.frameId)
      if (latest && currentAttempt(latest).status !== 'running') {
        // Pre-execution completion still owns workspace preparation and reservation cleanup.
        if (!executionStarted) await active?.completion
        return currentAttempt(latest).status === 'cancelled'
          ? { frameId: child.frameId, status: 'cancelled' }
          : { frameId: child.frameId, status: 'already_terminal' }
      }
      await options.records.terminalize({
        frameId: child.frameId,
        attemptId: attempt.id,
        status: 'cancelled',
        endedAt: now(),
        cancellationReason: reason
      })
      if (!executionStarted) await active?.completion
      return { frameId: child.frameId, status: 'cancelled' }
    } catch (error) {
      const latest = await snapshotChild(child.frameId)
      if (latest && currentAttempt(latest).status !== 'running') {
        const settledAttempt = currentAttempt(latest)
        return settledAttempt.status === 'cancelled' && settledAttempt.cancellationReason === reason
          ? { frameId: child.frameId, status: 'cancelled' }
          : { frameId: child.frameId, status: 'already_terminal' }
      }
      permissionOwner.restoreAttempt(pendingPermissions)
      throw error
    }
  }

  const stopSession = async (session: SessionKey): Promise<readonly StopOutcome[]> => {
    const sessionIdentity = `${session.projectId}\u0000${session.sessionId}`
    if (stoppingSessions.has(sessionIdentity)) {
      throw new DurableDelegatedWorkError('conflict', 'the Session is already stopping')
    }
    stoppingSessions.add(sessionIdentity)
    try {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return []
      const runningSnapshot = snapshot.records.filter(
        (child) =>
          currentAttempt(child as DurableChild).status === 'running' ||
          snapshot.questionRequests.some(
            (request) => request.sourceFrameId === child.frameId && request.status === 'pending'
          )
      ) as readonly DurableChild[]
      const settled = await Promise.allSettled(
        runningSnapshot.map((child) => stopChild(child, 'session_stop'))
      )
      const failure = settled.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      return settled.map((result) => (result as PromiseFulfilledResult<StopOutcome>).value)
    } finally {
      stoppingSessions.delete(sessionIdentity)
    }
  }

  const stopPinnedChildren = async (
    children: readonly DurableChild[],
    reason: 'main_agent_stop' | 'session_stop' | 'runtime_interrupted',
    forceTerminalOnFailure = false
  ): Promise<readonly StopOutcome[]> => {
    const settled = await Promise.allSettled(children.map((child) => stopChild(child, reason)))
    const failures: unknown[] = []
    for (const [index, result] of settled.entries()) {
      if (result.status !== 'rejected') continue
      failures.push(result.reason)
      if (!forceTerminalOnFailure) continue
      const child = children[index]
      const pinnedAttempt = currentAttempt(child)
      const candidate = running.get(child.frameId)
      const active = candidate?.attemptId === pinnedAttempt.id ? candidate : undefined
      const settleBestEffort = async (
        operation: () => unknown | Promise<unknown>
      ): Promise<void> => {
        try {
          await operation()
        } catch (cleanupError) {
          failures.push(cleanupError)
        }
      }
      await settleBestEffort(() => active?.cancel(reason))
      try {
        const cleanupSnapshot = await options.records.snapshot()
        const session = cleanupSnapshot.session
        const scope = { session, frameId: child.frameId, attemptId: pinnedAttempt.id }
        const evidenceScope = projectionOwner.attemptScope(cleanupSnapshot, child, pinnedAttempt)
        await settleBestEffort(() =>
          evidenceScope ? options.artifactEvidence?.revoke?.(evidenceScope) : undefined
        )
        await settleBestEffort(() => active?.artifact?.dispose())
        await settleBestEffort(() => options.revokeAttemptWrites?.(scope))
        await settleBestEffort(() => options.settleAttemptCleanup?.(scope))
        await settleBestEffort(() => active?.completion)
        const latest = await snapshotChild(child.frameId)
        if (
          latest &&
          currentAttempt(latest).id === pinnedAttempt.id &&
          currentAttempt(latest).status === 'running'
        ) {
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: pinnedAttempt.id,
            status: 'cancelled',
            endedAt: now(),
            cancellationReason: reason
          })
        }
      } catch (terminalizeError) {
        failures.push(terminalizeError)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more Subagent Attempts could not be stopped.')
    }
    return settled.map((result) => (result as PromiseFulfilledResult<StopOutcome>).value)
  }

  const delegateOnce = async (
    caller: AuthenticatedDelegateCaller,
    requestOrRequests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    delegateOptions: Readonly<{ wait?: boolean; timeoutSeconds?: number }>
  ): Promise<DurableDelegateOutcome> => {
    if (
      delegateOptions.timeoutSeconds !== undefined &&
      (typeof delegateOptions.timeoutSeconds !== 'number' ||
        !Number.isFinite(delegateOptions.timeoutSeconds) ||
        delegateOptions.timeoutSeconds < 0 ||
        delegateOptions.timeoutSeconds > 1800)
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegate timeoutSeconds must be a finite number from 0 through 1800'
      )
    }
    if (delegateOptions.wait === false && delegateOptions.timeoutSeconds !== undefined) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegate wait:false cannot be combined with timeoutSeconds'
      )
    }
    const sessionIdentity = `${caller.session.projectId}\u0000${caller.session.sessionId}`
    if (stoppingSessions.has(sessionIdentity)) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'the Session is stopping and cannot accept delegated work'
      )
    }
    if (caller.role !== 'main') {
      throw new DurableDelegatedWorkError('authorization', 'only the Main Agent can delegate work')
    }
    await assertTurnOpen(caller.session, caller.originMessageId)
    const admission = await options.records.snapshot()
    if (
      !sameSession(admission.session, caller.session) ||
      caller.frameId !== admission.rootFrameId ||
      !admission.originMessageIds.includes(caller.originMessageId) ||
      !caller.toolInvocationId.trim()
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegation caller or origin Message is outside the active root conversation'
      )
    }
    try {
      await options.assertAvailable?.(caller)
    } catch (error) {
      if (error instanceof DurableDelegatedWorkError) throw error
      throw new DurableDelegatedWorkError(
        'unsupported_framework',
        toErrorMessage(error),
        'Delegated work is unavailable for this Agent framework configuration. Open Settings and choose a certified configuration.'
      )
    }
    const { requests, resolvedAgents, contracts } = await admissionPolicy.admit(
      requestOrRequests,
      caller.parentSpecialistId
    )
    const executionModelAdmission = await options.resolveExecutionModel(caller)
    const executionModel = executionModelAdmission.snapshot
    let admissions: ReturnType<typeof admissionPolicy.buildChildren>
    try {
      admissions = admissionPolicy.buildChildren(
        requests,
        resolvedAgents,
        contracts,
        executionModel,
        createId,
        now
      )
    } catch (error) {
      await executionModelAdmission.backendLease?.release().catch(() => undefined)
      throw error
    }
    let reservation: DelegateCapacityReservation
    try {
      reservation = await options.execution.reserve(requests.length)
    } catch (error) {
      await executionModelAdmission.backendLease?.release().catch(() => undefined)
      if (error instanceof DelegateExecutionError) {
        throw new DurableDelegatedWorkError(error.code, error.message)
      }
      throw new DurableDelegatedWorkError('capacity', toErrorMessage(error))
    }
    try {
      await withAdmissionLock(async () => {
        await assertTurnOpen(caller.session, caller.originMessageId)
        const committed = await options.records.admitChildren({
          caller,
          children: admissions
        })
        if (
          committed.length !== admissions.length ||
          committed.some(
            (child, index) =>
              child.frameId !== admissions[index].frameId ||
              child.attemptId !== admissions[index].attemptId
          )
        ) {
          throw new Error('Durable delegated-work admission returned mismatched children.')
        }
        admissions = admissions.map((admission, index) => ({
          ...admission,
          name: committed[index].name
        }))
      })
    } catch (error) {
      await Promise.allSettled([
        reservation.releaseAll(),
        executionModelAdmission.backendLease?.release() ?? Promise.resolve()
      ])
      throw error
    }
    const children: DurableChild[] = admissions.map((admission) => ({
      frameId: admission.frameId,
      parentFrameId: caller.frameId,
      originMessageId: caller.originMessageId,
      originBindingState: 'validated',
      title: admission.name,
      task: admission.request.task,
      outputSchema: admission.request.outputSchema,
      inputs: [...(admission.request.inputs ?? [])],
      messageBranchId: `branch-${admission.frameId}`,
      attempts: [
        {
          id: admission.attemptId,
          initiatingTurnMessageId: caller.originMessageId,
          status: 'running',
          resolvedAgent: structuredClone(admission.resolvedAgent),
          executionModel: structuredClone(admission.executionModel),
          runtimeSegmentIds: [],
          startedAt: admission.startedAt
        }
      ]
    }))
    const claims = children.map(() => executionModelAdmission.backendLease?.claim())
    await executionModelAdmission.backendLease?.release().catch(() => undefined)
    const launches = children.map((child, index) =>
      launch(
        child,
        caller.session,
        reservation,
        reservation.slotIds[index],
        child.task,
        false,
        claims[index]
      )
    )
    const completions = launches.map(({ completion }) => completion)
    const receipts = admissions.map(({ frameId, attemptId, name, resolvedAgent }) => ({
      frameId,
      attemptId,
      name,
      agentName: resolvedAgent.kind === 'specialist' ? resolvedAgent.displayName : 'Main Agent',
      status: 'running' as const
    }))
    if (delegateOptions.wait === false) return { kind: 'receipts', children: receipts }
    if (delegateOptions.timeoutSeconds !== undefined) {
      await Promise.all(launches.map(({ established }) => established))
      const observations = await readModel.collect(
        caller,
        admissions.map(({ frameId, attemptId }) => ({ frameId, attemptId })),
        { timeoutSeconds: delegateOptions.timeoutSeconds }
      )
      return { kind: 'observations', children: observations }
    }
    await Promise.all(completions)
    const frameSummaries = await readModel.children(
      caller,
      admissions.map(({ frameId }) => frameId)
    )
    const results = await Promise.all(
      admissions.map(({ frameId }) => {
        const summary = frameSummaries.find((candidate) => candidate.frameId === frameId)
        return summary?.status === 'awaiting_user'
          ? summary
          : projectionOwner.projectResult(frameId)
      })
    )
    if (results.some((result) => !result)) {
      throw new DurableDelegatedWorkError(
        'durability_failure',
        'delegated work did not reach a durable terminal state'
      )
    }
    if (results.some((result) => result?.status === 'awaiting_user')) {
      return {
        kind: 'observations',
        children: results as DurableDelegateObservation[]
      }
    }
    return { kind: 'results', children: results as DurableDelegateResult[] }
  }

  return Object.freeze({
    delegate(
      caller: AuthenticatedDelegateCaller,
      request: DurableDelegateRequest | readonly DurableDelegateRequest[],
      delegateOptions: Readonly<{ wait?: boolean; timeoutSeconds?: number }> = {}
    ): Promise<DurableDelegateOutcome> {
      const invocationKey = [
        caller.session.projectId,
        caller.session.sessionId,
        caller.frameId,
        caller.toolInvocationId
      ].join('\u0000')
      const existing = invocationOutcomes.get(invocationKey)
      if (existing) return existing
      const outcome = delegateOnce(caller, request, delegateOptions)
      invocationOutcomes.set(invocationKey, outcome)
      void outcome.catch(() => invocationOutcomes.delete(invocationKey))
      return outcome
    },
    async children(
      caller: AuthenticatedDelegateCaller,
      frameIds?: readonly string[]
    ): Promise<readonly DurableChildSummary[]> {
      return readModel.children(caller, frameIds)
    },
    async collect(
      caller: AuthenticatedDelegateCaller,
      selectors: readonly DurableCollectSelector[],
      collectOptions?: DurableCollectOptions
    ): Promise<readonly DurableDelegateObservation[]> {
      return readModel.collect(caller, selectors, collectOptions)
    },
    async submitOutput(caller, submittedValue) {
      return submitStructuredOutput(options.records, caller, submittedValue, now())
    },
    sendMessage(caller, targetFrameId, message, sendOptions) {
      return messageDeliveryOwner.sendMessage(caller, targetFrameId, message, sendOptions)
    },
    messageReceipt(caller, selector, receiptOptions) {
      return messageDeliveryOwner.messageReceipt(caller, selector, receiptOptions)
    },
    resolveMessage(caller, messageId, resolveOptions) {
      return messageDeliveryOwner.resolveMessage(caller, messageId, resolveOptions)
    },
    requestUserInput(caller, request, explicitRequestId) {
      return questionOwner.request(caller, request, explicitRequestId)
    },
    updateQuestionDraft(session, input) {
      return questionOwner.updateDraft(session, input)
    },
    confirmQuestion(session, input) {
      return questionOwner.confirm(session, input)
    },
    async sessionSummary(session: SessionKey): Promise<SessionSubagentSummary> {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return { runningCount: 0, children: [] }
      const children = snapshot.records.map((child) => {
        const attempt = currentAttempt(child as DurableChild)
        const awaitingPermission = permissionOwner.hasAwaiting(child.frameId, attempt.id)
        const awaitingUser = snapshot.questionRequests.some(
          (request) => request.sourceFrameId === child.frameId && request.status === 'pending'
        )
        return {
          frameId: child.frameId,
          title: child.title,
          status: awaitingUser ? ('awaiting_user' as const) : attempt.status,
          ...(attempt.status === 'running' && awaitingPermission
            ? { awaitingPermission: true }
            : {})
        }
      })
      return {
        runningCount: children.filter(
          (child) => child.status === 'running' || child.status === 'awaiting_user'
        ).length,
        children
      }
    },
    async readAgentFrame(session: SessionKey, frameId: string) {
      return projectionOwner.readAgentFrame(session, frameId)
    },
    async rootPermissionRequests(session) {
      return permissionOwner.requests(session)
    },
    async respondToPermission(session, response) {
      await permissionOwner.respond(session, response)
    },
    async setPermissionProfile(session, profile) {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return
      const failures = await Promise.all(
        [...running.entries()].map(async ([frameId, attempt]) => {
          try {
            await attempt.setPermissionProfile(profile)
            return undefined
          } catch (error) {
            const child = await snapshotChild(frameId)
            if (
              child &&
              currentAttempt(child).id === attempt.attemptId &&
              currentAttempt(child).status === 'running'
            ) {
              await stopChild(child, 'runtime_interrupted')
            }
            return error
          }
        })
      )
      const failure = failures.find((error) => error !== undefined)
      if (failure !== undefined) throw failure
    },
    async stopChildren(caller, frameIds) {
      const targets = await readModel.pinAuthorizedChildren(caller, frameIds)
      return stopPinnedChildren(targets, 'main_agent_stop')
    },
    async cancelTurn(session, initiatingTurnMessageId) {
      if (!initiatingTurnMessageId.trim()) {
        throw new DurableDelegatedWorkError('admission_rejection', 'Turn identity is required')
      }
      const targets = await withAdmissionLock(async () => {
        cancelledTurns.add(turnIdentity(session, initiatingTurnMessageId))
        const snapshot = await options.records.snapshot()
        if (!sameSession(snapshot.session, session)) return []
        return snapshot.records.filter((child) => {
          const attempt = currentAttempt(child as DurableChild)
          return (
            attempt.status === 'running' &&
            attempt.initiatingTurnMessageId === initiatingTurnMessageId
          )
        }) as readonly DurableChild[]
      })
      return stopPinnedChildren(targets, 'main_agent_stop', true)
    },
    async stopActiveBranch(session) {
      const snapshot = await options.records.snapshot()
      if (!sameSession(snapshot.session, session)) return []
      const targets = snapshot.records.filter((child) => {
        const attempt = currentAttempt(child as DurableChild)
        const awaitingUser = snapshot.questionRequests.some(
          (request) => request.sourceFrameId === child.frameId && request.status === 'pending'
        )
        return (
          child.originBindingState === 'validated' &&
          snapshot.originMessageIds.includes(child.originMessageId) &&
          (attempt.status === 'running' || awaitingUser)
        )
      }) as readonly DurableChild[]
      return stopPinnedChildren(targets, 'main_agent_stop')
    },
    stopSession,
    async recoverInterrupted() {
      const snapshot = await options.records.snapshot()
      const interrupted: DurableDelegateResult[] = []
      for (const child of snapshot.records as readonly DurableChild[]) {
        const attempt = currentAttempt(child)
        if (attempt.status !== 'running') continue
        const scope = { session: snapshot.session, frameId: child.frameId, attemptId: attempt.id }
        const evidenceScope = projectionOwner.attemptScope(snapshot, child, attempt)
        if (evidenceScope) await options.artifactEvidence?.revoke?.(evidenceScope)
        await options.revokeAttemptWrites?.(scope)
        await options.settleAttemptCleanup?.(scope)
        try {
          await options.records.terminalize({
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'cancelled',
            endedAt: now(),
            cancellationReason: 'runtime_interrupted'
          })
        } catch (error) {
          const latest = await snapshotChild(child.frameId)
          if (!latest || currentAttempt(latest).status === 'running') throw error
          continue
        }
        const result = await projectionOwner.projectResult(child.frameId)
        if (result) interrupted.push(result)
      }
      const recovered = await options.records.snapshot()
      await messageDeliveryOwner.recover(recovered)
      return { interrupted }
    },
    async wakeMessages() {
      messageDeliveryOwner.wake(await options.records.snapshot())
    },
    async deleteSession(session) {
      await stopSession(session)
      if (!options.workspace?.deleteSession) {
        throw new DurableDelegatedWorkError(
          'durability_failure',
          'Delegate workspace deletion is unavailable.'
        )
      }
      await options.workspace.deleteSession(session)
    }
  })
}

export { DurableDelegatedWorkError, createDurableDelegatedWork, createInMemoryDelegatedWorkRecords }
export type {
  DelegatedArtifactEvidence,
  DelegatedArtifactHandle,
  DelegatedArtifactProjectionScope,
  DelegatedArtifactScope,
  DelegatedReviewEvidence,
  DelegatedReviewProjectionScope,
  DurableChildSummary,
  DurableDelegateOutcome,
  DurableDelegateRequest,
  DurableDelegateResult,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableSendMessageOutcome,
  DurableSendMessageOptions,
  DurableDelegatedWork,
  ParentMessageDelivery,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  RootDelegatePermissionRequest,
  RootDelegatePermissionEvent,
  RootDelegatePermissionResponse,
  SpecialistDelegationProfile,
  SessionSubagentSummary,
  StopOutcome
}
export type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
export type {
  DelegatedWorkDurableRecords,
  DurableMessage,
  DurableMessageCommand,
  DurablePendingMessage,
  DurableSnapshot
} from './delegated-work-record-types'
