import type { PromptResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import {
  getAcpRuntimeEventText,
  type AcpAgentRuntimeUpdate,
  type AcpModelCallUsage,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpRuntimeEvent,
  type AcpTurnTokenUsage
} from '../../shared/acp'
import { createLogger } from '../logger'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  DelegateExecutionError,
  DelegateExecutionCleanupError,
  DelegateMessagePreAcceptanceError,
  type DelegateCapacityReservation,
  type DelegateChildTurnIdentity,
  type DelegateExecution,
  type DelegateExecutionEvent,
  type DelegateExecutionInput,
  type DelegateMessageAcceptanceEvidence,
  type DelegateExecutionOutcome,
  type DelegatePermissionResponse,
  type RunningDelegateExecution
} from './execution-port'
import { nativeDelegationAuditFailureMessage } from './certification'

const log = createLogger('delegation:execution')

type DelegateExecutionProvenance = Readonly<{
  projectId: string
  sessionId: string
  agentFrameId: string
  runtimeSegmentId: string
  promptMessageId?: string
  messageBranchId?: string
}>

type DelegateExecutionCapability = Readonly<{
  token?: string
  revoke(): Promise<void> | void
}>

type PreparedDelegateExecution = Readonly<{
  executionId: string
  provenance: DelegateExecutionProvenance
  workspace: Readonly<{ cwd: string }>
  runtimeHome: string
  frameworkId: string
  permissionProfile?: PermissionProfileId
  permissionPrompts?: 'none'
  capability: DelegateExecutionCapability
  artifactCurrentRunFile?: string
  runtimeConstructionIsProcessFree?: boolean
  releaseResources?(): Promise<void> | void
  // Return true only when recovery positively reaped recorded process ownership.
  // A void result asserts no pending receipts but cannot override a failed runtime shutdown.
  confirmProcessCleanup?(): Promise<void | true>
  disposeResources?(): Promise<void> | void
}>

type AcpDelegateExecutionCallbacks = Readonly<{
  onProviderPromptAccepted(sessionId: string): void
  onEvent(event: AcpRuntimeEvent): void
  onPermissionRequest(request: AcpPermissionRequest): void
}>

type AcpDelegateRuntime = Readonly<{
  createSession(request: {
    cwd: string
    projectId: string
    permissionProfile?: PermissionProfileId
    specialistId?: string
  }): Promise<{ sessionId: string }>
  sendAppContinuation(request: {
    permissionPrompts?: 'none'
    sessionId: string
    text: string
    suppressUserMessage?: boolean
    provenanceContext?: {
      promptMessageId: string
      agentFrameId: string
      messageBranchId?: string
      runtimeSegmentId: string
    }
  }): Promise<PromptResponse>
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
  setPermissionProfile(request: {
    sessionId: string
    profile: PermissionProfileId
  }): Promise<unknown>
  respondToPermission(response: AcpPermissionResponse): Promise<unknown>
  deleteSession(request: { sessionId: string }): Promise<unknown>
  shutdownForQuit(): Promise<{ reaped: boolean }>
}>

type AcpDelegateExecutionOptions = Readonly<{
  capacity: number
  prepare(
    input: DelegateExecutionInput
  ): Promise<PreparedDelegateExecution> | PreparedDelegateExecution
  assertFrameworkNativeDelegationDisabled(scope: PreparedDelegateExecution): Promise<void> | void
  createRuntime(
    scope: PreparedDelegateExecution,
    callbacks: AcpDelegateExecutionCallbacks
  ): AcpDelegateRuntime
}>

