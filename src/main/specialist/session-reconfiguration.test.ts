import { beforeEach, describe, expect, it, vi } from 'vitest'

const loggerSpies = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: loggerSpies.info,
      warn: vi.fn(),
      error: loggerSpies.error
    })
  }
})

import type { SpecialistProfileView } from '../../shared/specialist'
import type { ProfileService } from './service'
import { SessionBindingService } from './session-binding'
import { SessionSpecialistReconfiguration } from './session-reconfiguration'

const profile = {
  id: 'specialist-new',
  name: 'SPECIALIST_NEW',
  description: '',
  systemPrompt: '',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
} satisfies SpecialistProfileView

const bindingService = (): SessionBindingService =>
  new SessionBindingService({
    resolveRunnableById: vi.fn().mockResolvedValue(profile)
  } as unknown as ProfileService)

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('SessionSpecialistReconfiguration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records phase timings for a Session Specialist switch', async () => {
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: bindingService(),
      loadBinding: async () => undefined,
      persistBinding: async () => undefined,
      applyRuntime: async () => ({ contextReset: true })
    })

    await owner.requestSwitch('session-1', profile.id)

    const events = loggerSpies.info.mock.calls.filter(
      ([, data]) => data?.operation === 'specialist-session-switch'
    )
    expect(
      events.map(([message, data]) => ({
        message,
        phase: data?.phase,
        outcome: data?.outcome
      }))
    ).toEqual([
      { message: 'operation started', phase: undefined, outcome: 'started' },
      { message: 'operation phase', phase: 'queued', outcome: undefined },
      { message: 'operation phase', phase: 'validate-target', outcome: undefined },
      { message: 'operation phase', phase: 'persist-pending', outcome: undefined },
      { message: 'operation phase', phase: 'apply-runtime', outcome: undefined },
      { message: 'operation phase', phase: 'persist-applied', outcome: undefined },
      { message: 'operation completed', phase: 'persist-applied', outcome: 'completed' }
    ])
    expect(events.slice(1, -1).every(([, data]) => typeof data?.elapsedMs === 'number')).toBe(true)
    expect(events.at(-1)?.[1]).toMatchObject({
      status: 'applied',
      contextReset: true,
      durationMs: expect.any(Number)
    })
  })

  it('commits pending before runtime application and clears it only after success', async () => {
    const binding = bindingService()
    let persisted: { specialistId?: string; specialistBindingPending?: true } = {}
    const order: string[] = []
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => persisted,
      persistBinding: async (_sessionId, specialistId, pending) => {
        order.push(pending ? 'persist-pending' : 'persist-applied')
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime: async () => {
        order.push('apply-runtime')
        return { contextReset: true }
      }
    })

    await expect(owner.requestSwitch('session-1', profile.id)).resolves.toEqual({
      status: 'applied',
      contextReset: true
    })
    expect(order).toEqual(['persist-pending', 'apply-runtime', 'persist-applied'])
    expect(persisted).toEqual({ specialistId: profile.id })
    expect(binding.getBinding('session-1')).toBe(profile.id)
    await expect(owner.assertUserPromptReady('session-1')).resolves.toBeUndefined()
  })

  it('blocks prompts while the durable pending binding is still being written', async () => {
    const binding = bindingService()
    const persistEntered = deferred()
    const releasePersist = deferred()
    let persisted: { specialistId?: string; specialistBindingPending?: true } = {}
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => persisted,
      persistBinding: async (_sessionId, specialistId, pending) => {
        if (pending) {
          persistEntered.resolve()
          await releasePersist.promise
        }
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime: async () => ({ contextReset: false })
    })

    const switching = owner.requestSwitch('session-1', profile.id)
    await persistEntered.promise

    await expect(owner.assertUserPromptReady('session-1')).rejects.toThrow(/has not been applied/)

    releasePersist.resolve()
    await expect(switching).resolves.toEqual({ status: 'applied', contextReset: false })
    await expect(owner.assertUserPromptReady('session-1')).resolves.toBeUndefined()
  })

  it('rechecks the switch barrier after reading the persisted binding', async () => {
    const binding = bindingService()
    const loadEntered = deferred()
    const releaseLoad = deferred()
    const persistEntered = deferred()
    const releasePersist = deferred()
    let persisted: { specialistId?: string; specialistBindingPending?: true } = {}
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => {
        loadEntered.resolve()
        await releaseLoad.promise
        return persisted
      },
      persistBinding: async (_sessionId, specialistId, pending) => {
        if (pending) {
          persistEntered.resolve()
          await releasePersist.promise
        }
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime: async () => ({ contextReset: false })
    })

    const promptAdmission = owner.assertUserPromptReady('session-1')
    await loadEntered.promise
    const switching = owner.requestSwitch('session-1', profile.id)
    await persistEntered.promise
    releaseLoad.resolve()

    await expect(promptAdmission).rejects.toThrow(/has not been applied/)

    releasePersist.resolve()
    await expect(switching).resolves.toEqual({ status: 'applied', contextReset: false })
  })

  it('keeps the durable marker, blocks prompts, and supports runtime retry after failure', async () => {
    const binding = bindingService()
    let persisted: { specialistId?: string; specialistBindingPending?: true } = {}
    const applyRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime failed'))
      .mockResolvedValueOnce({ contextReset: false })
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => persisted,
      persistBinding: async (_sessionId, specialistId, pending) => {
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime
    })

    await expect(owner.requestSwitch('session-1', profile.id)).resolves.toEqual({
      status: 'pending',
      reason: 'runtime-application-failed'
    })
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'specialist-session-switch',
        phase: 'apply-runtime',
        outcome: 'completed',
        status: 'pending',
        reason: 'runtime-application-failed',
        durationMs: expect.any(Number)
      })
    )
    expect(persisted).toEqual({
      specialistId: profile.id,
      specialistBindingPending: true
    })
    await expect(owner.assertUserPromptReady('session-1')).rejects.toThrow(/has not been applied/)

    await expect(owner.applyPersisted('session-1', profile.id)).resolves.toEqual({
      contextReset: false
    })
    expect(persisted).toEqual({ specialistId: profile.id })
    await expect(owner.assertUserPromptReady('session-1')).resolves.toBeUndefined()
  })

  it('reports a pending state when runtime applied but the marker clear failed', async () => {
    const binding = bindingService()
    let persisted: { specialistId?: string; specialistBindingPending?: true } = {}
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => persisted,
      persistBinding: async (_sessionId, specialistId, pending) => {
        if (!pending) throw new Error('disk unavailable')
        persisted = { specialistId, specialistBindingPending: true }
      },
      applyRuntime: async () => ({ contextReset: false })
    })

    await expect(owner.requestSwitch('session-1', profile.id)).resolves.toEqual({
      status: 'pending',
      reason: 'pending-state-clear-failed'
    })
    await expect(owner.assertUserPromptReady('session-1')).rejects.toThrow(/has not been applied/)
  })

  it('invalidates in-flight and queued switches when the Session is deleted', async () => {
    const binding = bindingService()
    const persistEntered = deferred()
    const releasePersist = deferred()
    let pendingBindingStashed = false
    const discardPendingBinding = vi.fn(() => {
      pendingBindingStashed = false
    })
    const persistBinding = vi.fn(async () => {
      persistEntered.resolve()
      await releasePersist.promise
      pendingBindingStashed = true
    })
    const applyRuntime = vi.fn(async () => ({ contextReset: false }))
    const owner = new SessionSpecialistReconfiguration({
      sessionBinding: binding,
      loadBinding: async () => undefined,
      persistBinding,
      discardPendingBinding,
      applyRuntime
    })

    const inFlight = owner.requestSwitch('session-1', profile.id)
    await persistEntered.promise
    const queued = owner.requestSwitch('session-1', profile.id)

    owner.clearSession('session-1')
    releasePersist.resolve()

    await expect(inFlight).rejects.toThrow(/deleted/)
    await expect(queued).rejects.toThrow(/deleted/)
    expect(persistBinding).toHaveBeenCalledOnce()
    expect(applyRuntime).not.toHaveBeenCalled()
    expect(discardPendingBinding).toHaveBeenCalledWith('session-1')
    expect(discardPendingBinding.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(pendingBindingStashed).toBe(false)
    expect(binding.getBinding('session-1')).toBeUndefined()
  })
})
