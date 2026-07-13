import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeConnectors, SettingsRepository } from './repository'
import type { StoredConnectors } from './types'

describe('sanitizeConnectors', () => {
  it('keeps arrays of strings and optional fields', () => {
    expect(
      sanitizeConnectors({
        enabledIds: ['chemistry', 1, 'pubmed'],
        autoAllowIds: ['chemistry'],
        contactEmail: 'a@b.org',
        ncbiApiKeyRef: 'ref1',
        blockedToolIds: ['chemistry/pubchem_get_properties'],
        disabledConnectorIds: ['zinc', 'zinc', 'rna']
      })
    ).toEqual({
      enabledIds: ['chemistry', 'pubmed'],
      autoAllowIds: ['chemistry'],
      contactEmail: 'a@b.org',
      ncbiApiKeyRef: 'ref1',
      blockedToolIds: ['chemistry/pubchem_get_properties'],
      disabledConnectorIds: ['zinc', 'rna']
    })
  })
  it('returns undefined for non-objects', () => {
    expect(sanitizeConnectors(null)).toBeUndefined()
  })
})

describe('SettingsRepository connector mutators', () => {
  const withRepo = async (fn: (repo: SettingsRepository) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'osci-connectors-'))
    try {
      await fn(new SettingsRepository(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const readConnectors = async (repo: SettingsRepository): Promise<StoredConnectors | undefined> =>
    (await repo.getSettings()).connectors

  it('adds and removes a disabled connector id (default-on)', async () => {
    await withRepo(async (repo) => {
      expect((await readConnectors(repo))?.disabledConnectorIds).toBeUndefined()
      await repo.setConnectorDisabled('zinc', true)
      expect((await readConnectors(repo))?.disabledConnectorIds).toEqual(['zinc'])
      await repo.setConnectorDisabled('zinc', false)
      expect((await readConnectors(repo))?.disabledConnectorIds).toBeUndefined()
    })
  })

  it('toggles connector auto-allow (skip approvals)', async () => {
    await withRepo(async (repo) => {
      await repo.setConnectorAutoAllow('biomart', true)
      expect((await readConnectors(repo))?.autoAllowIds).toEqual(['biomart'])
      await repo.setConnectorAutoAllow('biomart', false)
      expect((await readConnectors(repo))?.autoAllowIds).toEqual([])
    })
  })

  it('blocks and unblocks a tool id', async () => {
    await withRepo(async (repo) => {
      await repo.setToolBlocked('biomart/get_data', true)
      expect((await readConnectors(repo))?.blockedToolIds).toEqual(['biomart/get_data'])
      await repo.setToolBlocked('biomart/get_data', false)
      expect((await readConnectors(repo))?.blockedToolIds).toBeUndefined()
    })
  })

  it('sets and clears NCBI credentials', async () => {
    await withRepo(async (repo) => {
      await repo.setNcbiCredentials('me@lab.org', 'cipher-ref')
      let c = await readConnectors(repo)
      expect(c?.contactEmail).toBe('me@lab.org')
      expect(c?.ncbiApiKeyRef).toBe('cipher-ref')
      await repo.setNcbiCredentials(undefined, undefined)
      c = await readConnectors(repo)
      expect(c?.contactEmail).toBeUndefined()
      expect(c?.ncbiApiKeyRef).toBeUndefined()
    })
  })

  it('persists mutations to disk', async () => {
    await withRepo(async (repo) => {
      await repo.setConnectorDisabled('rna', true)
      const raw = await readFile(
        join((repo as unknown as { storageDir: string }).storageDir, 'settings.json'),
        'utf8'
      )
      expect(JSON.parse(raw).connectors.disabledConnectorIds).toEqual(['rna'])
    })
  })
})
