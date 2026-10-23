import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import {
  normalizeNotebookNetworkSettings,
  parseCustomAllowedDomainInput
} from '../../shared/notebook-network'
import { SettingsRepository } from './repository'

describe('Notebook network settings', () => {
  it('round-trips normalized URL and wildcard rules through a fresh repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-science-domain-input-'))
    try {
      const allowedDomains = ['https://www.example.com:8443/path?q=1#part', '*.example.com'].map(
        (input) => {
          const result = parseCustomAllowedDomainInput(input)
          if (!result.ok) throw new Error('Expected valid domain input')
          return result.hostname
        }
      )
      await new SettingsRepository(dir).setNotebookNetwork({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        allowedDomains
      })
      const expected = ['*.example.com', 'www.example.com']
      const disk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
      expect(disk.notebookNetwork.allowedDomains).toEqual(expected)
      const restarted = new SettingsRepository(dir)
      expect((await restarted.getSettings()).notebookNetwork?.allowedDomains).toEqual(expected)
      await restarted.setNotebookNetwork({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        allowedDomains: ['www.example.com']
      })
      expect(
        (await new SettingsRepository(dir).getSettings()).notebookNetwork?.allowedDomains
      ).toEqual(['www.example.com'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
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
