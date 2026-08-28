// Per-session specialist binding store.
//
// Responsibilities:
//   • Record a mutable Specialist ID binding for each app session (in memory).
//   • Resolve that binding against the live SpecialistService catalog to produce a
//     SessionSpecialistResolution (main | bound | unavailable).
//   • Act as the named seam for the reconfigure barrier: the future SDK
//     host.agents.switch() will resolve name→UUID and call setBinding() here,
//     not a second switching path (see issues/deferred/08).
//
// Session persistence (UUID only, never a snapshot) is handled by the caller
// writing specialistId to the persisted session file; this service holds the
// live in-memory view and the resolution logic.

import { createLogger } from '../logger'
import type { SpecialistService } from './service'
import type { SessionSpecialistResolution, SpecialistView } from '../../shared/specialist'

const log = createLogger('specialist.session-binding')

export class SessionBindingService {
  // sessionId → specialist UUID (undefined = no binding = main agent)
  private readonly bindings = new Map<string, string | undefined>()

  constructor(private readonly specialistService: SpecialistService) {}

  // Records (or clears) the specialist UUID for one session. Persisting the
  // UUID to the session file is the caller's responsibility (IPC handler writes
  // it via the notebook registry or session persistence layer).
  setBinding(sessionId: string, specialistId: string | undefined): void {
    if (specialistId === undefined) {
      this.bindings.delete(sessionId)
    } else {
      this.bindings.set(sessionId, specialistId)
    }
    log.debug('session specialist binding updated', { sessionId, specialistId })
  }

  // Reads the current in-memory binding for a session. Returns undefined when
  // no binding has been recorded (main agent).
  getBinding(sessionId: string): string | undefined {
    return this.bindings.get(sessionId)
  }

  // Resolves the current binding against the live catalog.
  // - 'main'        — no Specialist ID binding present.
  // - 'bound'       — Specialist ID found, profile enabled.
  // - 'unavailable' — Specialist ID unknown, disabled, or corrupt.
  //
  // If `overrideSpecialistId` is provided, that ID is resolved instead of the
  // stored binding (used by the IPC handler to validate a proposed new binding).
  async resolve(
    sessionId: string,
    overrideSpecialistId?: string
  ): Promise<SessionSpecialistResolution> {
    const specialistId = overrideSpecialistId ?? this.bindings.get(sessionId)
    if (!specialistId) return { kind: 'main' }

    let profile: SpecialistView | undefined
    try {
      profile = await this.specialistService.resolveRunnableById(specialistId)
    } catch (error) {
      // Distinguish a genuine not-found (profile deleted) from a transient I/O failure (corrupt
      // store, permission error). getById throws "Specialist <id> not found." for missing profiles;
      // any other error is an I/O or data failure. Log the real error so a corrupt store is
      // diagnosable rather than silently misreported as a deletion.
      const message = error instanceof Error ? error.message : String(error)
      const isNotFound = message.includes('not found')
      if (!isNotFound) {
        log.error('specialist catalog read failed; treating binding as unavailable', {
          sessionId,
          specialistId,
          error
        })
        return {
          kind: 'unavailable',
          reason: `Specialist ${specialistId} could not be loaded (store error).`
        }
      }
      log.warn('session specialist not found; binding unavailable', { sessionId, specialistId })
      return { kind: 'unavailable', reason: `Specialist ${specialistId} not found.` }
    }

    if (!profile.enabled) {
      log.warn('session specialist disabled; binding unavailable', { sessionId, specialistId })
      return { kind: 'unavailable', reason: `Specialist "${profile.name}" is disabled.` }
    }

    log.debug('session specialist resolved', { sessionId, specialistId, kind: 'bound' })
    return { kind: 'bound', profile }
  }

  // Removes all bindings for a session (called when a session is deleted).
  clearSession(sessionId: string): void {
    this.bindings.delete(sessionId)
  }
}
