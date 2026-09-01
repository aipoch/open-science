import { mkdtemp } from 'node:fs/promises'
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
