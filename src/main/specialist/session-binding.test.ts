import { describe, it, expect, vi } from 'vitest'
import { SessionBindingService } from './session-binding'
import type { SpecialistService } from './service'
import type { SpecialistView } from '../../shared/specialist'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeProfile = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
  id: 'uuid-sp1',
  name: 'DEBUGGER',
  displayName: 'Debugger',
  description: 'A debugging specialist.',
  systemPrompt: 'You are a debugger.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: emptySelectedConfig(),
  revision: 1,
  ...overrides
})

const makeService = (profiles: Map<string, SpecialistView> = new Map()): SpecialistService => {
  return {
    getById: vi.fn(async (id: string) => {
      const p = profiles.get(id)
      if (!p) throw new Error(`Specialist ${id} not found.`)
      return p
    }),
    resolveRunnableById: vi.fn(async (id: string) => {
      const p = profiles.get(id)
      if (!p) throw new Error(`Runnable Specialist ${id} not found.`)
      return p
    })
  } as unknown as SpecialistService
}

// ---------------------------------------------------------------------------
// Tests: setBinding / getBinding
// ---------------------------------------------------------------------------

describe('SessionBindingService.setBinding', () => {
  it('stores a specialist UUID for a session', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    expect(svc.getBinding('session-a')).toBe('uuid-sp1')
  })

  it('clears a binding when undefined is passed', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', undefined)
    expect(svc.getBinding('session-a')).toBeUndefined()
  })

  it('does not affect other sessions', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')
    expect(svc.getBinding('session-a')).toBe('uuid-sp1')
    expect(svc.getBinding('session-b')).toBe('uuid-sp2')
  })

  it('last-write-wins when switching multiple times', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', 'uuid-sp2')
    svc.setBinding('session-a', 'uuid-sp3')
    expect(svc.getBinding('session-a')).toBe('uuid-sp3')
  })
})

// ---------------------------------------------------------------------------
// Tests: resolve — main / bound / unavailable
// ---------------------------------------------------------------------------

describe('SessionBindingService.resolve', () => {
  it('resolves builtin bindings through the runnable catalog instead of the custom repository query', async () => {
    const builtin = makeProfile({ id: 'builtin-curator', name: 'BUILTIN_CURATOR', revision: 0 })
    const specialistService = {
      getById: vi.fn(async () => {
        throw new Error('custom-only query must not be used')
      }),
      resolveRunnableById: vi.fn(async () => builtin)
    } as unknown as SpecialistService
    const svc = new SessionBindingService(specialistService)
    svc.setBinding('restored-session', builtin.id)

    await expect(svc.resolve('restored-session')).resolves.toEqual({
      kind: 'bound',
      profile: builtin
    })
    expect(specialistService.getById).not.toHaveBeenCalled()
  })

  it("returns 'main' when no binding is recorded", async () => {
    const svc = new SessionBindingService(makeService())
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })

  it("returns 'main' after binding is cleared", async () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', undefined)
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })

  it("returns 'bound' with the profile when UUID is found and enabled", async () => {
    const profile = makeProfile()
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.id).toBe('uuid-sp1')
      expect(result.profile.name).toBe('DEBUGGER')
    }
  })

  it("returns 'unavailable' when UUID is not found in catalog", async () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-deleted')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('uuid-deleted')
    }
  })

  it("returns 'unavailable' when profile is disabled", async () => {
    const profile = makeProfile({ enabled: false })
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('disabled')
    }
  })

  it('resolves an override UUID instead of the stored binding', async () => {
    const profile2 = makeProfile({ id: 'uuid-sp2', name: 'RESEARCHER' })
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp2', profile2]])))
    svc.setBinding('session-a', 'uuid-sp1') // stored binding
    const result = await svc.resolve('session-a', 'uuid-sp2') // override
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.id).toBe('uuid-sp2')
    }
  })

  it('isolates sessions — resolve for one does not affect another', async () => {
    const profile1 = makeProfile({ id: 'uuid-sp1', name: 'DEBUGGER' })
    const profile2 = makeProfile({ id: 'uuid-sp2', name: 'RESEARCHER' })
    const svc = new SessionBindingService(
      makeService(
        new Map([
          ['uuid-sp1', profile1],
          ['uuid-sp2', profile2]
        ])
      )
    )
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')

    const [ra, rb] = await Promise.all([svc.resolve('session-a'), svc.resolve('session-b')])
    expect(ra.kind).toBe('bound')
    expect(rb.kind).toBe('bound')
    if (ra.kind === 'bound') expect(ra.profile.id).toBe('uuid-sp1')
    if (rb.kind === 'bound') expect(rb.profile.id).toBe('uuid-sp2')
  })
})

// ---------------------------------------------------------------------------
// Tests: clearSession
// ---------------------------------------------------------------------------

describe('SessionBindingService.clearSession', () => {
  it('removes the binding for the session', async () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.clearSession('session-a')
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })

  it('does not affect other sessions when clearing', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')
    svc.clearSession('session-a')
    expect(svc.getBinding('session-a')).toBeUndefined()
    expect(svc.getBinding('session-b')).toBe('uuid-sp2')
  })
})

// ---------------------------------------------------------------------------
// Tests: None clears binding (clears and returns main)
// ---------------------------------------------------------------------------

describe('SessionBindingService — None clears binding', () => {
  it('binding cleared to undefined resolves to main (no separate Main profile)', async () => {
    const profile = makeProfile()
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-a', undefined) // None
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
  })
})

// ---------------------------------------------------------------------------
// Tests: Lazy reconfigure — profile update reads latest revision
// ---------------------------------------------------------------------------

