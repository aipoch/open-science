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
})
