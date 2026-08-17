import { describe, expect, it, vi } from 'vitest'

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