type Deferred<Value> = Readonly<{
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}>

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const assertPreparedScope = (
  input: DelegateExecutionInput,
  scope: PreparedDelegateExecution
): void => {
  if (scope.executionId !== input.attemptId) {
    throw new Error('prepared executionId must equal the Attempt identity')
  }
  if (
    scope.provenance.projectId !== input.session.projectId ||
    scope.provenance.sessionId !== input.session.sessionId ||
    scope.provenance.agentFrameId !== input.frameId ||
    scope.provenance.runtimeSegmentId !== input.runtimeSegmentId
  ) {
    throw new Error('prepared execution provenance does not match the delegated Attempt')
  }
  if (
    !scope.provenance.runtimeSegmentId.trim() ||
    !scope.workspace.cwd.trim() ||
    !scope.runtimeHome.trim() ||
    !scope.frameworkId.trim()
  ) {
    throw new Error('prepared execution scope is incomplete')
  }
  if (input.workspaceCwd && scope.workspace.cwd !== input.workspaceCwd) {
    throw new Error('prepared execution workspace does not match the staged Frame cwd')
  }
}

const buildInitialDelegatePrompt = (input: DelegateExecutionInput): string => {
  const sections = [input.task]
  if (input.inputs.length > 0) {
    sections.push(
      'Immutable input copies are available in the read-only ./inputs/ directory. Inspect that directory and read the relevant files.'
    )
  }
  if (input.outputSchema !== undefined) {
    sections.push(
      `Return ordinary text and any Artifacts as usual. Before finishing, submit the structured result with host.submitOutput(value) using this JSON Schema:\n${JSON.stringify(input.outputSchema)}`
    )
  }
  return sections.join('\n\n')
}

const addTurnUsage = (
  current: AcpTurnTokenUsage | undefined,
  incoming: AcpTurnTokenUsage
): AcpTurnTokenUsage | undefined => {
  if (!current) return { ...incoming }
  const inputTokens = (current?.inputTokens ?? 0) + incoming.inputTokens
  const cacheTokens = (current?.cacheTokens ?? 0) + incoming.cacheTokens
  const outputTokens = (current?.outputTokens ?? 0) + incoming.outputTokens
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(cacheTokens) ||
    !Number.isSafeInteger(outputTokens)
  ) {
    return undefined
  }

  const hasCacheBreakdown =
    current?.cachedReadTokens !== undefined &&
    current.cachedWriteTokens !== undefined &&
    incoming.cachedReadTokens !== undefined &&
    incoming.cachedWriteTokens !== undefined
  const cachedReadTokens = hasCacheBreakdown
    ? current.cachedReadTokens! + incoming.cachedReadTokens!
    : undefined
  const cachedWriteTokens = hasCacheBreakdown
    ? current.cachedWriteTokens! + incoming.cachedWriteTokens!
    : undefined
  const turnCount =
    current?.turnCount !== undefined && incoming.turnCount !== undefined
      ? current.turnCount + incoming.turnCount
      : undefined

  if (
    (cachedReadTokens !== undefined && !Number.isSafeInteger(cachedReadTokens)) ||
    (cachedWriteTokens !== undefined && !Number.isSafeInteger(cachedWriteTokens)) ||
    (turnCount !== undefined && !Number.isSafeInteger(turnCount))
  ) {
    return undefined
  }

  return {
    inputTokens,
    cacheTokens,
    ...(cachedReadTokens !== undefined && cachedWriteTokens !== undefined
      ? { cachedReadTokens, cachedWriteTokens }
      : {}),
    outputTokens,
    ...(turnCount !== undefined ? { turnCount } : {})
  }
}

const hasExactModelCallUsage = (
  turnUsage: AcpTurnTokenUsage,
  modelCallUsage: readonly AcpModelCallUsage[] | undefined
): modelCallUsage is readonly AcpModelCallUsage[] => {
  if (
    !turnUsage.turnCount ||
    modelCallUsage?.length !== turnUsage.turnCount ||
    new Set(modelCallUsage.map((call) => call.id)).size !== modelCallUsage.length
  ) {
    return false
  }
  const totals = modelCallUsage.reduce(
    (sum, call, index) => ({
      inputTokens: sum.inputTokens + call.inputTokens,
      cacheTokens: sum.cacheTokens + call.cacheTokens,
      outputTokens: sum.outputTokens + call.outputTokens,
      indicesMatch: sum.indicesMatch && call.index === index
    }),
    { inputTokens: 0, cacheTokens: 0, outputTokens: 0, indicesMatch: true }
  )
  return (
    totals.indicesMatch &&
    totals.inputTokens === turnUsage.inputTokens &&
    totals.cacheTokens === turnUsage.cacheTokens &&
    totals.outputTokens === turnUsage.outputTokens
  )
}

