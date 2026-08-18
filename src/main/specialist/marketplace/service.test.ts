import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { sha256 } from './protocol'
import { MarketplaceRepository } from './repository'
import { MarketplaceService } from './service'

const encoder = new TextEncoder()

describe('MarketplaceService', () => {
  it('trusts a reviewed GitHub source and disables installed Skills for Main before commit', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'marketplace-service-'))
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const archive = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          schema_version: 1,
          id: 'example-specialist',
          version: '1.0.0',
          exported_with_app_version: '0.16.0'
        })
      ),
      'specialist.json': strToU8(
        JSON.stringify({
          name: 'EXAMPLE_SPECIALIST',
          description: 'Example',
          system_prompt: 'Use the selected Skill.',
          skill_ids: ['example-skill'],
          connector_ids: []
        })
      ),
      'skills/example-skill/SKILL.md': strToU8(
        '---\nname: example-skill\ndescription: Example\n---\nUse this Skill.'
      )
    })
    const release = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        specialist_id: 'example-specialist',
        version: '1.0.0',
        source: {
          repository: 'https://github.com/example/upstream',
          commit: 'c'.repeat(40),
          license: 'MIT'
        },
        artifact: {
          path: 'specialists/example-specialist/1.0.0/example.zip',
          github_release: { tag: 'example-v1.0.0', asset_name: 'example.zip' },
          sha256: sha256(archive),
          compressed_bytes: archive.byteLength,
          uncompressed_bytes: 1,
          file_count: 3
        },
        defaults: { skill_ids: ['example-skill'], connector_ids: ['example-connector'] },
        skills: [
          {
            id: 'example-skill',
            name: 'example-skill',
            display_name: 'Example Skill',
            description: 'Example workflows.',
            path: 'skills/example-skill',
            content_digest: 'd'.repeat(64),
            file_count: 1,
            uncompressed_bytes: 1
          }
        ],
        connectors: [{ id: 'example-connector', required: true, default_selected: true }]
      })
    )
    const root = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        revision: '1',
        marketplace: { id: 'example', name: 'Example Marketplace' },
        specialists: [
          {
            id: 'example-specialist',
            display_name: 'Example Specialist',
            summary: 'Example workflows.',
            publisher: { id: 'example', name: 'Example' },
            latest: {
              version: '1.0.0',
              release: {
                path: 'releases/example-specialist/1.0.0.json',
                sha256: sha256(release)
              }
            }
          }
        ]
      })
    )
    const signature = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        algorithm: 'ed25519',
        key_id: 'example-2026-01',
        public_key: publicKeyBase64,
        signature: sign(null, root, privateKey).toString('base64')
      })
    )
    const responses = new Map<string, Uint8Array>([
      ['https://raw.githubusercontent.com/example/marketplace/main/marketplace.json', root],
      [
        'https://raw.githubusercontent.com/example/marketplace/main/marketplace.json.sig',
        signature
      ],
      [
        'https://raw.githubusercontent.com/example/marketplace/main/releases/example-specialist/1.0.0.json',
        release
      ],
      [
        'https://github.com/example/marketplace/releases/download/example-v1.0.0/example.zip',
        archive
      ]
    ])
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const bytes = responses.get(String(input))
      return bytes
        ? new Response(Buffer.from(bytes), {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength) }
          })
        : new Response('missing', { status: 404 })
    })
    const order: string[] = []
    const disabled = new Set<string>()
    let installed = false
    let installedArchiveDigest: string | undefined
    const packages = {
      preview: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
        installedArchiveDigest = sha256(bytes)
        return {
          candidateToken: 'package-candidate',
          summary: {
            id: 'example-specialist',
            version: '1.0.0',
            skills: [{ id: 'example-skill' }],
            connectorIds: ['example-connector']
          },
          diagnostics: [],
          installable: true
        }
      }),
      candidateNewSkillIds: vi.fn().mockReturnValue(['personal-example-skill']),
      cancel: vi.fn(),
      dispose: vi.fn(),
      install: vi.fn().mockImplementation(async () => {
        order.push('install')
        installed = true
        return {
          status: 'installed' as const,
          specialist: {
            id: 'example-specialist',
            name: 'EXAMPLE_SPECIALIST',
            description: 'Example',
            systemPrompt: 'Use the selected Skill.',
            enabled: false,
            setupPending: true,
            capabilityMode: 'selected' as const,
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['personal-example-skill'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1
          }
        }
      })
    }
    const repository = new MarketplaceRepository(storage)
    const service = new MarketplaceService({
      repository,
      packages: packages as never,
      fetch: fetcher,
      token: () => 'source-candidate',
      now: () => new Date('2026-08-17T00:00:00.000Z'),
      getDisabledSkillIds: async () => [...disabled],
      getInstalledSpecialists: async () =>
        installed
          ? [
              {
                id: 'example-specialist',
                origin: 'imported' as const,
                archiveDigest: installedArchiveDigest
              }
            ]
          : [],
      setSkillsMainEnabled: async (ids, enabled) => {
        order.push(enabled ? 'enable-main' : 'disable-main')
        for (const id of ids) {
          if (enabled) disabled.delete(id)
          else disabled.add(id)
        }
      }
    })

    const inspected = await service.inspectGitHubSource({
      repositoryUrl: 'https://github.com/example/marketplace/tree/main'
    })
    await service.addSource({ candidateToken: inspected.candidateToken })
    const listed = await service.list()
    expect(listed.specialists.map((item) => item.id)).toEqual(['example-specialist'])

    packages.preview.mockResolvedValueOnce({
      candidateToken: 'mismatched-package-candidate',
      summary: { id: 'different-specialist', version: '9.9.9' },
      diagnostics: [],
      installable: true
    })
    await expect(
      service.prepareInstall(
        {
          sourceId: listed.sources[0].id,
          specialistId: 'example-specialist',
          version: '1.0.0',
          selectedSkillIds: ['example-skill'],
          selectedConnectorIds: ['example-connector']
        },
        17
      )
    ).rejects.toThrow('Downloaded package identity does not match')
    expect(packages.candidateNewSkillIds).not.toHaveBeenCalled()

    packages.preview.mockResolvedValueOnce({
      candidateToken: 'dropped-skill-package-candidate',
      summary: { id: 'example-specialist', version: '1.0.0', skills: [], connectorIds: [] },
      diagnostics: [
        {
          severity: 'warning',
          code: 'skill.name-mismatch',
          message: 'Skill name mismatch.',
          relatedId: 'example-skill'
        }
      ],
      installable: true
    })
    await expect(
      service.prepareInstall(
        {
          sourceId: listed.sources[0].id,
          specialistId: 'example-specialist',
          version: '1.0.0',
          selectedSkillIds: ['example-skill'],
          selectedConnectorIds: ['example-connector']
        },
        17
      )
    ).rejects.toThrow('did not retain every selected Marketplace capability')

    packages.preview.mockResolvedValueOnce({
      candidateToken: 'dropped-connector-package-candidate',
      summary: {
        id: 'example-specialist',
        version: '1.0.0',
        skills: [{ id: 'example-skill' }],
        connectorIds: []
      },
      diagnostics: [
        {
          severity: 'warning',
          code: 'skill.existing-conflict',
          message: 'Installed Skill content differs.',
          relatedId: 'example-skill'
        },
        {
          severity: 'warning',
          code: 'specialist.connector-unavailable',
          message: 'Connector unavailable.',
          relatedId: 'example-connector'
        }
      ],
      installable: false
    })
    await expect(
      service.prepareInstall(
        {
          sourceId: listed.sources[0].id,
          specialistId: 'example-specialist',
          version: '1.0.0',
          selectedSkillIds: ['example-skill'],
          selectedConnectorIds: ['example-connector']
        },
        17
      )
    ).rejects.toThrow('did not retain every selected Marketplace capability')
    expect(packages.candidateNewSkillIds).not.toHaveBeenCalled()

    const downloadProgress: Array<{ transferred: number; total: number; percent: number }> = []
    const preview = await service.prepareInstall(
      {
        sourceId: listed.sources[0].id,
        specialistId: 'example-specialist',
        version: '1.0.0',
        selectedSkillIds: ['example-skill'],
        selectedConnectorIds: ['example-connector']
      },
      17,
      (progress) => downloadProgress.push(progress)
    )
    const result = await service.install({ candidateToken: preview.package.candidateToken }, 17)

    expect(result).toMatchObject({ status: 'installed', provenanceLinked: true })
    expect(downloadProgress[0]).toMatchObject({
      transferred: 0,
      total: archive.byteLength,
      percent: 0
    })
    expect(downloadProgress.at(-1)).toMatchObject({
      transferred: archive.byteLength,
      total: archive.byteLength,
      percent: 100
    })
    expect(order).toEqual(['disable-main', 'install'])
    expect(disabled).toEqual(new Set(['personal-example-skill']))
    await expect(service.list()).resolves.toMatchObject({
      specialists: [{ id: 'example-specialist', installedVersion: '1.0.0' }]
    })

    const [provenance] = (await repository.getAll()).installations
    if (!provenance) throw new Error('Expected Marketplace provenance')
    const historicalProvenance = { ...provenance }
    delete historicalProvenance.installedArchiveDigest
    await repository.recordInstallation(historicalProvenance)
    expect((await service.list()).specialists[0]).not.toHaveProperty('installedVersion')

    packages.preview.mockResolvedValueOnce({
      candidateToken: 'invalid-package-candidate',
      diagnostics: [
        {
          severity: 'error',
          code: 'specialist.description-invalid',
          message: 'Description must be 1000 characters or fewer.',
          path: 'specialist.json'
        }
      ],
      installable: false
    })
    packages.candidateNewSkillIds.mockReturnValueOnce(undefined)
    await expect(
      service.prepareInstall(
        {
          sourceId: listed.sources[0].id,
          specialistId: 'example-specialist',
          version: '1.0.0',
          selectedSkillIds: ['example-skill'],
          selectedConnectorIds: ['example-connector']
        },
        17
      )
    ).resolves.toMatchObject({
      package: {
        candidateToken: 'invalid-package-candidate',
        installable: false,
        diagnostics: [{ code: 'specialist.description-invalid' }]
      }
    })
  })

  it('restores newly disabled Main Skills when the package transaction throws', async () => {
    const disabled = new Set<string>()
    const packages = {
      preview: vi.fn(),
      candidateNewSkillIds: vi.fn(),
      install: vi.fn().mockRejectedValue(new Error('install failed'))
    }
    const service = new MarketplaceService({
      repository: new MarketplaceRepository(await mkdtemp(join(tmpdir(), 'marketplace-rollback-'))),
      packages: packages as never,
      fetch: vi.fn<typeof fetch>(),
      getDisabledSkillIds: async () => [...disabled],
      getInstalledSpecialists: async () => [],
      setSkillsMainEnabled: async (ids, enabled) => {
        for (const id of ids) {
          if (enabled) disabled.delete(id)
          else disabled.add(id)
        }
      }
    })

    Reflect.set(
      service,
      'installCandidates',
      new Map([
        [
          'candidate',
          {
            expiresAt: Date.now() + 60_000,
            ownerId: 17,
            sourceId: 'source',
            packageCandidateToken: 'candidate',
            newSkillIds: ['personal-example-skill'],
            provenance: {}
          }
        ]
      ])
    )

    await expect(service.install({ candidateToken: 'candidate' }, 17)).rejects.toThrow(
      'install failed'
    )
    expect(disabled.size).toBe(0)
  })

  it('preserves Main settings when every selected Skill is already installed', async () => {
    const setSkillsMainEnabled = vi.fn()
    const packages = {
      preview: vi.fn(),
      candidateNewSkillIds: vi.fn(),
      install: vi.fn().mockResolvedValue({
        status: 'installed',
        specialist: { id: 'example-specialist' }
      })
    }
    const service = new MarketplaceService({
      repository: new MarketplaceRepository(await mkdtemp(join(tmpdir(), 'marketplace-reuse-'))),
      packages: packages as never,
      fetch: vi.fn<typeof fetch>(),
      getDisabledSkillIds: async () => [],
      getInstalledSpecialists: async () => [],
      setSkillsMainEnabled
    })
    Reflect.set(
      service,
      'installCandidates',
      new Map([
        [
          'candidate',
          {
            expiresAt: Date.now() + 60_000,
            ownerId: 17,
            sourceId: 'source',
            packageCandidateToken: 'candidate',
            newSkillIds: [],
            provenance: {}
          }
        ]
      ])
    )

    await expect(service.install({ candidateToken: 'candidate' }, 17)).resolves.toMatchObject({
      status: 'installed'
    })
    expect(setSkillsMainEnabled).not.toHaveBeenCalled()
  })

  it('binds install candidates to their renderer owner and releases expired candidates', async () => {
    let now = 1_000
    const packages = {
      preview: vi.fn(),
      candidateNewSkillIds: vi.fn(),
      install: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn()
    }
    const service = new MarketplaceService({
      repository: new MarketplaceRepository(await mkdtemp(join(tmpdir(), 'marketplace-owner-'))),
      packages: packages as never,
      fetch: vi.fn<typeof fetch>(),
      now: () => new Date(now),
      getDisabledSkillIds: async () => [],
      getInstalledSpecialists: async () => [],
      setSkillsMainEnabled: async () => undefined
    })
    const installCandidates = new Map([
      [
        'candidate',
        {
          expiresAt: 2_000,
          ownerId: 17,
          sourceId: 'source',
          packageCandidateToken: 'candidate',
          newSkillIds: [],
          provenance: {}
        }
      ]
    ])
    Reflect.set(service, 'installCandidates', installCandidates)

    await expect(service.install({ candidateToken: 'candidate' }, 18)).resolves.toEqual({
      status: 'failed',
      code: 'candidate-invalid'
    })
    expect(installCandidates.has('candidate')).toBe(true)

    now = 2_001
    await expect(service.install({ candidateToken: 'candidate' }, 17)).resolves.toEqual({
      status: 'failed',
      code: 'candidate-expired'
    })
    expect(installCandidates.has('candidate')).toBe(false)
    expect(packages.cancel).toHaveBeenCalledWith('candidate', 17)

    Reflect.set(
      service,
      'sourceCandidates',
      new Map([
        ['source-owner-17', { ownerId: 17 }],
        ['source-owner-18', { ownerId: 18 }]
      ])
    )
    service.dispose(17)
    expect([...Reflect.get(service, 'sourceCandidates').keys()]).toEqual(['source-owner-18'])
    expect(packages.dispose).toHaveBeenCalledWith(17)
  })

  it('does not follow Marketplace metadata redirects into another GitHub repository', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'marketplace-redirect-'))
    const repository = new MarketplaceRepository(storage)
    await repository.addSource({
      id: 'github-example',
      kind: 'github',
      repositoryUrl: 'https://github.com/example/marketplace',
      owner: 'example',
      repository: 'marketplace',
      ref: 'main',
      marketplaceId: 'example',
      name: 'Example',
      keyId: 'example-2026-01',
      publicKey: 'unused',
      keyFingerprint: 'unused',
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: 'https://raw.githubusercontent.com/attacker/marketplace/main/marketplace.json'
        }
      })
    )
    const service = new MarketplaceService({
      repository,
      packages: {} as never,
      fetch: fetcher,
      getDisabledSkillIds: async () => [],
      getInstalledSpecialists: async () => [],
      setSkillsMainEnabled: async () => undefined
    })

    const snapshot = await service.list()

    expect(snapshot.failures).toMatchObject([{ sourceId: 'github-example', code: 'schema' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to signature- and digest-verified root and release caches', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const release = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        specialist_id: 'cached-specialist',
        version: '1.0.0',
        source: {
          repository: 'https://github.com/example/upstream',
          commit: 'c'.repeat(40),
          license: 'MIT'
        },
        artifact: {
          path: 'specialists/cached-specialist/1.0.0/cached.zip',
          github_release: { tag: 'cached-v1.0.0', asset_name: 'cached.zip' },
          sha256: 'a'.repeat(64),
          compressed_bytes: 1,
          uncompressed_bytes: 1,
          file_count: 1
        },
        defaults: { skill_ids: [], connector_ids: [] },
        skills: [],
        connectors: []
      })
    )
    const root = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        revision: 'cached-1',
        marketplace: { id: 'cached', name: 'Cached Marketplace' },
        specialists: [
          {
            id: 'cached-specialist',
            display_name: 'Cached Specialist',
            summary: 'Cached workflows.',
            publisher: { id: 'example', name: 'Example' },
            latest: {
              version: '1.0.0',
              release: {
                path: 'releases/cached-specialist/1.0.0.json',
                sha256: sha256(release)
              }
            }
          }
        ]
      })
    )
    const signature = encoder.encode(
      JSON.stringify({
        schema_version: 1,
        algorithm: 'ed25519',
        key_id: 'cached-2026-01',
        public_key: publicKeyBase64,
        signature: sign(null, root, privateKey).toString('base64')
      })
    )
    const responses = new Map<string, Uint8Array>([
      ['https://raw.githubusercontent.com/example/cache/main/marketplace.json', root],
      ['https://raw.githubusercontent.com/example/cache/main/marketplace.json.sig', signature],
      [
        'https://raw.githubusercontent.com/example/cache/main/releases/cached-specialist/1.0.0.json',
        release
      ]
    ])
    let online = true
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (!online) throw new Error('offline')
      const bytes = responses.get(String(input))
      return bytes
        ? new Response(Buffer.from(bytes), {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength) }
          })
        : new Response('missing', { status: 404 })
    })
    const repository = new MarketplaceRepository(
      await mkdtemp(join(tmpdir(), 'marketplace-cache-'))
    )
    const service = new MarketplaceService({
      repository,
      packages: {} as never,
      fetch: fetcher,
      officialSource: {
        id: 'cached-official',
        name: 'Cached Marketplace',
        repositoryUrl: 'https://github.com/example/cache',
        ref: 'main',
        metadataBaseUrls: ['https://raw.githubusercontent.com/example/cache/main/'],
        artifactBaseUrls: [],
        trustedKeys: { 'cached-2026-01': publicKeyBase64 }
      },
      now: () => new Date('2026-08-18T00:00:00.000Z'),
      getDisabledSkillIds: async () => [],
      getInstalledSpecialists: async () => [],
      setSkillsMainEnabled: async () => undefined
    })

    await expect(
      service.getRelease({
        sourceId: 'cached-official',
        specialistId: 'cached-specialist',
        version: '1.0.0'
      })
    ).resolves.toMatchObject({ specialistId: 'cached-specialist' })

    online = false
    await expect(service.list()).resolves.toMatchObject({
      sources: [
        {
          id: 'cached-official',
          lastRefreshedAt: '2026-08-18T00:00:00.000Z',
          usingCachedMetadata: true
        }
      ],
      specialists: [{ id: 'cached-specialist' }],
      failures: []
    })
    await expect(
      service.getRelease({
        sourceId: 'cached-official',
        specialistId: 'cached-specialist',
        version: '1.0.0'
      })
    ).resolves.toMatchObject({ specialistId: 'cached-specialist' })

    await repository.cacheRoot(
      'cached-official',
      encoder.encode(new TextDecoder().decode(root).replace('cached-1', 'tampered')),
      signature,
      '2026-08-18T00:00:01.000Z'
    )
    await expect(service.list()).resolves.toMatchObject({
      specialists: [],
      failures: [{ sourceId: 'cached-official' }]
    })
  })
})