describe('SessionBindingService — lazy profile update', () => {
  it('reads the latest profile on each resolve (not a cached snapshot)', async () => {
    const profile = makeProfile({ revision: 1, systemPrompt: 'v1' })
    const catalog = new Map<string, SpecialistView>([['uuid-sp1', profile]])
    const svc = new SessionBindingService(makeService(catalog))
    svc.setBinding('session-a', 'uuid-sp1')

    // First resolve returns revision 1.
    let result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') expect(result.profile.revision).toBe(1)

    // Simulate profile update (e.g. user edited identity).
    catalog.set('uuid-sp1', { ...profile, revision: 2, systemPrompt: 'v2' })

    // Second resolve returns the new revision — not a stale snapshot.
    result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.revision).toBe(2)
      expect(result.profile.systemPrompt).toBe('v2')
    }
  })

  it('catalog-change event does not trigger bulk session resume (lazy resolution only)', async () => {
    // The binding service must not iterate sessions or trigger per-session resume when the catalog
    // changes. Correct behavior: each resolve() call reads the latest catalog on demand; the service
    // holds no subscriber that iterates sessions or triggers any resume operation.
    const profile = makeProfile({ id: 'uuid-sp1', revision: 1 })
    const catalog = new Map<string, SpecialistView>([['uuid-sp1', profile]])
    const svc = new SessionBindingService(makeService(catalog))
    svc.setBinding('session-a', 'uuid-sp1')

    // Simulate a catalog-changed event by mutating the catalog backing the service.
    catalog.set('uuid-sp1', { ...profile, revision: 2 })

    // Only an explicit resolve() call reads the new data — not an automatic side effect.
    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      // Updated revision is visible, but only because we called resolve(), not due to a push.
      expect(result.profile.revision).toBe(2)
    }

    // No session iteration happened proactively — resolve was called exactly once above.
    // The service has no method that processes all sessions at once.
    expect(typeof (svc as unknown as Record<string, unknown>).resumeAllSessions).toBe('undefined')
    expect(typeof (svc as unknown as Record<string, unknown>).bulkResume).toBe('undefined')
    expect(typeof (svc as unknown as Record<string, unknown>).onCatalogChanged).toBe('undefined')
  })
})

// ---------------------------------------------------------------------------
// Tests: I/O failure vs not-found discrimination
// ---------------------------------------------------------------------------

describe('SessionBindingService.resolve — I/O failure discrimination', () => {
  it("returns 'unavailable' with an I/O reason for non-not-found errors", async () => {
    const brokenService: SpecialistService = {
      getById: vi.fn().mockRejectedValue(new Error('EACCES: permission denied'))
    } as unknown as SpecialistService
    const svc = new SessionBindingService(brokenService)
    svc.setBinding('session-a', 'uuid-sp1')

    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      // Must not claim the specialist was deleted — it was an I/O error.
      expect(result.reason).not.toContain('not found')
      expect(result.reason).toContain('store error')
    }
  })

  it("returns 'unavailable' with a not-found reason for a missing specialist", async () => {
    const svc = new SessionBindingService(makeService()) // empty catalog
    svc.setBinding('session-a', 'uuid-deleted')

    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('not found')
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: clearSession is invoked when a session is deleted
// ---------------------------------------------------------------------------

describe('SessionBindingService.clearSession — deletion wiring', () => {
  it('removes the binding when the session is deleted', async () => {
    const profile = makeProfile()
    const svc = new SessionBindingService(makeService(new Map([['uuid-sp1', profile]])))
    svc.setBinding('session-a', 'uuid-sp1')

    // Simulate session deletion
    svc.clearSession('session-a')

    const result = await svc.resolve('session-a')
    expect(result.kind).toBe('main')
    expect(svc.getBinding('session-a')).toBeUndefined()
  })

  it('does not affect bindings for other sessions on clearSession', () => {
    const svc = new SessionBindingService(makeService())
    svc.setBinding('session-a', 'uuid-sp1')
    svc.setBinding('session-b', 'uuid-sp2')

    svc.clearSession('session-a')

    expect(svc.getBinding('session-a')).toBeUndefined()
    expect(svc.getBinding('session-b')).toBe('uuid-sp2')
  })
})

// ---------------------------------------------------------------------------
// Tests: restart round-trip (persist → re-read → binding restored)
// ---------------------------------------------------------------------------

describe('SessionBindingService — restart round-trip simulation', () => {
  it('binding is the new UUID after simulated restart (re-create service with persisted UUID)', async () => {
    const profile = makeProfile({ id: 'uuid-sp2', name: 'RESEARCHER' })
    const catalog = new Map<string, SpecialistView>([['uuid-sp2', profile]])

    // First service instance — represents the running app.
    const svc1 = new SessionBindingService(makeService(catalog))
    svc1.setBinding('session-a', 'uuid-sp2')

    // Simulate restart: create a fresh service (in-memory state cleared).
    const svc2 = new SessionBindingService(makeService(catalog))
    // On restart, the renderer calls sessions:load-all and then re-hydrates each session's
    // specialistId from the durable file into the new binding service. Simulate that here.
    const persistedSpecialistId = svc1.getBinding('session-a')
    expect(persistedSpecialistId).toBe('uuid-sp2')
    if (persistedSpecialistId !== undefined) {
      svc2.setBinding('session-a', persistedSpecialistId)
    }

    // After restart hydration the binding is the new UUID, not the old default.
    const result = await svc2.resolve('session-a')
    expect(result.kind).toBe('bound')
    if (result.kind === 'bound') {
      expect(result.profile.id).toBe('uuid-sp2')
    }
  })
})
