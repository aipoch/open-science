import { describe, expect, it, vi } from 'vitest'

import { applyDelete } from './specialist-privileged-ops'
import type { AgentDeletedResult, AgentDeclinedResult } from './specialist-privileged-ops'
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
  service.resolveCustomMutationByName = vi.fn(async (name: string) => service.getByName(name))
  return {
    service,
    calls,
    getStore: () => store,
    setStore: (s: SpecialistProfileView[]) => (store = s)
  }
}

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

  it('threads the trusted calling session into the approval request', async () => {
    const { service } = makeService({ initial: [profile()] })
    const seen: unknown[] = []
    await applyDelete({
      profileService: service,
      decide: async (request) => {
        seen.push(request.session)
        return fakeApproved()
      },
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      // The dispatcher threads the trusted session from server context (mirroring runSwitch); the
      // ACP-backed gateway parks the card on THIS session, so an empty session would decline.
      session: { sessionId: 'session-9', turnId: 'turn-1' }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ sessionId: 'session-9', turnId: 'turn-1' })
  })
})

describe('no-state-change guarantees on decline', () => {
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
    await applyDelete({
      profileService: service,
      decide: async () => fakeApproved(),
      currentName: 'DATA_ANALYST',
      reviewedRevision: 3,
      invalidateCatalog: invalidated
    })
    expect(invalidated).toHaveBeenCalledTimes(1)
  })
})
