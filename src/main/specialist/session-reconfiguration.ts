import type { SetSessionSpecialistResponse } from '../../shared/specialist'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { SessionBindingService } from './session-binding'

export type PersistedSessionSpecialistBinding = Readonly<{
  specialistId?: string
  specialistBindingPending?: true
}>

type SessionSpecialistReconfigurationDeps = Readonly<{
  sessionBinding: Pick<SessionBindingService, 'resolve' | 'setBinding' | 'clearSession'>
  loadBinding: (sessionId: string) => Promise<PersistedSessionSpecialistBinding | undefined>
  persistBinding: (
    sessionId: string,
    specialistId: string | undefined,
    pending: boolean
  ) => Promise<void>
  applyRuntime?: (
    sessionId: string,
    specialistId: string | undefined
  ) => Promise<{ contextReset: boolean }>
}>

const log = createLogger('specialist:session-reconfiguration')

export const SPECIALIST_RECONFIGURATION_PENDING_ERROR =
  'The selected Specialist is saved but has not been applied yet. Retry the switch before sending.'

// Owns the desired -> pending -> applied transaction for every Session Specialist switch. The
// durable desired binding is intentionally not rolled back after a runtime failure: instead the
// pending marker survives restart and Main rejects user prompts until runtime and disk converge.
export class SessionSpecialistReconfiguration {
  private readonly processPending = new Map<string, string | undefined>()
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly deps: SessionSpecialistReconfigurationDeps) {}

  requestSwitch(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<SetSessionSpecialistResponse> {
    return this.enqueue(sessionId, async () => {
      await this.validateTarget(sessionId, specialistId)
      await this.commitDesiredUnlocked(sessionId, specialistId)
      return this.applyUnlocked(sessionId, specialistId, false)
    })
  }

  // host.agents.switch commits at the old prompt boundary and applies later through the completion
  // gate. Persist the pending marker here; the framework adapter calls applyPersisted after drain.
  commitDesired(sessionId: string, specialistId: string | undefined): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.validateTarget(sessionId, specialistId)
      await this.commitDesiredUnlocked(sessionId, specialistId)
    })
  }

  applyPersisted(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }> {
    return this.enqueue(sessionId, async () => {
      await this.validateTarget(sessionId, specialistId)
      await this.assertDesiredBinding(sessionId, specialistId)
      const result = await this.applyUnlocked(sessionId, specialistId, true)
      if (result.status === 'pending') throw new Error(SPECIALIST_RECONFIGURATION_PENDING_ERROR)
      return { contextReset: result.contextReset }
    })
  }

  // A pending binding restored after restart forces fresh provider adoption. Once that resume has
  // committed runtime ownership, this hook clears the durable marker without applying twice.
  completeResume(sessionId: string, specialistId: string | undefined): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.assertDesiredBinding(sessionId, specialistId)
      this.deps.sessionBinding.setBinding(sessionId, specialistId)
      await this.deps.persistBinding(sessionId, specialistId, false)
      this.processPending.delete(sessionId)
    })
  }

  async assertUserPromptReady(sessionId: string): Promise<void> {
    if (this.processPending.has(sessionId)) {
      throw new Error(SPECIALIST_RECONFIGURATION_PENDING_ERROR)
    }
    const persisted = await this.deps.loadBinding(sessionId)
    if (persisted?.specialistBindingPending === true) {
      this.processPending.set(sessionId, persisted.specialistId)
      throw new Error(SPECIALIST_RECONFIGURATION_PENDING_ERROR)
    }
  }

  clearSession(sessionId: string): void {
    this.processPending.delete(sessionId)
    this.tails.delete(sessionId)
    this.deps.sessionBinding.clearSession(sessionId)
  }

  private async commitDesiredUnlocked(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<void> {
    await this.deps.persistBinding(sessionId, specialistId, true)
    this.processPending.set(sessionId, specialistId)
    this.deps.sessionBinding.setBinding(sessionId, specialistId)
  }

  private async applyUnlocked(
    sessionId: string,
    specialistId: string | undefined,
    throwAfterCommit: boolean
  ): Promise<SetSessionSpecialistResponse> {
    let contextReset = false
    try {
      if (this.deps.applyRuntime) {
        contextReset = (await this.deps.applyRuntime(sessionId, specialistId)).contextReset
      }
    } catch (error) {
      log.error('failed to apply durable Specialist binding to runtime', {
        sessionId,
        specialistId,
        ...diagnosticErrorFields(error)
      })
      if (throwAfterCommit) throw error
      return { status: 'pending', reason: 'runtime-application-failed' }
    }

    try {
      await this.deps.persistBinding(sessionId, specialistId, false)
    } catch (error) {
      log.error('runtime applied Specialist binding but pending marker could not be cleared', {
        sessionId,
        specialistId,
        ...diagnosticErrorFields(error)
      })
      if (throwAfterCommit) throw error
      return { status: 'pending', reason: 'pending-state-clear-failed' }
    }

    this.processPending.delete(sessionId)
    return { status: 'applied', contextReset }
  }

  private async validateTarget(sessionId: string, specialistId: string | undefined): Promise<void> {
    if (specialistId === undefined) return
    const resolution = await this.deps.sessionBinding.resolve(sessionId, specialistId)
    if (resolution.kind === 'unavailable') throw new Error(resolution.reason)
  }

  private async assertDesiredBinding(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<void> {
    const persisted = await this.deps.loadBinding(sessionId)
    const processPendingMatches =
      this.processPending.has(sessionId) && this.processPending.get(sessionId) === specialistId
    if (
      persisted &&
      (persisted.specialistId !== specialistId || persisted.specialistBindingPending !== true)
    ) {
      throw new Error('The persisted Specialist binding changed before runtime application.')
    }
    if (!persisted && !processPendingMatches) {
      throw new Error('The pending Specialist binding is unavailable.')
    }
  }

  private enqueue<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(sessionId, tail)
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
    return result
  }
}
