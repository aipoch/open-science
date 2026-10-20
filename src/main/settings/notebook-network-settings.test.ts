import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { normalizeNotebookNetworkSettings } from '../../shared/notebook-network'
import { SettingsRepository } from './repository'

describe('Notebook network settings', () => {
  it('resolves historical settings to the default policy without rewriting the document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-science-notebook-network-'))
    const repository = new SettingsRepository(dir)

    const settings = await repository.getSettings()
    expect(settings.notebookNetwork).toBeUndefined()
    expect(normalizeNotebookNetworkSettings(settings.notebookNetwork)).toEqual(
      DEFAULT_NOTEBOOK_NETWORK_SETTINGS
    )
  })

  it('normalizes and persists one global policy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-science-notebook-network-'))
    const repository = new SettingsRepository(dir)

    await expect(
      repository.setNotebookNetwork({
        allowedDomains: ['DATA.Example.COM', 'data.example.com'],
        disabledOpenScienceDomainGroups: ['literature'],
        disabledOpenScienceDomains: ['rest.uniprot.org']
      })
    ).resolves.toMatchObject({
      notebookNetwork: {
        allowedDomains: ['data.example.com'],
        disabledOpenScienceDomainGroups: ['literature'],
        disabledOpenScienceDomains: ['rest.uniprot.org']
      }
    })

    await expect(repository.getSettings()).resolves.toMatchObject({
      notebookNetwork: {
        allowedDomains: ['data.example.com'],
        disabledOpenScienceDomainGroups: ['literature'],
        disabledOpenScienceDomains: ['rest.uniprot.org']
      }
    })
  })
})

it('round-trips private grants through a fresh settings repository and preserves revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-science-private-service-'))
  const rule = {
    hostname: 'lab.internal.example',
    port: 8443,
    approvedAddresses: ['10.32.0.7', 'fd12::7']
  }
  try {
    await new SettingsRepository(dir).setNotebookNetwork({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [rule]
    })
    const disk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(disk.notebookNetwork.trustedPrivateDestinations).toEqual([rule])
    const restarted = new SettingsRepository(dir)
    expect((await restarted.getSettings()).notebookNetwork?.trustedPrivateDestinations).toEqual([
      rule
    ])
    await restarted.setNotebookNetwork({
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: []
    })
    expect(
      (await new SettingsRepository(dir).getSettings()).notebookNetwork?.trustedPrivateDestinations
    ).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
