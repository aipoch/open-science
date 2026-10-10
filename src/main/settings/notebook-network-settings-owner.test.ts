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
      getSettings: ReturnType<typeof vi.fn<() => Promise<StoredSettings>>>
      setNotebookNetwork: ReturnType<
        typeof vi.fn<(settings: NotebookNetworkSettings) => Promise<StoredSettings>>
      >
    }
    apply: ReturnType<
      typeof vi.fn<
        (settings: NotebookNetworkSettings, previous: NotebookNetworkSettings) => Promise<void>
      >
    >
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
    const apply = vi
      .fn<(settings: NotebookNetworkSettings, previous: NotebookNetworkSettings) => Promise<void>>()
      .mockResolvedValue(undefined)
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
      expect.objectContaining(DEFAULT_NOTEBOOK_NETWORK_SETTINGS),
      expect.objectContaining({ allowedDomains: ['data.example.org'] })
    )
  })

  it('preserves an explicit standard selection across stale domain-only edits', async () => {
    const { owner, read } = harness()
    await owner.setWindowsProtectionEnabled(false)
    await owner.set({ ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, allowedDomains: ['example.org'] })
    expect(read()).toMatchObject({
      windowsProtectionEnabled: false,
      allowedDomains: ['example.org']
    })
  })

  it('stops active execution before persisting a mode change and does not write when stopping fails', async () => {
    const { repository, apply, read } = harness()
    const beforeProtectionChange = vi.fn(async () => {
      expect(read().windowsProtectionEnabled).toBeUndefined()
      throw new Error('process is still running')
    })
    const owner = new NotebookNetworkSettingsOwner({ repository, apply, beforeProtectionChange })
    await expect(owner.setWindowsProtectionEnabled(false)).rejects.toThrow(
      'process is still running'
    )
    expect(repository.setNotebookNetwork).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
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
      expect.objectContaining({ trustedPrivateDestinations: [] }),
      expect.any(Object)
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
    expect(state.apply).toHaveBeenLastCalledWith(
      DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      expect.any(Object)
    )
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
    expect(state.apply).toHaveBeenLastCalledWith(removed, expect.any(Object))
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
