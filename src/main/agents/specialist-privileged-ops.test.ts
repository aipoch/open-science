import { describe, expect, it, vi } from 'vitest'

import {
  applyDelete,
  applyNameChangingUpdate,
  isNameChangingPatch
} from './specialist-privileged-ops'
import type { SpecialistUpdatePatch } from './specialist-approval-presentation'
import type {
  AgentDeletedResult,
  AgentDeclinedResult,
  AgentUpdatedResult
} from './specialist-privileged-ops'
import type { ApprovalResult } from '../../shared/agents-contract'
import type { SpecialistProfileView } from '../../shared/specialist'
import type { ProfileService } from '../specialist/service'

const profile = (overrides: Partial<SpecialistProfileView> = {}): SpecialistProfileView => ({
  id: 'sp-1',
  name: 'DATA_ANALYST',
  displayName: 'Data Analyst',
  description: 'a specialist',
  systemPrompt: 'instructions',
  iconKey: 'chart',
  colorKey: 'violet',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 3,
  ...overrides
})

const fakeApproved = (): ApprovalResult => ({ status: 'approved' })
const fakeDeclined = (operation: 'update' | 'delete' | 'switch'): ApprovalResult => ({
  status: 'declined',
  operation
})

type FakeService = {
  service: ProfileService
  calls: {
    update: Array<{ id: string; patch: Record<string, unknown>; revision: number }>
    delete: Array<{ id: string; revision?: number }>
    getByName: string[]
  }
  getStore: () => SpecialistProfileView[]
  setStore: (s: SpecialistProfileView[]) => void
}

// A ProfileService fake that records mutations and lets tests simulate drift (revision mismatch,
// rename, deletion) between card creation and approval.
const makeService = (opts: {
  initial?: SpecialistProfileView[]
  onUpdate?: (id: string, patch: Record<string, unknown>, revision: number) => SpecialistProfileView
  onDelete?: (id: string, revision?: number) => void
}): FakeService => {
  let store = opts.initial ? [...opts.initial] : []
  const calls = {
    update: [] as Array<{ id: string; patch: Record<string, unknown>; revision: number }>,
    delete: [] as Array<{ id: string; revision?: number }>,
    getByName: [] as string[]
  }
  const service = {
    list: vi.fn(async () => [...store]),
    getByName: vi.fn(async (name: string) => {
      calls.getByName.push(name)
      const found = store.find((p) => p.name === name)
      if (!found) throw new Error(`Specialist "${name}" not found.`)
      return found
    }),
    getById: vi.fn(async (id: string) => {
      const found = store.find((p) => p.id === id)
      if (!found) throw new Error(`Specialist ${id} not found.`)
      return found
    }),
    update: vi.fn(async (input: { id: string; revision: number } & Record<string, unknown>) => {
      calls.update.push({ id: input.id, patch: input, revision: input.revision })
      const idx = store.findIndex((p) => p.id === input.id)
      if (idx < 0) throw new Error('not found')
      if (store[idx].revision !== input.revision) {
        throw new Error('revision mismatch')
      }
      const next = opts.onUpdate
        ? opts.onUpdate(input.id, input, input.revision)
        : { ...store[idx], ...input, revision: store[idx].revision + 1 }
      store[idx] = next
      return next
    }),
    delete: vi.fn(async (id: string, revision?: number) => {
      calls.delete.push({ id, revision })
      if (opts.onDelete) opts.onDelete(id, revision)
      const idx = store.findIndex((p) => p.id === id)
      if (idx < 0) throw new Error('not found')
      if (revision !== undefined && store[idx].revision !== revision) {
        throw new Error('revision mismatch')
      }
      store = store.filter((p) => p.id !== id)
    })
  } as unknown as ProfileService
  return {
    service,
    calls,
    getStore: () => store,
    setStore: (s: SpecialistProfileView[]) => (store = s)
  }
}

