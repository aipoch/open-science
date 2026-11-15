import { migrateNotebookNetworkSettings } from '../../shared/notebook-network-strict'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS as LEGACY_DEFAULTS,
  type NotebookNetworkSettings
} from '../../shared/notebook-network'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { NotebookNetworkSettingsOwner } from './notebook-network-settings-owner'
import type { StoredSettings } from './types'

const DEFAULT_NOTEBOOK_NETWORK_SETTINGS = migrateNotebookNetworkSettings(LEGACY_DEFAULTS)

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))
beforeEach(() => {
  lookup.mockResolvedValue([{ address: '10.32.0.7', family: 4 }])
})

const createHarness = (
  initial: NotebookNetworkSettings = DEFAULT_NOTEBOOK_NETWORK_SETTINGS
): Readonly<{
  owner: NotebookNetworkSettingsOwner
  repository: {
    getSettings: ReturnType<typeof vi.fn<() => Promise<StoredSettings>>>
    setNotebookNetwork: ReturnType<
      typeof vi.fn<(next: NotebookNetworkSettings) => Promise<StoredSettings>>
    >
  }
  read: () => NotebookNetworkSettings
}> => {
  let stored = initial
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
  return {
    owner: new NotebookNetworkSettingsOwner({ repository, apply: async () => {} }),
    repository,
    read: () => stored
  }
}

