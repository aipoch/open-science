import type { SetSessionSpecialistResponse } from '../../shared/specialist'
import { startDiagnosticOperation, type DiagnosticOperation } from '../diagnostics/operation'
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
  discardPendingBinding?: (sessionId: string) => void
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
  private readonly reconfigurationsInFlight = new Map<string, number>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly deletedSessions = new Set<string>()

  constructor(private readonly deps: SessionSpecialistReconfigurationDeps) {}

  requestSwitch(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<SetSessionSpecialistResponse> {
    const diagnostics = startDiagnosticOperation(log, {
      operation: 'specialist-session-switch',
      fields: {
        sessionId,
        target: specialistId === undefined ? 'main-agent' : 'specialist'
      }
    })
    diagnostics.phase('queued')
    return this.enqueue(sessionId, async () => {
      diagnostics.phase('validate-target')
      await this.validateTarget(sessionId, specialistId)
      diagnostics.phase('persist-pending')
      await this.commitDesiredUnlocked(sessionId, specialistId)
      return this.applyUnlocked(sessionId, specialistId, false, diagnostics)
    }).then(
      (result) => {
        diagnostics.complete({
          status: result.status,
          ...(result.status === 'applied'
            ? { contextReset: result.contextReset }
            : { reason: result.reason })
        })
        return result
      },
      (error: unknown) => {
        diagnostics.fail(error)
        throw error
      }
    )
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
      this.assertSessionActive(sessionId)
      this.deps.sessionBinding.setBinding(sessionId, specialistId)
      await this.deps.persistBinding(sessionId, specialistId, false)
      this.assertSessionActive(sessionId)
      this.processPending.delete(sessionId)
    })
  }

  async assertUserPromptReady(sessionId: string): Promise<void> {
    this.assertSessionActive(sessionId)
    if (this.processPending.has(sessionId) || this.reconfigurationsInFlight.has(sessionId)) {
      throw new Error(SPECIALIST_RECONFIGURATION_PENDING_ERROR)
    }
    const persisted = await this.deps.loadBinding(sessionId)
    this.assertSessionActive(sessionId)
    if (this.processPending.has(sessionId) || this.reconfigurationsInFlight.has(sessionId)) {
      throw new Error(SPECIALIST_RECONFIGURATION_PENDING_ERROR)
    }
    if (persisted?.specialistBindingPending === true) {
      this.processPending.set(sessionId, persisted.specialistId)
      throw new Error(SPECIALIST_RECONFIGURATION_PENDING_ERROR)
    }
  }

  clearSession(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    this.processPending.delete(sessionId)
    this.reconfigurationsInFlight.delete(sessionId)
    this.tails.delete(sessionId)
    this.deps.discardPendingBinding?.(sessionId)
    this.deps.sessionBinding.clearSession(sessionId)
  }

  private async commitDesiredUnlocked(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<void> {
    this.assertSessionActive(sessionId)
    await this.deps.persistBinding(sessionId, specialistId, true)
    this.assertSessionActive(sessionId)
    this.processPending.set(sessionId, specialistId)
    this.deps.sessionBinding.setBinding(sessionId, specialistId)
  }

  private async applyUnlocked(
    sessionId: string,
    specialistId: string | undefined,
    throwAfterCommit: boolean,
    diagnostics?: DiagnosticOperation
  ): Promise<SetSessionSpecialistResponse> {
    this.assertSessionActive(sessionId)
    let contextReset = false
    try {
      diagnostics?.phase('apply-runtime')
      if (this.deps.applyRuntime) {
        contextReset = (await this.deps.applyRuntime(sessionId, specialistId)).contextReset
      }
      this.assertSessionActive(sessionId)
    } catch (error) {
      if (this.deletedSessions.has(sessionId)) this.assertSessionActive(sessionId)
      log.error('failed to apply durable Specialist binding to runtime', {
        sessionId,
        specialistId,
        ...diagnosticErrorFields(error)
      })
      if (throwAfterCommit) throw error
      return { status: 'pending', reason: 'runtime-application-failed' }
    }

    try {
      diagnostics?.phase('persist-applied')
      await this.deps.persistBinding(sessionId, specialistId, false)
      this.assertSessionActive(sessionId)
    } catch (error) {
      if (this.deletedSessions.has(sessionId)) this.assertSessionActive(sessionId)
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
    this.assertSessionActive(sessionId)
    if (specialistId === undefined) return
    const resolution = await this.deps.sessionBinding.resolve(sessionId, specialistId)
    this.assertSessionActive(sessionId)
    if (resolution.kind === 'unavailable') throw new Error(resolution.reason)
  }

  private async assertDesiredBinding(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<void> {
    const persisted = await this.deps.loadBinding(sessionId)
    this.assertSessionActive(sessionId)
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
    this.reconfigurationsInFlight.set(
      sessionId,
      (this.reconfigurationsInFlight.get(sessionId) ?? 0) + 1
    )
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        this.assertSessionActive(sessionId)
        const value = await operation()
        this.assertSessionActive(sessionId)
        return value
      })
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(sessionId, tail)
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
    return result.finally(() => {
      const remaining = (this.reconfigurationsInFlight.get(sessionId) ?? 1) - 1
      if (remaining > 0) this.reconfigurationsInFlight.set(sessionId, remaining)
      else this.reconfigurationsInFlight.delete(sessionId)
    })
  }

  private assertSessionActive(sessionId: string): void {
    if (!this.deletedSessions.has(sessionId)) return
    this.processPending.delete(sessionId)
    this.deps.discardPendingBinding?.(sessionId)
    this.deps.sessionBinding.clearSession(sessionId)
    throw new Error('The Session was deleted before Specialist reconfiguration completed.')
  }
}