describe('isNameChangingPatch — update classification', () => {
  it('is privileged when the validated patch changes name', () => {
    expect(isNameChangingPatch({ name: 'NEW_NAME' })).toBe(true)
    expect(isNameChangingPatch({ name: 'NEW_NAME', description: 'x' })).toBe(true)
  })
  it('is NOT privileged when the patch leaves name unchanged', () => {
    expect(isNameChangingPatch({ description: 'x' })).toBe(false)
    expect(isNameChangingPatch({ enabled: false })).toBe(false)
    expect(isNameChangingPatch({})).toBe(false)
  })
  it('ignores a name that equals undefined (omitted), not an empty rename intent', () => {
    expect(isNameChangingPatch({ name: undefined })).toBe(false)
  })
})

describe('applyNameChangingUpdate — approved atomic update', () => {
  it('re-resolves public name to UUID, verifies the reviewed revision, commits, returns camelCase read-back', async () => {
    const { service, calls } = makeService({ initial: [profile()] })
    const patch: SpecialistUpdatePatch = {
      name: 'DATA_SCIENTIST',
      description: 'updated desc',
      systemPrompt: 'new instructions'
    }
    const result = await applyNameChangingUpdate({
      profileService: service,
      decide: async () => fakeApproved(),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      patch
    })
    // Returned actual camelCase read-back, not the input patch.
    expect(result).toEqual<AgentUpdatedResult>({
      status: 'updated',
      agent: expect.objectContaining({ id: 'sp-1', name: 'DATA_SCIENTIST', revision: 4 })
    })
    // Re-resolved by public name immediately before mutation.
    expect(calls.getByName).toContain('DATA_ANALYST')
    // One atomic update carrying the COMPLETE patch, revision verified.
    expect(calls.update).toHaveLength(1)
    expect(calls.update[0]).toEqual({
      id: 'sp-1',
      revision: 3,
      patch: expect.objectContaining({
        id: 'sp-1',
        revision: 3,
        name: 'DATA_SCIENTIST',
        description: 'updated desc'
      })
    })
  })

  it('returns a structured declined result and applies NO part of the patch', async () => {
    const { service, calls } = makeService({ initial: [profile()] })
    const result = await applyNameChangingUpdate({
      profileService: service,
      decide: async () => fakeDeclined('update'),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      patch: { name: 'DATA_SCIENTIST', description: 'should not apply' }
    })
    expect(result).toEqual<AgentDeclinedResult>({ status: 'declined', operation: 'update' })
    expect(calls.update).toHaveLength(0)
  })
})

describe('applyNameChangingUpdate — post-approval revision drift fails closed', () => {
  it('does not apply any part of the patch when revision changed after card creation', async () => {
    const { service, calls } = makeService({
      initial: [profile({ revision: 3 })],
      // Simulate drift: someone bumped revision to 4 while the card was pending.
      onUpdate: (_id, patch) => ({ ...profile({ revision: 3 }), ...patch, revision: 4 })
    })
    // Pre-mutate so the stored revision is now 4 (drifted from the reviewed 3).
    await service.update({ id: 'sp-1', revision: 3, description: 'concurrent change' })
    calls.update.length = 0

    await expect(
      applyNameChangingUpdate({
        profileService: service,
        decide: async () => fakeApproved(),
        currentName: 'DATA_ANALYST',
        reviewedRevision: 3,
        patch: { name: 'DATA_SCIENTIST' }
      })
    ).rejects.toThrow(/host\.agents\.update:/)
    expect(calls.update).toHaveLength(0)
  })

  it('fails closed when the target was renamed after card creation', async () => {
    const { service } = makeService({ initial: [profile({ name: 'OTHER_NAME', revision: 3 })] })
    await expect(
      applyNameChangingUpdate({
        profileService: service,
        decide: async () => fakeApproved(),
        currentName: 'DATA_ANALYST',
        reviewedRevision: 3,
        patch: { name: 'DATA_SCIENTIST' }
      })
    ).rejects.toThrow(/host\.agents\.update:/)
  })

  it('fails closed when the target was deleted after card creation', async () => {
    const { service } = makeService({ initial: [] })
    await expect(
      applyNameChangingUpdate({
        profileService: service,
        decide: async () => fakeApproved(),
        currentName: 'DATA_ANALYST',
        reviewedRevision: 3,
        patch: { name: 'DATA_SCIENTIST' }
      })
    ).rejects.toThrow(/host\.agents\.update:/)
  })
})

