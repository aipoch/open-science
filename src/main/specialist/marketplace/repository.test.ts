import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MarketplaceRepository } from './repository'

describe('MarketplaceRepository', () => {
  it('persists user trust separately from Specialist installation provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-repository-'))
    const repository = new MarketplaceRepository(root)
    await repository.addSource({
      id: 'github-example',
      kind: 'github',
      repositoryUrl: 'https://github.com/example/marketplace',
      owner: 'example',
      repository: 'marketplace',
      ref: 'main',
      marketplaceId: 'example',
      name: 'Example Marketplace',
      keyId: 'example-2026-01',
      publicKey: 'public-key',
      keyFingerprint: 'fingerprint',
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    await repository.recordInstallation({
      sourceId: 'github-example',
      specialistId: 'example-specialist',
      publisher: 'Example',
      version: '1.0.0',
      releasePath: 'releases/example-specialist/1.0.0.json',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      installedArchiveDigest: 'd'.repeat(64),
      upstreamCommit: 'c'.repeat(40),
      selectedSkillIds: ['example-skill'],
      selectedConnectorIds: [],
      installedAt: '2026-08-17T00:01:00.000Z'
    })
    await repository.removeSource('github-example')

    const document = await repository.getAll()
    expect(document.sources).toEqual([])
    expect(document.installations).toEqual([
      expect.objectContaining({
        specialistId: 'example-specialist',
        sourceId: 'github-example',
        installedArchiveDigest: 'd'.repeat(64)
      })
    ])
    expect(await readFile(join(root, 'specialist-marketplace.json'), 'utf8')).not.toContain(
      'password'
    )
  })

  it('persists replaceable verified metadata caches and removes them with a user source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-cache-'))
    const repository = new MarketplaceRepository(root)
    await repository.cacheRoot(
      'github-example',
      new TextEncoder().encode('root'),
      new TextEncoder().encode('signature'),
      '2026-08-18T00:00:00.000Z'
    )
    await repository.cacheRelease(
      'github-example',
      'releases/example/1.0.0.json',
      'a'.repeat(64),
      new TextEncoder().encode('release'),
      '2026-08-18T00:00:01.000Z'
    )

    const reloaded = new MarketplaceRepository(root)
    await expect(reloaded.getCachedRoot('github-example')).resolves.toMatchObject({
      rootBytes: new TextEncoder().encode('root'),
      signatureBytes: new TextEncoder().encode('signature'),
      cachedAt: '2026-08-18T00:00:00.000Z'
    })
    await expect(
      reloaded.getCachedRelease('github-example', 'releases/example/1.0.0.json', 'a'.repeat(64))
    ).resolves.toMatchObject({
      bytes: new TextEncoder().encode('release'),
      cachedAt: '2026-08-18T00:00:01.000Z'
    })

    await reloaded.removeSource('github-example')
    await expect(reloaded.getCachedRoot('github-example')).resolves.toBeUndefined()
    await expect(
      reloaded.getCachedRelease('github-example', 'releases/example/1.0.0.json', 'a'.repeat(64))
    ).resolves.toBeUndefined()
  })
})
