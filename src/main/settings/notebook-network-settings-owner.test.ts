import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  type NotebookNetworkSettings
} from '../../shared/notebook-network'
import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { NotebookNetworkSettingsOwner } from './notebook-network-settings-owner'
import type { StoredSettings } from './types'

describe('NotebookNetworkSettingsOwner', () => {
  const harness = (
    initial: NotebookNetworkSettings = DEFAULT_NOTEBOOK_NETWORK_SETTINGS
  ): Readonly<{
    owner: NotebookNetworkSettingsOwner
    repository: {
      getSettings: ReturnType<typeof vi.fn>
      setNotebookNetwork: ReturnType<typeof vi.fn>
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
})
