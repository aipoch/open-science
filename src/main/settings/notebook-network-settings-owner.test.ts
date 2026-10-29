import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  type NotebookNetworkSettings
} from '../../shared/notebook-network'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { NotebookNetworkSettingsOwner } from './notebook-network-settings-owner'
import type { StoredSettings } from './types'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))
beforeEach(() => {
  lookup.mockResolvedValue([{ address: '10.32.0.7', family: 4 }])
})

describe('NotebookNetworkSettingsOwner', () => {
  const harness = (
    initial: NotebookNetworkSettings = DEFAULT_NOTEBOOK_NETWORK_SETTINGS
  ): Readonly<{
    owner: NotebookNetworkSettingsOwner
    repository: {
      getSettings: ReturnType<typeof vi.fn>
      setNotebookNetwork: ReturnType<
        typeof vi.fn<(next: NotebookNetworkSettings) => Promise<StoredSettings>>
      >
    }
    apply: ReturnType<typeof vi.fn>
    read: () => NotebookNetworkSettings
  }> => {
    let stored: NotebookNetworkSettings = initial
    const document = (): StoredSettings => ({
      version: SETTINGS_FILE_VERSION,
      providers: [],
      notebookNetwork: stored
    })
    const repository = {
      getSettings: vi.fn(async () => document()),
      setNotebookNetwork: vi.fn(async (next: NotebookNetworkSettings) => {
        stored = next
        return document()
      })
    }
    const apply = vi.fn().mockResolvedValue(undefined)
    return {
      owner: new NotebookNetworkSettingsOwner({ repository, apply }),
      repository,
      apply,
      read: () => stored
    }
  }

  it('rolls back persistence when the live sandbox rejects an update', async () => {
    let stored: NotebookNetworkSettings = { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS }
    const document = (): StoredSettings => ({
      version: SETTINGS_FILE_VERSION,
      providers: [],
      notebookNetwork: stored
    })
    const repository = {
      getSettings: vi.fn(async () => document()),
      setNotebookNetwork: vi.fn(async (next: NotebookNetworkSettings) => {
        stored = next
        return document()
      })
    }
    const apply = vi.fn().mockRejectedValueOnce(new Error('sandbox update failed'))
    const owner = new NotebookNetworkSettingsOwner({ repository, apply })

    await expect(
      owner.set({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        allowedDomains: ['data.example.org']
      })
    ).rejects.toThrow('sandbox update failed')

    expect(stored).toEqual(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    expect(repository.setNotebookNetwork).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    )
  })

  it.each(['persist', 'apply'])('rolls back a cancelled approval during %s', async (phase) => {
    const state = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    let current = true
    if (phase === 'persist') {
      const persist = state.repository.setNotebookNetwork.getMockImplementation()!
      state.repository.setNotebookNetwork.mockImplementationOnce(async (next) => {
        const stored = await persist(next)
        entered = true
        await gate
        return stored
      })
    } else {
      state.apply.mockImplementationOnce(async () => {
        entered = true
        await gate
      })
    }
    const result = state.owner.allowDomain('service.example.test', async () => {
      if (!current) throw new Error('approval cancelled')
    })
    const rejected = expect(result).rejects.toThrow('approval cancelled')
    await vi.waitFor(() => expect(entered).toBe(true))
    current = false
    release()
    await rejected
    expect(state.read()).toEqual(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    expect(state.apply).toHaveBeenLastCalledWith(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
  })

  it('rejects an approval cancelled while queued behind another settings write', async () => {
    const state = harness()
    let release!: () => void
    state.apply.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const previous = state.owner.allowDomain('existing.example.test')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let current = true
    const result = state.owner.allowDomain('cancelled.example.test', async () => {
      if (!current) throw new Error('approval cancelled')
    })
    const rejected = expect(result).rejects.toThrow('approval cancelled')
    current = false
    release()
    await previous
    await rejected
    expect(state.read().allowedDomains).toContain('existing.example.test')
    expect(state.read().allowedDomains).not.toContain('cancelled.example.test')
    expect(state.repository.setNotebookNetwork).toHaveBeenCalledTimes(1)
  })

  it('merges a stale form delta with an always-allow write in either queue order', async () => {
    const first = harness()
    const alwaysAllowFirst = first.owner.allowDomain('approved.example.org')
    const staleFormSecond = first.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['form.example.org'],
      baseAllowedDomains: []
    })
    await Promise.all([alwaysAllowFirst, staleFormSecond])
    expect(first.read().allowedDomains).toEqual(['approved.example.org', 'form.example.org'])

    const second = harness()
    const staleFormFirst = second.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['form.example.org'],
      baseAllowedDomains: []
    })
    const alwaysAllowSecond = second.owner.allowDomain('approved.example.org')
    await Promise.all([staleFormFirst, alwaysAllowSecond])
    expect(second.read().allowedDomains).toEqual(['form.example.org', 'approved.example.org'])
  })

  it('applies explicit form removals without deleting domains added after its baseline', async () => {
    const state = harness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['existing.example.org', 'approved.example.org']
    })

    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['form.example.org'],
      baseAllowedDomains: ['existing.example.org']
    })

    expect(state.read().allowedDomains).toEqual(['approved.example.org', 'form.example.org'])
  })
  const privateRule = {
    hostname: 'lab.internal.example',
    port: 8443,
    approvedAddresses: ['10.32.0.7']
  }
  it('reviews DNS and revalidates new rules before saving', async () => {
    const state = harness()
    await expect(state.owner.review(privateRule)).resolves.toEqual({
      ok: true,
      destination: privateRule
    })
    lookup.mockResolvedValue([{ address: '10.32.0.8', family: 4 }])
    await expect(
      state.owner.set({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        trustedPrivateDestinations: [privateRule],
        baseTrustedPrivateDestinations: []
      })
    ).rejects.toThrow('addresses changed')
    expect(state.repository.setNotebookNetwork).not.toHaveBeenCalled()
    lookup.mockResolvedValue([{ address: '10.32.0.7', family: 4 }])
    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [privateRule],
      baseTrustedPrivateDestinations: []
    })
    expect(state.read().trustedPrivateDestinations).toEqual([privateRule])
  })
  it('preserves private trust on public-only writes and detects stale private editors', async () => {
    const state = harness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [privateRule]
    })
    await state.owner.allowDomain('public.example')
    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['another.example'],
      baseAllowedDomains: []
    })
    expect(state.read().trustedPrivateDestinations).toEqual([privateRule])
    expect(state.read().allowedDomains).toEqual(['public.example', 'another.example'])
    await expect(
      state.owner.set({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        trustedPrivateDestinations: [],
        baseTrustedPrivateDestinations: []
      })
    ).rejects.toThrow('Private services changed')
    // Revocation does not need DNS or reachability; it applies to active policy immediately.
    lookup.mockRejectedValue(new Error('offline'))
    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [],
      baseTrustedPrivateDestinations: [privateRule]
    })
    expect(state.read().trustedPrivateDestinations).toEqual([])
    expect(state.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ trustedPrivateDestinations: [] })
    )
  })
  it('restores both private persistence and live policy if application fails', async () => {
    const state = harness()
    state.apply.mockRejectedValueOnce(new Error('apply failed'))
    await expect(
      state.owner.set({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        trustedPrivateDestinations: [privateRule],
        baseTrustedPrivateDestinations: []
      })
    ).rejects.toThrow('apply failed')
    expect(state.read()).toEqual(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    expect(state.apply).toHaveBeenLastCalledWith(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
  })
  it('preserves sibling ports and concurrent public grants while rejecting stale private removals', async () => {
    const otherPort = { ...privateRule, port: 443 }
    const baseline = [otherPort, privateRule]
    const state = harness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: baseline
    })
    const replacement = { ...privateRule, approvedAddresses: ['10.32.0.8'] }
    lookup.mockResolvedValue([{ address: '10.32.0.8', family: 4 }])
    await state.owner.allowDomain('concurrent.example.org')
    const updated = await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [otherPort, replacement],
      baseAllowedDomains: [],
      baseTrustedPrivateDestinations: baseline
    })
    expect(updated.trustedPrivateDestinations).toEqual([otherPort, replacement])
    expect(updated.allowedDomains).toEqual(['concurrent.example.org'])
    const writes = state.repository.setNotebookNetwork.mock.calls.length
    await expect(
      state.owner.set({
        ...updated,
        trustedPrivateDestinations: [otherPort],
        baseTrustedPrivateDestinations: baseline
      })
    ).rejects.toThrow('Private services changed')
    expect(state.repository.setNotebookNetwork).toHaveBeenCalledTimes(writes)
    expect(state.read()).toEqual(updated)
    lookup.mockClear().mockRejectedValue(new Error('offline'))
    const removed = await state.owner.set({
      ...updated,
      trustedPrivateDestinations: [otherPort],
      baseAllowedDomains: updated.allowedDomains,
      baseTrustedPrivateDestinations: updated.trustedPrivateDestinations
    })
    expect(removed.trustedPrivateDestinations).toEqual([otherPort])
    expect(removed.allowedDomains).toEqual(['concurrent.example.org'])
    expect(lookup).not.toHaveBeenCalled()
    expect(state.apply).toHaveBeenLastCalledWith(removed)
  })
  it('rejects malformed input instead of silently storing a broader or empty rule', async () => {
    const state = harness()
    await expect(
      state.owner.set({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        trustedPrivateDestinations: [{ ...privateRule, port: 0 }]
      })
    ).rejects.toThrow('Invalid')
    await expect(
      state.owner.review({ hostname: '*.internal.example', port: 443 })
    ).resolves.toEqual({ ok: false, reason: 'invalid' })
    expect(state.repository.setNotebookNetwork).not.toHaveBeenCalled()
  })
})

