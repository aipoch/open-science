import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MarketplaceRepository,
  MAX_MARKETPLACE_RELEASE_CACHE_BYTES,
  MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES
} from './repository'

describe('MarketplaceRepository', () => {
  it('recovers a valid historical temp when the primary is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-repository-temp-'))
    await writeFile(
      join(root, 'specialist-marketplace.json.1700000000000-1.tmp'),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: 'recovered-source',
            kind: 'github',
            repositoryUrl: 'https://github.com/example/marketplace',
            owner: 'example',
            repository: 'marketplace',
            ref: 'main',
            marketplaceId: 'example',
            name: 'Recovered Marketplace',
            keyId: 'example-2026-01',
            publicKey: Buffer.from('public-key').toString('base64'),
            keyFingerprint: 'f'.repeat(64),
            createdAt: '2026-08-17T00:00:00.000Z'
          }
        ]
      }),
      'utf8'
    )

    await expect(new MarketplaceRepository(root).getAll()).resolves.toMatchObject({
      sources: [{ id: 'recovered-source' }]
    })
    await expect(readdir(root)).resolves.toEqual(['specialist-marketplace.json'])
  })

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
      publicKey: Buffer.from('public-key').toString('base64'),
      keyFingerprint: 'f'.repeat(64),
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

  it('removes completed and pending provenance when a Specialist is uninstalled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-uninstall-'))
    const repository = new MarketplaceRepository(root)
    const installation = {
      sourceId: 'official',
      specialistId: 'managed-specialist',
      publisher: 'Open Science',
      version: '1.0.0',
      releasePath: 'releases/managed-specialist/1.0.0.json',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      installedArchiveDigest: 'c'.repeat(64),
      upstreamCommit: 'd'.repeat(40),
      selectedSkillIds: [],
      selectedConnectorIds: [],
      installedAt: '2026-08-23T00:00:00.000Z'
    }
    await repository.recordInstallation(installation)
    await repository.beginInstallation({
      provenance: { ...installation, sourceId: 'secondary' },
      newlyDisabledSkillIds: []
    })

    await repository.removeInstallationsForSpecialist('managed-specialist')

    await expect(repository.getAll()).resolves.toMatchObject({
      installations: [],
      pendingInstallations: []
    })
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

  it('replaces the same release path without accumulating extra cache entries', async () => {
    const repository = new MarketplaceRepository(
      await mkdtemp(join(tmpdir(), 'marketplace-release-replace-'))
    )
    for (let index = 0; index < 20; index += 1) {
      await repository.cacheRelease(
        'github-example',
        'releases/example/1.0.0.json',
        index.toString(16).padStart(64, '0'),
        new TextEncoder().encode(`release-${index}`),
        `2026-08-18T00:00:${String(index).padStart(2, '0')}.000Z`
      )
    }

    const document = await repository.getAll()
    expect(document.releaseCaches).toHaveLength(1)
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/1.0.0.json',
        (19).toString(16).padStart(64, '0')
      )
    ).resolves.toMatchObject({
      bytes: new TextEncoder().encode('release-19'),
      cachedAt: '2026-08-18T00:00:19.000Z'
    })
  })

  it('does not keep an unbounded working set of distinct release paths', async () => {
    const repository = new MarketplaceRepository(
      await mkdtemp(join(tmpdir(), 'marketplace-release-count-'))
    )
    const cachedCount = 20
    for (let index = 0; index < cachedCount; index += 1) {
      await repository.cacheRelease(
        'github-example',
        `releases/example/${index}.json`,
        index.toString(16).padStart(64, '0'),
        new TextEncoder().encode(`release-${index}`),
        `2026-08-18T00:00:${String(index).padStart(2, '0')}.000Z`
      )
    }

    const document = await repository.getAll()
    expect(document.releaseCaches.length).toBeLessThan(cachedCount)
    expect(document.releaseCaches.length).toBeLessThanOrEqual(MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES)
    expect(document.releaseCaches.map((item) => item.path)).toEqual(
      Array.from(
        { length: MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES },
        (_, index) =>
          `releases/example/${index + cachedCount - MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES}.json`
      )
    )
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/0.json',
        (0).toString(16).padStart(64, '0')
      )
    ).resolves.toBeUndefined()
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/19.json',
        (19).toString(16).padStart(64, '0')
      )
    ).resolves.toMatchObject({
      bytes: new TextEncoder().encode('release-19'),
      cachedAt: '2026-08-18T00:00:19.000Z'
    })
  })

  it('evicts older distinct release caches once decoded payloads exceed the byte budget', async () => {
    const repository = new MarketplaceRepository(
      await mkdtemp(join(tmpdir(), 'marketplace-release-bytes-'))
    )
    const payload = Buffer.alloc(Math.floor(MAX_MARKETPLACE_RELEASE_CACHE_BYTES * 0.5), 0x61)
    for (let index = 0; index < 3; index += 1) {
      await repository.cacheRelease(
        'github-example',
        `releases/example/${index}.json`,
        index.toString(16).padStart(64, '0'),
        payload,
        `2026-08-18T00:00:0${index}.000Z`
      )
    }

    const document = await repository.getAll()
    expect(document.releaseCaches.length).toBeLessThan(3)
    expect(document.releaseCaches.map((item) => item.path)).toEqual([
      'releases/example/1.json',
      'releases/example/2.json'
    ])
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/0.json',
        (0).toString(16).padStart(64, '0')
      )
    ).resolves.toBeUndefined()
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/2.json',
        (2).toString(16).padStart(64, '0')
      )
    ).resolves.toMatchObject({
      cachedAt: '2026-08-18T00:00:02.000Z'
    })
  })

  it('keeps the newest release cache even when that payload alone exceeds the byte budget', async () => {
    const repository = new MarketplaceRepository(
      await mkdtemp(join(tmpdir(), 'marketplace-release-oversize-'))
    )
    const oversized = Buffer.alloc(MAX_MARKETPLACE_RELEASE_CACHE_BYTES + 1024, 0x61)
    await repository.cacheRelease(
      'github-example',
      'releases/example/0.json',
      (0).toString(16).padStart(64, '0'),
      new TextEncoder().encode('older-release'),
      '2026-08-18T00:00:00.000Z'
    )
    await repository.cacheRelease(
      'github-example',
      'releases/example/1.json',
      (1).toString(16).padStart(64, '0'),
      oversized,
      '2026-08-18T00:00:01.000Z'
    )

    const document = await repository.getAll()
    expect(document.releaseCaches).toHaveLength(1)
    expect(document.releaseCaches[0]?.path).toBe('releases/example/1.json')
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/0.json',
        (0).toString(16).padStart(64, '0')
      )
    ).resolves.toBeUndefined()
    await expect(
      repository.getCachedRelease(
        'github-example',
        'releases/example/1.json',
        (1).toString(16).padStart(64, '0')
      )
    ).resolves.toMatchObject({
      cachedAt: '2026-08-18T00:00:01.000Z'
    })
  })

  it('trims a historical document that already stored too many release caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-release-historical-'))
    await writeFile(
      join(root, 'specialist-marketplace.json'),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: 'github-example',
            kind: 'github',
            repositoryUrl: 'https://github.com/example/marketplace',
            owner: 'example',
            repository: 'marketplace',
            ref: 'main',
            marketplaceId: 'example',
            name: 'Example Marketplace',
            keyId: 'example-2026-01',
            publicKey: Buffer.from('public-key').toString('base64'),
            keyFingerprint: 'f'.repeat(64),
            createdAt: '2026-08-18T00:00:00.000Z'
          }
        ],
        releaseCaches: Array.from({ length: 20 }, (_, index) => ({
          sourceId: 'github-example',
          path: `releases/example/${index}.json`,
          digest: index.toString(16).padStart(64, '0'),
          bytesBase64: Buffer.from(`release-${index}`).toString('base64'),
          cachedAt: `2026-08-18T00:00:${String(index).padStart(2, '0')}.000Z`
        }))
      }),
      'utf8'
    )

    const document = await new MarketplaceRepository(root).getAll()
    expect(document.sources).toEqual([expect.objectContaining({ id: 'github-example' })])
    expect(document.releaseCaches.length).toBeLessThan(20)
    expect(document.releaseCaches.length).toBeLessThanOrEqual(MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES)
    expect(document.releaseCaches.map((item) => item.path)).toEqual(
      Array.from(
        { length: MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES },
        (_, index) => `releases/example/${index + 20 - MAX_MARKETPLACE_RELEASE_CACHE_ENTRIES}.json`
      )
    )
  })

  it('reconstructs persisted records from known, validated fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marketplace-sanitize-'))
    await writeFile(
      join(root, 'specialist-marketplace.json'),
      JSON.stringify({
        version: 1,
        sources: [
          {
            id: 'github-example',
            kind: 'github',
            repositoryUrl: 'https://github.com/example/marketplace',
            owner: 'example',
            repository: 'marketplace',
            ref: 'main',
            marketplaceId: 'example',
            name: 'Example Marketplace',
            keyId: 'example-2026-01',
            publicKey: Buffer.from('public-key').toString('base64'),
            keyFingerprint: 'f'.repeat(64),
            createdAt: '2026-08-18T00:00:00.000Z',
            injected: 'discard-me'
          },
          {
            id: 'invalid-source',
            kind: 'github',
            repositoryUrl: 'https://github.com/example/invalid',
            owner: 'example',
            repository: 'invalid',
            ref: 'main',
            marketplaceId: 'invalid',
            name: 'Invalid Marketplace',
            keyId: 'invalid-2026-01',
            publicKey: 'not base64',
            keyFingerprint: 'not-a-digest',
            createdAt: 'not-a-date'
          }
        ],
        installations: [
          {
            sourceId: 'official',
            specialistId: 'example-specialist',
            publisher: 'Example',
            version: '1.0.0',
            releasePath: 'releases/example-specialist/1.0.0.json',
            releaseDigest: 'a'.repeat(64),
            artifactDigest: 'b'.repeat(64),
            installedArchiveDigest: 'c'.repeat(64),
            upstreamCommit: 'd'.repeat(40),
            selectedSkillIds: ['example-skill'],
            selectedConnectorIds: [],
            installedAt: '2026-08-18T00:00:00.000Z',
            injected: 'discard-me'
          },
          {
            sourceId: 'invalid',
            specialistId: 'invalid',
            publisher: 'Invalid',
            version: '1.0.0',
            releasePath: 'invalid.json',
            releaseDigest: 'not-a-digest',
            artifactDigest: 'b'.repeat(64),
            upstreamCommit: 'd'.repeat(40),
            selectedSkillIds: [],
            selectedConnectorIds: [],
            installedAt: 'not-a-date'
          }
        ],
        rootCaches: [
          {
            sourceId: 'official',
            rootBase64: Buffer.from('root').toString('base64'),
            signatureBase64: Buffer.from('signature').toString('base64'),
            cachedAt: '2026-08-18T00:00:01.000Z',
            injected: 'discard-me'
          },
          {
            sourceId: 'invalid',
            rootBase64: 'not base64',
            signatureBase64: Buffer.from('signature').toString('base64'),
            cachedAt: '2026-08-18T00:00:01.000Z'
          }
        ],
        releaseCaches: [
          {
            sourceId: 'official',
            path: 'releases/example-specialist/1.0.0.json',
            digest: 'a'.repeat(64),
            bytesBase64: Buffer.from('release').toString('base64'),
            cachedAt: '2026-08-18T00:00:02.000Z',
            injected: 'discard-me'
          },
          {
            sourceId: 'invalid',
            path: 'invalid.json',
            digest: 'not-a-digest',
            bytesBase64: Buffer.from('release').toString('base64'),
            cachedAt: '2026-08-18T00:00:02.000Z'
          }
        ],
        pendingInstallations: [
          {
            provenance: {
              sourceId: 'official',
              specialistId: 'missing-exact-digest',
              publisher: 'Example',
              version: '1.0.0',
              releasePath: 'releases/missing-exact-digest/1.0.0.json',
              releaseDigest: 'a'.repeat(64),
              artifactDigest: 'b'.repeat(64),
              upstreamCommit: 'd'.repeat(40),
              selectedSkillIds: [],
              selectedConnectorIds: [],
              installedAt: '2026-08-18T00:00:00.000Z'
            },
            newlyDisabledSkillIds: ['missing-exact-digest-skill']
          }
        ]
      }),
      'utf8'
    )

    const document = await new MarketplaceRepository(root).getAll()

    expect(document.sources).toEqual([
      {
        id: 'github-example',
        kind: 'github',
        repositoryUrl: 'https://github.com/example/marketplace',
        owner: 'example',
        repository: 'marketplace',
        ref: 'main',
        marketplaceId: 'example',
        name: 'Example Marketplace',
        keyId: 'example-2026-01',
        publicKey: Buffer.from('public-key').toString('base64'),
        keyFingerprint: 'f'.repeat(64),
        createdAt: '2026-08-18T00:00:00.000Z'
      }
    ])
    expect(document.installations).toEqual([
      {
        sourceId: 'official',
        specialistId: 'example-specialist',
        publisher: 'Example',
        version: '1.0.0',
        releasePath: 'releases/example-specialist/1.0.0.json',
        releaseDigest: 'a'.repeat(64),
        artifactDigest: 'b'.repeat(64),
        installedArchiveDigest: 'c'.repeat(64),
        upstreamCommit: 'd'.repeat(40),
        selectedSkillIds: ['example-skill'],
        selectedConnectorIds: [],
        installedAt: '2026-08-18T00:00:00.000Z'
      }
    ])
    expect(document.rootCaches).toEqual([
      {
        sourceId: 'official',
        rootBase64: Buffer.from('root').toString('base64'),
        signatureBase64: Buffer.from('signature').toString('base64'),
        cachedAt: '2026-08-18T00:00:01.000Z'
      }
    ])
    expect(document.releaseCaches).toEqual([
      {
        sourceId: 'official',
        path: 'releases/example-specialist/1.0.0.json',
        digest: 'a'.repeat(64),
        bytesBase64: Buffer.from('release').toString('base64'),
        cachedAt: '2026-08-18T00:00:02.000Z'
      }
    ])
    expect(document.pendingInstallations).toEqual([])
  })

  it('atomically moves a pending installation into provenance', async () => {
    const repository = new MarketplaceRepository(
      await mkdtemp(join(tmpdir(), 'marketplace-pending-'))
    )
    const provenance = {
      sourceId: 'official',
      specialistId: 'example-specialist',
      publisher: 'Example',
      version: '1.0.0',
      releasePath: 'releases/example-specialist/1.0.0.json',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      installedArchiveDigest: 'c'.repeat(64),
      upstreamCommit: 'd'.repeat(40),
      selectedSkillIds: ['example-skill'],
      selectedConnectorIds: [],
      installedAt: '2026-08-18T00:00:00.000Z'
    }

    await repository.beginInstallation({
      provenance,
      newlyDisabledSkillIds: ['personal-example-skill']
    })
    expect((await repository.getAll()).pendingInstallations).toEqual([
      { provenance, newlyDisabledSkillIds: ['personal-example-skill'] }
    ])

    await repository.completeInstallation(provenance)
    await expect(repository.getAll()).resolves.toMatchObject({
      pendingInstallations: [],
      installations: [provenance]
    })
  })
})