const createAcpDelegateExecution = (options: AcpDelegateExecutionOptions): DelegateExecution => {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
    throw new Error('delegate execution capacity must be a positive integer')
  }

  type Slot = { status: 'reserved' | 'running'; attemptId?: string; unreaped?: true }
  const slots = new Map<string, Slot>()
  const activeAttempts = new Set<string>()
  const quarantined = new Map<string, () => Promise<void>>()
  const activeRuntimeHomes = new Set<string>()
  const activeWorkspaces = new Set<string>()

  const releaseSlot = (slotId: string): void => {
    const slot = slots.get(slotId)
    if (!slot || slot.unreaped) return
    slots.delete(slotId)
    if (slot.attemptId) activeAttempts.delete(slot.attemptId)
  }

  const reserve = async (count: number): Promise<DelegateCapacityReservation> => {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new DelegateExecutionError('capacity', 'reservation count must be a positive integer')
    }
    if (slots.size + count > options.capacity) {
      throw new DelegateExecutionError(
        'capacity',
        `delegated execution capacity is ${options.capacity}`
      )
    }

    const slotIds = Array.from({ length: count }, () => `delegate-slot-${randomUUID()}`)
    for (const slotId of slotIds) slots.set(slotId, { status: 'reserved' })
    const owned = new Set(slotIds)
    return Object.freeze({
      slotIds: Object.freeze(slotIds),
      async release(slotId) {
        if (!owned.delete(slotId)) return
        if (slots.get(slotId)?.status === 'reserved') releaseSlot(slotId)
      },
      async releaseAll() {
        for (const slotId of [...owned]) {
          owned.delete(slotId)
          if (slots.get(slotId)?.status === 'reserved') releaseSlot(slotId)
        }
      }
    })
  }

  const run = (input: DelegateExecutionInput, slotId: string): RunningDelegateExecution => {
    const slot = slots.get(slotId)
    if (!slot || slot.status !== 'reserved') {
      throw new Error(`delegate execution slot is not reserved: ${slotId}`)
    }
    if (activeAttempts.has(input.attemptId)) {
      throw new Error(`delegate Attempt is already running: ${input.attemptId}`)
    }
    slot.status = 'running'
    slot.attemptId = input.attemptId
    activeAttempts.add(input.attemptId)

    const acceptance = deferred<DelegateMessageAcceptanceEvidence>()
    const terminal = deferred<DelegateExecutionOutcome>()
    void acceptance.promise.catch(() => undefined)
    void terminal.promise.catch(() => undefined)
    const listeners = new Set<(event: DelegateExecutionEvent) => void>()
    type QueuedPrompt = Readonly<{
      text: string
      acceptance: Deferred<DelegateMessageAcceptanceEvidence>
      turn?: DelegateChildTurnIdentity
    }>
    const queuedPrompts: QueuedPrompt[] = []
    const pendingPermissions = new Set<string>()
    let providerSessionId: string | undefined
    let runtime: AcpDelegateRuntime | undefined
    let scope: PreparedDelegateExecution | undefined
    let ownsRuntimeHome = false
    let ownsWorkspace = false
    let writable = true
    let capabilityRevoked = false
    let acceptedSettled = false
    let terminalSettled = false
    let cancelRequested = false
    let currentResponse: string[] = []
    let turnUsage: AcpTurnTokenUsage | undefined
    let modelCallUsage: AcpModelCallUsage[] = []
    let sawStopEvent = false
    let turnUsageAvailable = true
    let modelCallUsageAvailable = true
    let lastStopEvent: AcpAgentRuntimeUpdate['event'] | undefined
    let currentStopEvent: AcpAgentRuntimeUpdate['event'] | undefined
    // Provider event ids are unique within this Attempt-owned runtime lifetime.
    const seenStopEventIds = new Set<string>()
    let activeMessage: QueuedPrompt | undefined
    let activeTurn: QueuedPrompt['turn']
    let providerPromptStarted = false

    const settleAccepted = (
      evidence: DelegateMessageAcceptanceEvidence = 'provider_prompt_completed',
      error?: unknown
    ): void => {
      if (acceptedSettled) return
      acceptedSettled = true
      if (error === undefined) acceptance.resolve(evidence)
      else acceptance.reject(error)
    }
    const publish = (event: DelegateExecutionEvent): void => {
      if (!writable || terminalSettled) return
      for (const listener of listeners) listener(event)
    }
    const callbacks: AcpDelegateExecutionCallbacks = {
      onProviderPromptAccepted(sessionId) {
        if (!writable || sessionId !== providerSessionId) return
        if (activeMessage) activeMessage.acceptance.resolve('provider_prompt_accepted')
        else settleAccepted('provider_prompt_accepted')
      },
      onEvent(event) {
        if (!writable || event.sessionId !== providerSessionId) return
        if (event.kind === 'stop') {
          if (seenStopEventIds.has(event.id)) return
          seenStopEventIds.add(event.id)
          sawStopEvent = true
          if (!event.turnUsage || !turnUsageAvailable) {
            turnUsageAvailable = false
            turnUsage = undefined
          } else {
            const aggregate = addTurnUsage(turnUsage, event.turnUsage)
            if (aggregate) turnUsage = aggregate
            else {
              turnUsageAvailable = false
              turnUsage = undefined
            }
          }
          if (
            !event.turnUsage ||
            !hasExactModelCallUsage(event.turnUsage, event.modelCallUsage) ||
            !modelCallUsageAvailable
          ) {
            modelCallUsageAvailable = false
            modelCallUsage = []
          } else {
            const offset = modelCallUsage.length
            const knownIds = new Set(modelCallUsage.map((call) => call.id))
            if (event.modelCallUsage.some((call) => knownIds.has(call.id))) {
              modelCallUsageAvailable = false
              modelCallUsage = []
            } else {
              modelCallUsage.push(
                ...event.modelCallUsage.map((call, index) => ({
                  ...call,
                  index: offset + index
                }))
              )
            }
          }
        }
        const text = getAcpRuntimeEventText(event)
        if (event.kind === 'message' && event.role === 'assistant' && text) {
          currentResponse.push(text)
          publish({ kind: 'message', text })
        }

        const promptMessageId = activeTurn?.promptMessageId ?? scope?.provenance.promptMessageId
        if (!scope || !promptMessageId) return
        const {
          sessionId: providerOwnedSessionId,
          promptMessageId: providerPromptMessageId,
          ...ownedEvent
        } = event
        void providerOwnedSessionId
        void providerPromptMessageId
        const update: AcpAgentRuntimeUpdate = {
          scope: {
            projectId: scope.provenance.projectId,
            sessionId: scope.provenance.sessionId,
            agentFrameId: scope.provenance.agentFrameId,
            attemptId: input.attemptId,
            runtimeSegmentId: activeTurn?.runtimeSegmentId ?? scope.provenance.runtimeSegmentId,
            promptMessageId
          },
          event: ownedEvent
        }
        if (event.kind === 'stop') {
          lastStopEvent = ownedEvent
          currentStopEvent = ownedEvent
          return
        }
        publish({ kind: 'runtime', update })
      },
      onPermissionRequest(request) {
        if (!writable || request.sessionId !== providerSessionId) return
        pendingPermissions.add(request.requestId)
        publish({
          kind: 'permission',
          awaiting: true,
          requestId: request.requestId,
          title: request.title,
          providerToolName: request.providerToolName,
          isMcp: request.isMcp,
          toolKind: request.toolKind,
          options: request.options.map(({ optionId, name, kind, scope }) => ({
            optionId,
            name,
            kind,
            ...(scope ? { scope } : {})
          }))
        })
      }
    }

    const revokeWrites = async (): Promise<void> => {
      writable = false
      pendingPermissions.clear()
      const deliveryError = new Error('delegate execution ended before message delivery')
      activeMessage?.acceptance.reject(deliveryError)
      activeMessage = undefined
      for (const pending of queuedPrompts.splice(0)) pending.acceptance.reject(deliveryError)
      if (scope && !capabilityRevoked) {
        capabilityRevoked = true
        await scope.capability.revoke()
      }
    }
    let runtimeCreationStarted = false
    let cleanupPromise: Promise<void> | undefined
    const cleanup = (): Promise<void> =>
      (cleanupPromise ??= (async () => {
        let firstError: unknown
        try {
          await revokeWrites()
        } catch (error) {
          firstError = error
        }
        if (runtime && providerSessionId) {
          try {
            await runtime.deleteSession({ sessionId: providerSessionId })
          } catch (error) {
            firstError ??= error
          }
        }
        if (runtime) {
          try {
            const { reaped } = await runtime.shutdownForQuit()
            if (!reaped) slot.unreaped = true
          } catch (error) {
            slot.unreaped = true
            firstError ??= error
          }
        }
        if (
          runtimeCreationStarted &&
          !runtime &&
          !scope?.confirmProcessCleanup &&
          scope?.runtimeConstructionIsProcessFree !== true
        )
          slot.unreaped = true
        if (scope?.confirmProcessCleanup) {
          try {
            const recovered = await scope.confirmProcessCleanup()
            // The ownership authority has now confirmed every process for this Attempt.
            // A failed first shutdown is provisional, not a permanent quarantine latch.
            if (recovered === true) delete slot.unreaped
          } catch (error) {
            slot.unreaped = true
            firstError ??= error
          }
        }
        try {
          await scope?.releaseResources?.()
        } catch (error) {
          firstError ??= error
        }
        listeners.clear()
        if (slot.unreaped) {
          quarantined.set(input.attemptId, async () => {
            if (!scope?.confirmProcessCleanup)
              throw new DelegateExecutionCleanupError(
                'Process cleanup cannot be retried without ownership evidence.'
              )
            await scope.confirmProcessCleanup()
            if (
              (ownsRuntimeHome || !activeRuntimeHomes.has(scope.runtimeHome)) &&
              (ownsWorkspace || !activeWorkspaces.has(scope.workspace.cwd))
            )
              await scope.disposeResources?.()
            if (ownsRuntimeHome) activeRuntimeHomes.delete(scope.runtimeHome)
            if (ownsWorkspace) activeWorkspaces.delete(scope.workspace.cwd)
            delete slot.unreaped
            releaseSlot(slotId)
            quarantined.delete(input.attemptId)
          })
          // Keep the exclusion even when the durable caller releases its reservation.
          // A second shutdown of a detached runtime cannot prove the old tree exited.
          throw new DelegateExecutionCleanupError(
            'Delegated process cleanup could not be confirmed; its workspace and capacity remain reserved.',
            { cause: firstError }
          )
        }
        if (scope) {
          const mayDispose =
            (ownsRuntimeHome || !activeRuntimeHomes.has(scope.runtimeHome)) &&
            (ownsWorkspace || !activeWorkspaces.has(scope.workspace.cwd))
          try {
            if (mayDispose) await scope.disposeResources?.()
          } catch (error) {
            firstError ??= error
          }
          if (ownsRuntimeHome) {
            activeRuntimeHomes.delete(scope.runtimeHome)
            ownsRuntimeHome = false
          }
          if (ownsWorkspace) {
            activeWorkspaces.delete(scope.workspace.cwd)
            ownsWorkspace = false
          }
        }
        releaseSlot(slotId)
        if (firstError !== undefined) throw firstError
      })())

    const settleOutcome = async (outcome: DelegateExecutionOutcome): Promise<void> => {
      let cleanupError: Error | undefined
      try {
        await cleanup()
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error))
        log.warn('delegated result preserved after cleanup failure', {
          ...input.session,
          attemptId: input.attemptId,
          status: outcome.status,
          error: cleanupError
        })
      }
      terminalSettled = true
      terminal.resolve({ ...outcome, ...(cleanupError ? { cleanupError } : {}) })
    }

    const promptRequest = (
      text: string
    ): Parameters<AcpDelegateRuntime['sendAppContinuation']>[0] => ({
      sessionId: providerSessionId!,
      text,
      suppressUserMessage: true,
      ...(scope?.permissionPrompts ? { permissionPrompts: scope.permissionPrompts } : {}),
      ...((activeTurn?.promptMessageId ?? scope?.provenance.promptMessageId)
        ? {
            provenanceContext: {
              promptMessageId: activeTurn?.promptMessageId ?? scope!.provenance.promptMessageId!,
              agentFrameId: scope!.provenance.agentFrameId,
              ...((activeTurn?.messageBranchId ?? scope!.provenance.messageBranchId)
                ? {
                    messageBranchId:
                      activeTurn?.messageBranchId ?? scope!.provenance.messageBranchId
                  }
                : {}),
              runtimeSegmentId: activeTurn?.runtimeSegmentId ?? scope!.provenance.runtimeSegmentId
            }
          }
        : {})
    })

    const work = (async (): Promise<void> => {
      try {
        scope = await options.prepare(input)
        assertPreparedScope(input, scope)
        try {
          await options.assertFrameworkNativeDelegationDisabled(scope)
        } catch {
          throw new DelegateExecutionError(
            'unsupported_framework',
            nativeDelegationAuditFailureMessage(scope.frameworkId)
          )
        }
        if (activeRuntimeHomes.has(scope.runtimeHome)) {
          throw new Error(`runtime home is already active: ${scope.runtimeHome}`)
        }
        if (activeWorkspaces.has(scope.workspace.cwd)) {
          throw new Error(`workspace is already active: ${scope.workspace.cwd}`)
        }
        activeRuntimeHomes.add(scope.runtimeHome)
        ownsRuntimeHome = true
        activeWorkspaces.add(scope.workspace.cwd)
        ownsWorkspace = true
        if (cancelRequested) {
          await settleOutcome({ status: 'cancelled' })
          settleAccepted(
            'provider_prompt_completed',
            new DelegateMessagePreAcceptanceError(
              'delegate execution was cancelled before provider acceptance'
            )
          )
          return
        }

        runtimeCreationStarted = true
        runtime = options.createRuntime(scope, callbacks)
        const created = await runtime.createSession({
          cwd: scope.workspace.cwd,
          projectId: input.session.projectId,
          ...(scope.permissionProfile ? { permissionProfile: scope.permissionProfile } : {}),
          ...(input.profile ? { specialistId: input.profile } : {})
        })
        providerSessionId = created.sessionId
        if (cancelRequested) {
          await settleOutcome({ status: 'cancelled' })
          settleAccepted(
            'provider_prompt_completed',
            new DelegateMessagePreAcceptanceError(
              'delegate execution was cancelled before provider acceptance'
            )
          )
          return
        }

        let nextPrompt = buildInitialDelegatePrompt(input)
        activeTurn =
          input.turn ??
          (scope.provenance.promptMessageId
            ? {
                promptMessageId: scope.provenance.promptMessageId,
                messageBranchId: scope.provenance.messageBranchId ?? '',
                runtimeSegmentId: scope.provenance.runtimeSegmentId
              }
            : undefined)
        let response = ''
        while (!cancelRequested) {
          await activeTurn?.begin?.()
          currentResponse = []
          providerPromptStarted = true
          const outcome = await runtime.sendAppContinuation(promptRequest(nextPrompt))
          if (activeMessage) activeMessage.acceptance.resolve('provider_prompt_completed')
          else settleAccepted('provider_prompt_completed')
          activeMessage = undefined
          response = currentResponse.join('')
          if (outcome.stopReason === 'cancelled') cancelRequested = true
          if (cancelRequested) break
          await activeTurn?.complete?.(
            response,
            currentStopEvent?.turnUsage,
            currentStopEvent && !currentStopEvent.turnUsage ? true : undefined,
            currentStopEvent?.modelCallUsage
          )
          currentStopEvent = undefined
          const queued = queuedPrompts.shift()
          if (queued === undefined) break
          nextPrompt = queued.text
          activeMessage = queued
          activeTurn = queued.turn ?? activeTurn
        }

        if (!cancelRequested && lastStopEvent) {
          publish({
            kind: 'runtime',
            update: {
              scope: {
                projectId: scope.provenance.projectId,
                sessionId: scope.provenance.sessionId,
                agentFrameId: scope.provenance.agentFrameId,
                attemptId: input.attemptId,
                runtimeSegmentId: activeTurn?.runtimeSegmentId ?? scope.provenance.runtimeSegmentId,
                promptMessageId: activeTurn?.promptMessageId ?? scope.provenance.promptMessageId!
              },
              event: lastStopEvent
            }
          })
        }
        if (cancelRequested) await settleOutcome({ status: 'cancelled' })
        else {
          await settleOutcome({
            status: 'completed',
            response,
            ...(turnUsageAvailable && turnUsage
              ? {
                  turnUsage,
                  ...(modelCallUsageAvailable && modelCallUsage.length > 0
                    ? { modelCallUsage }
                    : {})
                }
              : sawStopEvent
                ? { turnUsageUnavailable: true }
                : {})
          })
        }
      } catch (error) {
        const acceptanceError =
          providerPromptStarted || error instanceof DelegateMessagePreAcceptanceError
            ? error
            : new DelegateMessagePreAcceptanceError(
                error instanceof Error ? error.message : String(error),
                error
              )
        activeMessage?.acceptance.reject(acceptanceError)
        activeMessage = undefined
        for (const pending of queuedPrompts.splice(0)) pending.acceptance.reject(error)
        let terminalError = error
        try {
          await cleanup()
        } catch (cleanupError) {
          terminalError = cleanupError
        }
        terminalSettled = true
        terminal.reject(terminalError)
        settleAccepted('provider_prompt_completed', acceptanceError)
      }
    })()

    return Object.freeze({
      accepted: acceptance.promise,
      completion: terminal.promise,
      subscribe(listener) {
        if (!terminalSettled) listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async sendMessage(message, turn) {
        if (!writable || terminalSettled || cancelRequested) {
          throw new Error('delegate execution is no longer running')
        }
        const pending: QueuedPrompt = {
          text: message,
          acceptance: deferred<DelegateMessageAcceptanceEvidence>(),
          turn
        }
        void pending.acceptance.promise.catch(() => undefined)
        queuedPrompts.push(pending)
        return pending.acceptance.promise
      },
      async setPermissionProfile(profile) {
        if (!writable || !runtime || !providerSessionId || terminalSettled || cancelRequested) {
          throw new Error('delegate execution is no longer running')
        }
        await runtime.setPermissionProfile({ sessionId: providerSessionId, profile })
      },
      async respondToPermission(response: DelegatePermissionResponse) {
        if (!writable || !runtime || !pendingPermissions.delete(response.requestId)) {
          throw new Error(`permission request is not active: ${response.requestId}`)
        }
        try {
          await runtime.respondToPermission(response)
        } catch (error) {
          if (writable && !terminalSettled && !cancelRequested) {
            pendingPermissions.add(response.requestId)
          }
          throw error
        }
        publish({ kind: 'permission', awaiting: false, requestId: response.requestId })
      },
      async cancel() {
        if (terminalSettled) return
        cancelRequested = true
        await revokeWrites().catch(() => undefined)
        if (runtime && providerSessionId) {
          await runtime.cancelPrompt({ sessionId: providerSessionId }).catch(() => undefined)
        }
        await work.catch(() => undefined)
      }
    })
  }

  return Object.freeze({
    reserve,
    run,
    async recoverCleanup() {
      const results = await Promise.allSettled(
        [...quarantined.values()].map((recover) => recover())
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) throw new AggregateError(failures, 'Delegated resource recovery failed.')
    }
  })
}

export { createAcpDelegateExecution }
export type {
  AcpDelegateExecutionCallbacks,
  AcpDelegateExecutionOptions,
  AcpDelegateRuntime,
  DelegateExecutionCapability,
  DelegateExecutionProvenance,
  PreparedDelegateExecution
}