describe('applyDelete — approved delete', () => {
  it('re-resolves name, verifies absence, returns {status:"deleted", name} without clearing bindings', async () => {
    const bindingClearCalls: string[] = []
    const { service, calls } = makeService({ initial: [profile()] })
    const result = await applyDelete({
      profileService: service,
      decide: async () => fakeApproved(),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      // A sink that WOULD clear bindings if the module were (incorrectly) wired to do so. The test
      // asserts it is never called.
      clearSessionBindings: async (id) => {
        bindingClearCalls.push(id)
      }
    })
    expect(result).toEqual<AgentDeletedResult>({ status: 'deleted', name: 'DATA_ANALYST' })
    expect(calls.delete).toHaveLength(1)
    expect(calls.delete[0]).toEqual({ id: 'sp-1', revision: 3 })
    expect(bindingClearCalls).toHaveLength(0)
  })

  it('returns a structured declined result {operation:"delete"} with no mutation', async () => {
    const { service, calls } = makeService({ initial: [profile()] })
    const result = await applyDelete({
      profileService: service,
      decide: async () => fakeDeclined('delete'),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3
    })
    expect(result).toEqual<AgentDeclinedResult>({ status: 'declined', operation: 'delete' })
    expect(calls.delete).toHaveLength(0)
  })

  it('deleting a bound Profile leaves bindings intact (sessions resolve unavailable later)', async () => {
    const { service } = makeService({ initial: [profile()] })
    // Provide a no-op binding sink; the contract is that delete NEVER clears/rewrites it.
    await applyDelete({
      profileService: service,
      decide: async () => fakeApproved(),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      clearSessionBindings: async () => {
        throw new Error('delete must not clear bindings')
      }
    })
    // No throw => the sink was never invoked.
  })

  it('rethrows an unexpected absence-check error instead of misreporting a successful delete', async () => {
    const { service } = makeService({ initial: [profile()] })
    // The first getByName (re-resolve) succeeds; the absence-verification getByName (after delete)
    // simulates a corrupt store throwing an I/O error rather than the expected "not found".
    const getByName = vi.mocked(service.getByName)
    getByName
      .mockResolvedValueOnce(profile())
      .mockRejectedValue(new Error('I/O error: corrupt specialist store'))
    await expect(
      applyDelete({
        profileService: service,
        decide: async () => fakeApproved(),
        currentName: 'DATA_ANALYST',
        reviewedRevision: 3
      })
    ).rejects.toThrow(/host\.agents\.delete:.*I\/O error/)
  })

  it('fails closed with a sanitized error when revision drifted before approval', async () => {
    const { service } = makeService({ initial: [profile({ revision: 4 })] })
    await expect(
      applyDelete({
        profileService: service,
        decide: async () => fakeApproved(),
        currentName: 'DATA_ANALYST',
        reviewedRevision: 3
      })
    ).rejects.toThrow(/host\.agents\.delete:/)
  })
})

describe('no-state-change guarantees on decline', () => {
  it('declined update touches no mutation, no binding, no invalidation', async () => {
    const invalidated = vi.fn()
    const { service, calls } = makeService({ initial: [profile()] })
    await applyNameChangingUpdate({
      profileService: service,
      decide: async () => fakeDeclined('update'),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      patch: { name: 'X' },
      invalidateCatalog: invalidated
    })
    expect(calls.update).toHaveLength(0)
    expect(invalidated).not.toHaveBeenCalled()
  })

  it('declined delete touches no mutation, no invalidation', async () => {
    const invalidated = vi.fn()
    const { service, calls } = makeService({ initial: [profile()] })
    await applyDelete({
      profileService: service,
      decide: async () => fakeDeclined('delete'),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      invalidateCatalog: invalidated
    })
    expect(calls.delete).toHaveLength(0)
    expect(invalidated).not.toHaveBeenCalled()
  })

  it('catalog invalidation runs ONLY after a successful mutation', async () => {
    const invalidated = vi.fn()
    const { service } = makeService({ initial: [profile()] })
    await applyNameChangingUpdate({
      profileService: service,
      decide: async () => fakeApproved(),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      patch: { name: 'DATA_SCIENTIST' },
      invalidateCatalog: invalidated
    })
    expect(invalidated).toHaveBeenCalledTimes(1)
  })
})