describe('NotebookNetworkSettingsOwner', () => {
  const harness = (
    initial: NotebookNetworkSettings = DEFAULT_NOTEBOOK_NETWORK_SETTINGS
  ): Readonly<{
    owner: NotebookNetworkSettingsOwner
    repository: {
      getSettings: ReturnType<typeof vi.fn<() => Promise<StoredSettings>>>
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
    protocol: 'http' as const,
    port: 8443,
    approvedAddresses: ['10.32.0.7']
  }
  it('reviews shape without revalidating DNS addresses before saving', async () => {
    const state = harness()
    await expect(state.owner.review(privateRule)).resolves.toEqual({
      ok: true,
      destination: { ...privateRule, approvedAddresses: [] }
    })
    lookup.mockResolvedValue([{ address: '10.32.0.8', family: 4 }])
    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [privateRule],
      baseTrustedPrivateDestinations: []
    })
    expect(state.read().trustedPrivateDestinations).toEqual([privateRule])
  })
  it('preserves independent private trust when an old editor makes no changes', async () => {
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
    ).resolves.toMatchObject({ trustedPrivateDestinations: [privateRule] })
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
    ).rejects.toThrow('Network rules changed')
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
    const state = createHarness()
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
  it('persists an exact project grant without rechecking DNS addresses', async () => {
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
      protocol: 'http' as const,
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
    await expect(owner.allowDestination({ ...grant, id: 'second' })).resolves.toBeDefined()
    await owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [{ ...grant, id: 'forged' }]
    })
    expect((await owner.get()).destinationGrants).toEqual([grant, { ...grant, id: 'second' }])
    await owner.set({ ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, revokeNetworkGrantIds: ['grant'] })
    expect((await owner.get()).destinationGrants).toEqual([
      expect.objectContaining({ id: 'grant', revokedAt: expect.any(Number) }),
      { ...grant, id: 'second' }
    ])
    const restarted = new NotebookNetworkSettingsOwner({ repository, apply: async () => {} })
    await expect(restarted.allowDestination(grant)).rejects.toThrow('revoked')
    expect((await restarted.get()).destinationGrants?.[0].revokedAt).toBeDefined()
  })

  it('keeps project grants out of trusted private services', async () => {
    const state = createHarness()
    const grant = {
      id: 'project-grant',
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'project' as const,
      createdAt: 1
    }

    await state.owner.allowDestination(grant)

    expect(state.read().destinationGrants).toEqual([grant])
    expect(state.read().trustedPrivateDestinations).toBeUndefined()
  })

  it('keeps a global destination grant separate from manual trusted services', async () => {
    const state = createHarness()
    const grant = {
      id: 'global-grant',
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'global' as const,
      createdAt: 1
    }

    await state.owner.allowDestination(grant)

    expect(state.read().destinationGrants).toEqual([grant])
    expect(state.read().trustedPrivateDestinations).toBeUndefined()
  })

  it('keeps public global grants in destination grants without projecting a private rule', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const state = createHarness()
    const grant = {
      id: 'public-global-grant',
      hostname: 'public.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['93.184.216.34'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'global' as const,
      createdAt: 1
    }

    await state.owner.allowDestination(grant)

    expect(state.read().destinationGrants).toEqual([grant])
    expect(state.read().trustedPrivateDestinations).toBeUndefined()
  })

  it('revokes only the managed rule and preserves a manual rule for the same target', async () => {
    const manual = {
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.8']
    }
    const global = {
      id: 'global-grant',
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'global' as const,
      createdAt: 1
    }
    const state = createHarness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [global],
      trustedPrivateDestinations: [
        manual,
        {
          ...manual,
          approvedAddresses: global.approvedAddresses,
          managedGrantId: global.id,
          source: 'global-destination-grant'
        }
      ]
    })

    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      revokeNetworkGrantIds: [global.id]
    })

    expect(state.read().destinationGrants).toEqual([
      expect.objectContaining({ id: global.id, revokedAt: expect.any(Number) })
    ])
    expect(state.read().trustedPrivateDestinations).toEqual([manual])
  })

  it('revokes a global grant when its managed private rule is removed', async () => {
    const global = {
      id: 'global-grant',
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'global' as const,
      createdAt: 1
    }
    const managed = {
      hostname: global.hostname,
      protocol: global.protocol,
      port: global.port,
      approvedAddresses: global.approvedAddresses,
      managedGrantId: global.id,
      source: 'global-destination-grant' as const
    }
    const state = createHarness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [global],
      trustedPrivateDestinations: [managed]
    })

    await state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [global],
      trustedPrivateDestinations: [],
      baseTrustedPrivateDestinations: [managed]
    })

    expect(state.read().trustedPrivateDestinations).toEqual([])
    expect(state.read().destinationGrants).toEqual([
      expect.objectContaining({ id: global.id, revokedAt: expect.any(Number) })
    ])
  })

  it('does not materialize a missing managed rule from an active global grant after restart', async () => {
    const global = {
      id: 'global-grant',
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'global' as const,
      createdAt: 1
    }
    const state = createHarness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [global]
    })

    await expect(state.owner.get()).resolves.toMatchObject({ destinationGrants: [global] })
    expect(state.repository.setNotebookNetwork).not.toHaveBeenCalled()
  })

  it('serializes restart repair ahead of a concurrent global revocation', async () => {
    const global = {
      id: 'global-grant',
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      projectId: 'project',
      sessionId: 'session',
      recordId: 'record',
      scope: 'global' as const,
      createdAt: 1
    }
    const state = createHarness({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      destinationGrants: [global]
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const persist = state.repository.setNotebookNetwork.getMockImplementation()!
    state.repository.setNotebookNetwork.mockImplementationOnce(async (next) => {
      const stored = await persist(next)
      await gate
      return stored
    })

    const repaired = state.owner.get()
    const revoked = state.owner.set({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      revokeNetworkGrantIds: [global.id]
    })
    release()
    await repaired
    await revoked

    expect(state.read().destinationGrants).toEqual([
      expect.objectContaining({ id: global.id, revokedAt: expect.any(Number) })
    ])
    expect(state.read().trustedPrivateDestinations).toBeUndefined()
  })

  it('rejects renderer attempts to add a backend-managed rule', async () => {
    const state = createHarness()
    const managed = {
      hostname: 'private.example',
      protocol: 'http' as const,
      port: 443,
      approvedAddresses: ['10.32.0.7'],
      managedGrantId: 'forged-grant',
      source: 'global-destination-grant' as const
    }

    await expect(
      state.owner.set({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        trustedPrivateDestinations: [managed],
        baseTrustedPrivateDestinations: []
      })
    ).rejects.toThrow('controlled by network approvals')
  })
})