describe('exact destination grants', () => {
  it('rechecks addresses, persists an exact project grant and only accepts revocation from settings', async () => {
    let stored: NotebookNetworkSettings = DEFAULT_NOTEBOOK_NETWORK_SETTINGS
    const repository = {
      getSettings: async (): Promise<StoredSettings> => ({
        version: SETTINGS_FILE_VERSION,
        providers: [],
        notebookNetwork: stored
      }),
      setNotebookNetwork: async (next: NotebookNetworkSettings): Promise<StoredSettings> => {
        stored = next
        return { version: SETTINGS_FILE_VERSION, providers: [], notebookNetwork: stored }
      }
    }
    const owner = new NotebookNetworkSettingsOwner({ repository, apply: async () => {} })
    const grant = {
      id: 'grant',
      hostname: 'private.example',
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'project' as const,
      createdAt: 1
    }
    await owner.allowDestination(grant)
    expect((await owner.get()).destinationGrants).toEqual([grant])
    lookup.mockResolvedValue([{ address: '10.32.0.8', family: 4 }])
    await expect(owner.allowDestination({ ...grant, id: 'second' })).rejects.toThrow('changed')
    await owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [{ ...grant, id: 'forged' }]
    })
    expect((await owner.get()).destinationGrants).toEqual([grant])
    await owner.set({ ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, revokeNetworkGrantIds: ['grant'] })
    expect((await owner.get()).destinationGrants).toEqual([
      expect.objectContaining({ id: 'grant', revokedAt: expect.any(Number) })
    ])
    const restarted = new NotebookNetworkSettingsOwner({ repository, apply: async () => {} })
    await expect(restarted.allowDestination(grant)).rejects.toThrow('revoked')
    expect((await restarted.get()).destinationGrants?.[0].revokedAt).toBeDefined()
  })
})
