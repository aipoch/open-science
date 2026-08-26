import {
  DelegateExecutionError,
  type DelegateCapacityReservation,
  type DelegateExecution,
  type DelegateExecutionErrorCode,
  type DelegateExecutionEvent,
  type DelegateExecutionInput,
  type DelegateExecutionOutcome,
  type DelegateMessageAcceptanceEvidence,
  type DelegatePermissionResponse,
  type RunningDelegateExecution
} from './execution-port'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { AcpModelCallUsage, AcpTurnTokenUsage } from '../../shared/acp'

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

type ExecutionControl = Readonly<{
  input: DelegateExecutionInput
  accept(): void
  rejectAcceptance(error?: Error): void
  emit(event: DelegateExecutionEvent): void
  complete(
    response: string,
    turnUsage?: AcpTurnTokenUsage,
    modelCallUsage?: readonly AcpModelCallUsage[]
  ): void
  completeTurn(
    response: string,
    turnUsage?: AcpTurnTokenUsage,
    modelCallUsage?: readonly AcpModelCallUsage[]
  ): Promise<void>
  fail(error?: Error): void
  cancel(): void
  rejectNextPermissionProfile(error?: Error): void
  deliveredMessages(): readonly string[]
  permissionProfiles(): readonly PermissionProfileId[]
  permissionResponses(): readonly DelegatePermissionResponse[]
}>

type PlannedExecution =
  | Readonly<{
      status: 'completed'
      response: string
      events?: readonly DelegateExecutionEvent[]
      turnUsage?: AcpTurnTokenUsage
    }>
  | Readonly<{ status: 'failed'; error?: Error }>

type DeterministicDelegateExecution = DelegateExecution &
  Readonly<{
    plan(plan: PlannedExecution): void
    rejectNextReservation(code: DelegateExecutionErrorCode, message?: string): void
    controls(): readonly ExecutionControl[]
    control(attemptId: string): ExecutionControl
    releasedFrames(): readonly string[]
    reservationCounts(): readonly number[]
  }>

const createDeterministicDelegateExecution = (
  capacity = Number.MAX_SAFE_INTEGER
): DeterministicDelegateExecution => {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error('deterministic delegated execution capacity must be a positive integer')
  }
  const running: ExecutionControl[] = []
  const plans: PlannedExecution[] = []
  const released: string[] = []
  const reservationCounts: number[] = []
  let reservationFailure: DelegateExecutionError | undefined
  let nextSlot = 1
  const availableSlots = new Set<string>()
  const slotFrames = new Map<string, string>()

  return {
    plan(plan) {
      plans.push(plan)
    },
    rejectNextReservation(code, message = code) {
      reservationFailure = new DelegateExecutionError(code, message)
    },
    controls: () => running,
    control(attemptId) {
      const control = running.find((candidate) => candidate.input.attemptId === attemptId)
      if (!control) throw new Error(`unknown deterministic execution: ${attemptId}`)
      return control
    },
    releasedFrames: () => released,
    reservationCounts: () => reservationCounts,
    async reserve(count): Promise<DelegateCapacityReservation> {
      reservationCounts.push(count)
      if (reservationFailure) {
        const error = reservationFailure
        reservationFailure = undefined
        throw error
      }
      if (availableSlots.size + slotFrames.size + count > capacity) {
        throw new DelegateExecutionError(
          'capacity',
          `deterministic delegated execution capacity is ${capacity}`
        )
      }
      const slotIds = Array.from({ length: count }, () => `fake-slot-${nextSlot++}`)
      for (const slotId of slotIds) availableSlots.add(slotId)
      const owned = new Set(slotIds)
      return {
        slotIds,
        async release(slotId) {
          if (!owned.delete(slotId)) return
          availableSlots.delete(slotId)
          const frameId = slotFrames.get(slotId)
          slotFrames.delete(slotId)
          if (frameId) released.push(frameId)
        },
        async releaseAll() {
          for (const slotId of [...owned]) {
            owned.delete(slotId)
            availableSlots.delete(slotId)
          }
        }
      }
    },
    run(input, slotId): RunningDelegateExecution {
      if (!availableSlots.delete(slotId)) throw new Error(`unavailable slot: ${slotId}`)
      slotFrames.set(slotId, input.frameId)
      const acceptance = deferred<DelegateMessageAcceptanceEvidence>()
      const completion = deferred<DelegateExecutionOutcome>()
      const listeners = new Set<(event: DelegateExecutionEvent) => void>()
      const messages: string[] = []
      const queuedTurns: Array<DelegateExecutionInput['turn']> = []
      let activeTurn = input.turn
      const permissionProfiles: PermissionProfileId[] = []
      const responses: DelegatePermissionResponse[] = []
      let permissionProfileFailure: Error | undefined
      let terminal = false
      const control: ExecutionControl = {
        input,
        accept: () => acceptance.resolve('provider_prompt_accepted'),
        rejectAcceptance: (error = new Error('acceptance failed')) => acceptance.reject(error),
        emit: (event) => {
          for (const listener of listeners) listener(event)
        },
        complete: (response, turnUsage, modelCallUsage) => {
          if (terminal) return
          terminal = true
          void (async () => {
            await activeTurn?.complete?.(response, turnUsage, undefined, modelCallUsage)
            completion.resolve({
              status: 'completed',
              response,
              ...(turnUsage ? { turnUsage, ...(modelCallUsage ? { modelCallUsage } : {}) } : {})
            })
          })().catch((error) => completion.reject(error))
        },
        async completeTurn(response, turnUsage, modelCallUsage) {
          await activeTurn?.complete?.(response, turnUsage, undefined, modelCallUsage)
          activeTurn = queuedTurns.shift()
          await activeTurn?.begin?.()
        },
        fail: (error = new Error('execution failed')) => {
          if (terminal) return
          terminal = true
          completion.reject(error)
        },
        cancel: () => {
          if (terminal) return
          terminal = true
          completion.resolve({ status: 'cancelled' })
        },
        rejectNextPermissionProfile: (error = new Error('permission profile update failed')) => {
          permissionProfileFailure = error
        },
        deliveredMessages: () => messages,
        permissionProfiles: () => permissionProfiles,
        permissionResponses: () => responses
      }
      running.push(control)
      const planned = plans.shift()
      if (planned) {
        queueMicrotask(() => {
          control.accept()
          if (planned.status === 'completed') {
            for (const event of planned.events ?? []) control.emit(event)
            control.complete(planned.response, planned.turnUsage)
          } else {
            control.fail(planned.error)
          }
        })
      }
      return {
        accepted: acceptance.promise,
        completion: completion.promise,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        async sendMessage(message, turn) {
          messages.push(message)
          queuedTurns.push(turn)
          return 'provider_prompt_accepted'
        },
        async setPermissionProfile(profile) {
          if (permissionProfileFailure) {
            const error = permissionProfileFailure
            permissionProfileFailure = undefined
            throw error
          }
          permissionProfiles.push(profile)
        },
        async respondToPermission(response) {
          responses.push(response)
          for (const listener of listeners) {
            listener({ kind: 'permission', awaiting: false, requestId: response.requestId })
          }
        },
        async cancel() {
          control.cancel()
        }
      }
    }
  }
}

export { createDeterministicDelegateExecution }
export type { DeterministicDelegateExecution, ExecutionControl, PlannedExecution }