it('merges independent strict edits and rejects concurrent edits of the same rule', async () => {
  const { owner } = createHarness()
  const base = await owner.get()
  const rules = base.strictWhitelist!
  const one = rules[0]!,
    two = rules[1]!
  await owner.set({
    ...base,
    baseStrictWhitelist: rules,
    strictWhitelist: rules.map((r) => (r.id === one.id ? { ...r, port: 8443 } : r))
  })
  const merged = await owner.set({
    ...base,
    baseStrictWhitelist: rules,
    strictWhitelist: rules.map((r) => (r.id === two.id ? { ...r, port: 9443 } : r))
  })
  expect(merged.strictWhitelist?.find((r) => r.id === one.id)?.port).toBe(8443)
  expect(merged.strictWhitelist?.find((r) => r.id === two.id)?.port).toBe(9443)
  await expect(
    owner.set({
      ...base,
      baseStrictWhitelist: rules,
      strictWhitelist: rules.filter((r) => r.id !== one.id)
    })
  ).rejects.toThrow('changed')
})
it('does not allow conversation domain grants in strict mode', async () => {
  const { owner } = createHarness({
    ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    mode: 'strict',
    strictWhitelist: []
  })
  await expect(owner.allowDomain('example.org')).rejects.toThrow('strict')
})
it('merges independent manual trust edits by stable ID and rejects a stale edit', async () => {
  const a = {
    id: 'a',
    hostname: 'localhost',
    protocol: 'http' as const,
    port: 80,
    approvedAddresses: []
  }
  const b = { ...a, id: 'b', port: 81 }
  const { owner } = createHarness({
    ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    trustedPrivateDestinations: [a, b]
  })
  const base = await owner.get()
  await owner.set({
    ...base,
    baseTrustedPrivateDestinations: [a, b],
    trustedPrivateDestinations: [b, { ...a, port: 82 }]
  })
  const merged = await owner.set({
    ...base,
    baseTrustedPrivateDestinations: [a, b],
    trustedPrivateDestinations: [a, { ...b, port: 83 }]
  })
  expect(merged.trustedPrivateDestinations?.map((row) => row.port)).toEqual([82, 83])
  await expect(
    owner.set({
      ...base,
      baseTrustedPrivateDestinations: [a, b],
      trustedPrivateDestinations: [b, { ...a, port: 84 }]
    })
  ).rejects.toThrow('changed')
})
it('persists one migration and keeps an emptied whitelist across owner restarts', async () => {
  const { owner, repository } = createHarness(LEGACY_DEFAULTS)
  const first = await owner.get()
  expect(first.strictWhitelistVersion).toBe(1)
  expect(repository.setNotebookNetwork).toHaveBeenCalledOnce()
  await owner.set({ ...first, baseStrictWhitelist: first.strictWhitelist, strictWhitelist: [] })
  const restarted = new NotebookNetworkSettingsOwner({ repository, apply: async () => {} })
  expect((await restarted.get()).strictWhitelist).toEqual([])
  expect(repository.setNotebookNetwork).toHaveBeenCalledTimes(2)
})
it.each(['edit', 'delete'] as const)(
  'accepts the first %s from a legacy trusted-address snapshot before migration',
  async (action) => {
    const rule = {
      hostname: 'localhost',
      port: 80,
      protocol: 'http' as const,
      approvedAddresses: []
    }
    const initial = { ...LEGACY_DEFAULTS, trustedPrivateDestinations: [rule] }
    const { owner } = createHarness(initial)
    const result = await owner.set({
      ...initial,
      baseTrustedPrivateDestinations: [rule],
      trustedPrivateDestinations:
        action === 'delete' ? [] : [{ ...rule, id: 'manual:http://localhost:80', port: 81 }]
    })
    expect(result.trustedPrivateDestinations).toHaveLength(action === 'delete' ? 0 : 1)
    if (action === 'edit') expect(result.trustedPrivateDestinations?.[0]?.port).toBe(81)
  }
)
it('merges rule edits across an independent mode change without reverting the mode', async () => {
  const { owner } = createHarness()
  const base = await owner.get()
  await owner.set({ ...base, mode: 'strict', baseMode: 'relaxed' })
  const next = await owner.set({
    ...base,
    baseMode: 'relaxed',
    baseStrictWhitelist: base.strictWhitelist,
    strictWhitelist: []
  })
  expect(next.mode).toBe('strict')
  expect(next.strictWhitelist).toEqual([])
})
