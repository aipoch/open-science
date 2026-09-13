import { readFileSync } from 'node:fs'
import { verify } from 'node:crypto'
import { zipSync } from 'fflate'
import { marketplaceContentDigest } from './marketplace-package'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplaceService } from './marketplace-service'
import { OFFICIAL_SKILL_MARKETPLACE_SOURCE as source } from './marketplace-source'
import {
  sha256,
  verifyMarketplaceDetail,
  verifyMarketplaceIndex,
  verifyMarketplaceRoot,
  type MarketplaceRoot
} from './marketplace-protocol'

vi.mock('electron', () => ({ net: undefined }))
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>()
  return { ...actual, verify: vi.fn(actual.verify) }
})
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./__fixtures__/marketplace/${name}`, import.meta.url))
const rootBytes = fixture('marketplace.json')
const signature = fixture('marketplace.json.sig')
const index = fixture('release-index.json')
const descriptor = fixture('abstract-trimmer.json')
const commit = '1fcb52be4743e42e54f89709720f7a41df11c36c'
const root = verifyMarketplaceRoot(rootBytes, signature)
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const assetUrl = (path: string, revision = root.revision): string =>
  `https://github.com/${source.repository}/releases/download/catalog-${revision}/${sha256(Buffer.from(path))}${path.endsWith('.zip') ? '.zip' : '.json'}`

function transport(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url) => {
    const value = String(url)
    if (value.endsWith('/git/ref/heads/published'))
      return new Response(JSON.stringify({ object: { sha: commit, type: 'commit' } }))
    if (value === assetUrl(root.release_index.path)) return new Response(index.toString())
    if (value === assetUrl(root.skills[0].release.path)) return new Response(descriptor.toString())
    expect(value.startsWith(source.cdnBaseUrl) || value.includes(`/${commit}/`)).toBe(true)
    if (value.endsWith('/marketplace.json')) return new Response(rootBytes.toString())
    if (value.endsWith('/marketplace.json.sig')) return new Response(signature.toString())
    if (value.endsWith(root.release_index.path)) return new Response(index.toString())
    if (value.endsWith(root.skills[0].release.path)) return new Response(descriptor.toString())
    throw new Error(`Unexpected metadata request: ${value}`)
  })
}
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('verified Skill Marketplace browsing', () => {
  it('cancels an in-flight download without starting an archive or mirror request', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockClear()
    const cancellation = new AbortController()
    let requestSignal: AbortSignal | undefined
    fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          requestSignal = options?.signal ?? undefined
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true
          })
        })
    )
    const result = service.download(
      { snapshotId: root.revision, id: root.skills[0].id },
      cancellation.signal
    )
    expect(requestSignal?.aborted).toBe(false)
    cancellation.abort()
    expect(await result).toEqual({ ok: false, error: 'network' })
    expect(requestSignal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps valid prerelease metadata browseable but rejects downloads before fetching release objects', async () => {
    const changedRoot = structuredClone(root)
    changedRoot.skills[0].version = '1.0.0-beta.1'
    const listing = changedRoot.skills[0]
    const prereleaseDescriptor = JSON.parse(descriptor.toString())
    prereleaseDescriptor.skill.version = listing.version
    const descriptorBytes = json(prereleaseDescriptor)
    listing.release = {
      path: `releases/${listing.id}/${listing.version}.json`,
      sha256: sha256(descriptorBytes)
    }
    const indexBytes = json({ schema_version: 1, releases: [listing.release] })
    changedRoot.release_index = {
      path: `indexes/${sha256(indexBytes)}.json`,
      sha256: sha256(indexBytes)
    }
    const { revision: _revision, ...body } = changedRoot
    void _revision
    changedRoot.revision = sha256(json(body))
    const metadata = transport()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith('/marketplace.json'))
        return new Response(json(changedRoot).toString())
      if (String(url).endsWith(changedRoot.release_index.path))
        return new Response(indexBytes.toString())
      if (String(url).endsWith(listing.release.path))
        return new Response(descriptorBytes.toString())
      return metadata(url, init)
    })
    vi.mocked(verify).mockImplementationOnce(() => true)
    const service = new SkillMarketplaceService(fetch)
    expect(await service.list()).toMatchObject({
      ok: true,
      value: { entries: [{ version: '1.0.0-beta.1' }] }
    })
    expect(
      await service.detail({ snapshotId: changedRoot.revision, id: listing.id })
    ).toMatchObject({ ok: true, value: { entry: { version: listing.version } } })
    fetch.mockClear()
    expect(
      await service.download({ snapshotId: changedRoot.revision, id: changedRoot.skills[0].id })
    ).toEqual({ ok: false, error: 'integrity' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('times out a stalled CDN response before falling back to GitHub', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        milliseconds
      )
      return controller.signal
    })
    const metadata = transport()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).startsWith(source.cdnBaseUrl)) {
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true
              })
            }
          })
        )
      }
      return metadata(url, init)
    })
    const pending = new SkillMarketplaceService(fetch).list()
    await vi.advanceTimersByTimeAsync(15000)
    expect(await pending).toMatchObject({ ok: true, value: { snapshotId: root.revision } })
  })

  it('verifies an index fallback before accepting a CDN root', async () => {
    const metadata = transport()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      String(url) === `${source.cdnBaseUrl}${root.release_index.path}`
        ? new Response('{}')
        : metadata(url, init)
    )
    expect(await new SkillMarketplaceService(fetch).list()).toMatchObject({ ok: true })
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(assetUrl(root.release_index.path))
    expect(
      fetch.mock.calls.some(([url]) => new URL(String(url)).hostname === 'api.github.com')
    ).toBe(false)
  })
  it.each(['offline', 'signature', 'partial-pair'])(
    'falls back from CDN %s to a commit-pinned GitHub pair and verified release objects',
    async (failure) => {
      const metadata = transport()
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const value = String(url)
        if (value.startsWith(source.cdnBaseUrl)) {
          if (failure === 'signature' && value.endsWith('.sig')) return Response.json({})
          if (failure === 'signature') return metadata(url, init)
          if (failure === 'partial-pair' && value.endsWith('/marketplace.json'))
            return new Response(rootBytes.toString())
          return new Response(null, { status: 503 })
        }
        return metadata(url, init)
      })
      const service = new SkillMarketplaceService(fetch)
      expect(await service.list()).toMatchObject({ ok: true, value: { snapshotId: root.revision } })
      expect(
        await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })
      ).toMatchObject({ ok: true })
      const urls = fetch.mock.calls.map(([url]) => String(url))
      expect(urls.slice(0, 2)).toEqual([
        `${source.cdnBaseUrl}marketplace.json`,
        `${source.cdnBaseUrl}marketplace.json.sig`
      ])
      expect(urls).toContain(
        `https://raw.githubusercontent.com/${source.repository}/${commit}/marketplace.json`
      )
      expect(urls).toContain(
        `https://raw.githubusercontent.com/${source.repository}/${commit}/marketplace.json.sig`
      )
      expect(fetch.mock.calls.every(([, init]) => init?.credentials === 'omit')).toBe(true)
    }
  )

  it('verifies a descriptor on each mirror without re-discovering latest', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockResolvedValueOnce(new Response('{}'))
    expect(
      await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })
    ).toMatchObject({ ok: true })
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(assetUrl(root.skills[0].release.path))
    expect(
      fetch.mock.calls.some(([url]) => new URL(String(url)).hostname === 'api.github.com')
    ).toBe(false)
  })

  it('rejects corrupt descriptors on both mirrors without caching them', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockImplementation(async () => new Response('{}'))
    expect(await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'integrity'
    })
    fetch.mockImplementation(transport().getMockImplementation()!)
    expect((await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })).ok).toBe(
      true
    )
  })

  it('rejects obsolete Git-commit identities without remote reads', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    expect(await service.list({ snapshotId: commit })).toEqual({ ok: false, error: 'integrity' })
    expect(await service.detail({ snapshotId: commit, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
    expect(await service.download({ snapshotId: commit, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reuses verified metadata for five minutes and revalidates only the signed CDN pair for an unchanged revision', async () => {
    vi.useFakeTimers()
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    const first = await service.list()
    expect(fetch).toHaveBeenCalledTimes(3)
    if (!first.ok) throw new Error('fixture failed')
    first.value.entries.length = 0
    expect(await service.list()).toMatchObject({
      ok: true,
      value: { revalidate: false, entries: [expect.anything()] }
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(await service.list()).toMatchObject({ ok: true, value: { revalidate: true } })
    expect(fetch).toHaveBeenCalledTimes(3)
    const forced = service.list({ forceRefresh: true })
    expect(service.list({ forceRefresh: true })).toBe(forced)
    expect(await forced).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(await service.list()).toMatchObject({ ok: true, value: { revalidate: false } })
  })

  it('reconciles a known snapshot without remote discovery and rejects ambiguous requests', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockRejectedValue(new Error('offline'))
    expect(await service.list({ snapshotId: root.revision })).toMatchObject({ ok: true })
    expect(await service.list({ snapshotId: 'f'.repeat(64) })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
    expect(await service.list({ snapshotId: root.revision, forceRefresh: true })).toEqual({
      ok: false,
      error: 'integrity'
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('coalesces and caches verified details without exposing mutable cache values', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    const request = { snapshotId: root.revision, id: 'abstract-trimmer' }
    const [first, second] = await Promise.all([service.detail(request), service.detail(request)])
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(first).toEqual(second)
    if (!first.ok) throw new Error('fixture failed')
    first.value.entry.displayName = 'mutated'
    expect(await service.detail(request)).toEqual(second)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('does not cache a failed detail read', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    const request = { snapshotId: root.revision, id: 'abstract-trimmer' }
    expect(await service.detail(request)).toEqual({ ok: false, error: 'network' })
    expect(await service.detail(request)).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(6)
  })
  it('retains the confirmed batch snapshot across catalog refreshes and releases it afterward', async () => {
    let currentRoot = rootBytes
    const metadata = transport()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url) === `${source.cdnBaseUrl}marketplace.json`)
        return new Response(currentRoot.toString())
      return metadata(url, init)
    })
    const service = new SkillMarketplaceService(fetch)
    const request = {
      snapshotId: root.revision,
      items: [{ id: 'abstract-trimmer', version: '1.0.0', expectedVersion: null }]
    }
    expect(service.retainSnapshot(request)).toBeUndefined()
    await service.list()
    expect(
      service.retainSnapshot({ ...request, items: [{ ...request.items[0], version: '2.0.0' }] })
    ).toBeUndefined()
    expect(
      service.retainSnapshot({ ...request, items: [{ ...request.items[0], id: 'unknown' }] })
    ).toBeUndefined()
    const release = service.retainSnapshot(request)!
    for (let i = 1; i <= 6; i++) {
      const { revision: _revision, ...body } = root
      void _revision
      body.previous_revision = i.toString(16).padStart(64, '0')
      currentRoot = json({ ...body, revision: sha256(json(body)) })
      vi.mocked(verify).mockImplementationOnce(() => true)
      expect((await service.list({ forceRefresh: true })).ok).toBe(true)
    }
    expect((await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })).ok).toBe(
      true
    )
    release()
    release()
    const { revision: _revision, ...body } = root
    void _revision
    body.previous_revision = 'f'.repeat(64)
    currentRoot = json({ ...body, revision: sha256(json(body)) })
    vi.mocked(verify).mockImplementationOnce(() => true)
    await service.list({ forceRefresh: true })
    expect(await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
  })

  it.each(['cdn', 'fallback', 'tampered-cdn', 'both-corrupt'])(
    'downloads the selected Skill from a multi-Skill shard (%s)',
    async (mode) => {
      const files = [
        {
          relativePath: 'SKILL.md',
          content: Buffer.from(
            '---\nname: abstract-trimmer\ndescription: Test-only package\n---\nTest instructions\n'
          )
        }
      ]
      const archive = Buffer.from(
        zipSync({
          'abstract-trimmer/SKILL.md': files[0].content,
          'another-skill/SKILL.md': files[0].content
        })
      )
      const testRoot = structuredClone(root)
      const testDescriptor = JSON.parse(descriptor.toString())
      const listing = testRoot.skills[0]
      listing.artifact = {
        path: `shards/${sha256(archive)}.zip`,
        sha256: sha256(archive),
        bytes: archive.length,
        skill_path: listing.id
      }
      listing.content_sha256 = marketplaceContentDigest(files)
      testDescriptor.artifact = listing.artifact
      testDescriptor.package = {
        content_sha256: listing.content_sha256,
        file_count: 1,
        uncompressed_bytes: files[0].content.length
      }
      const descriptorBytes = json(testDescriptor)
      listing.release.sha256 = sha256(descriptorBytes)
      const indexBytes = json({ schema_version: 1, releases: [listing.release] })
      testRoot.release_index = {
        path: `indexes/${sha256(indexBytes)}.json`,
        sha256: sha256(indexBytes)
      }
      const { revision: _revision, ...body } = testRoot
      void _revision
      testRoot.revision = sha256(json(body))
      const assetUrl = `https://github.com/aipoch/openscience-skill-marketplace/releases/download/catalog-${testRoot.revision}/${sha256(Buffer.from(listing.artifact.path))}.zip`
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const value = String(url)
        if (value.endsWith('/git/ref/heads/published'))
          return Response.json({ object: { sha: commit, type: 'commit' } })
        if (value.endsWith('/marketplace.json')) return new Response(json(testRoot).toString())
        if (value.endsWith('/marketplace.json.sig')) return new Response(signature.toString())
        if (value.endsWith(testRoot.release_index.path)) return new Response(indexBytes.toString())
        if (value.endsWith(listing.release.path)) return new Response(descriptorBytes.toString())
        if (value === `${source.cdnBaseUrl}${listing.artifact.path}`) {
          expect(init?.redirect).toBe('error')
          expect(init?.headers).toEqual({ Accept: 'application/octet-stream' })
          if (mode === 'cdn') return new Response(archive)
          if (mode === 'tampered-cdn' || mode === 'both-corrupt') return new Response('corrupt')
          return new Response(null, { status: 503 })
        }
        if (value === assetUrl) {
          expect(init?.redirect).toBe('manual')
          return new Response(null, {
            status: 302,
            headers: {
              location: 'https://release-assets.githubusercontent.com/test?signature=test'
            }
          })
        }
        if (value.startsWith('https://release-assets.githubusercontent.com/')) {
          expect(init?.redirect).toBe('error')
          expect(init?.headers).toBeUndefined()
          return new Response(mode === 'both-corrupt' ? Buffer.from('corrupt') : archive)
        }
        throw new Error('Unexpected URL')
      })
      const service = new SkillMarketplaceService(fetch)
      // This synthetic package is confined to the transport test. Production has no key override.
      vi.mocked(verify).mockImplementationOnce(() => true)
      expect((await service.list()).ok).toBe(true)
      expect((await service.detail({ id: listing.id, snapshotId: testRoot.revision })).ok).toBe(
        true
      )
      const downloaded = await service.download({ id: listing.id, snapshotId: testRoot.revision })
      if (mode === 'both-corrupt') {
        expect(downloaded).toEqual({ ok: false, error: 'integrity' })
        return
      }
      expect(downloaded).toMatchObject({
        ok: true,
        value: {
          files,
          receipt: {
            id: listing.id,
            version: '1.0.0',
            snapshotId: testRoot.revision,
            revision: testRoot.revision,
            contentSha256: listing.content_sha256
          }
        }
      })
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith(listing.release.path))
      ).toHaveLength(2)
      if (mode === 'cdn')
        expect(fetch.mock.calls.every(([url]) => String(url).startsWith(source.cdnBaseUrl))).toBe(
          true
        )
    }
  )

  it.each([
    'http://127.0.0.1/private',
    'https://attacker.example/payload',
    'https://release-assets.githubusercontent.com:444/payload'
  ])('rejects an untrusted artifact redirect to %s', async (location) => {
    const metadata = transport()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      String(url).startsWith('https://github.com/')
        ? new Response(null, { status: 302, headers: { location } })
        : metadata(url, init)
    )
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    expect(await service.download({ id: 'abstract-trimmer', snapshotId: root.revision })).toEqual({
      ok: false,
      error: 'network'
    })
    expect(fetch.mock.calls.some(([url]) => String(url) === location)).toBe(false)
  })
  it('accepts the published signature, index and descriptor without requesting shards', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    const request = service.list()
    expect(service.list()).toBe(request)
    const catalog = await request
    expect(catalog).toMatchObject({
      ok: true,
      value: {
        snapshotId: root.revision,
        entries: [
          {
            id: 'abstract-trimmer',
            license: 'MIT',
            category: 'Academic Writing',
            evaluation: { score: 85, maxScore: 100 }
          }
        ]
      }
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith(source.cdnBaseUrl))).toBe(true)
    const detail = await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })
    expect(detail).toMatchObject({
      ok: true,
      value: {
        entry: { source: { path: 'scientific-skills/Academic Writing/abstract-trimmer' } },
        licenseEvidence: [{ url: expect.stringContaining('/blob/') }]
      }
    })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(
      fetch.mock.calls.every(
        ([url, options]) =>
          !String(url).includes('/shards/') && options?.redirect === 'error' && options.signal
      )
    ).toBe(true)
  })

  it('rejects altered bytes, unknown keys and unpinned keys before mapping', () => {
    expect(() =>
      verifyMarketplaceRoot(Buffer.concat([rootBytes, Buffer.from(' ')]), signature)
    ).toThrow('signature')
    expect(() =>
      verifyMarketplaceRoot(
        rootBytes,
        json({ ...JSON.parse(signature.toString()), public_key: 'attacker' })
      )
    ).toThrow()
    expect(() =>
      verifyMarketplaceRoot(rootBytes, json({ ...JSON.parse(signature.toString()), extra: true }))
    ).toThrow()
  })

  it.each([
    (doc) => {
      doc.unknown = true
    },
    (doc) => {
      Reflect.set(doc.skills[0], 'category', 'academic-writing')
    },
    (doc) => {
      doc.skills[0].source.path = '../bad'
    },
    (doc) => {
      doc.skills[0].evaluation!.score = 101
    },
    (doc) => {
      doc.skills[0].evaluation!.report_url =
        'https://github.com/other/repo/blob/' + 'a'.repeat(40) + '/score.json'
    },
    (doc) => {
      doc.skills.push(doc.skills[0])
    },
    (doc) => {
      doc.skills[0].release.path = 'releases/wrong/1.0.0.json'
    },
    (doc) => {
      doc.skills[0].artifact.skill_path = 'wrong'
    },
    (doc) => {
      doc.release_index.path = 'indexes/' + 'a'.repeat(64) + '.json'
    }
  ] satisfies ((doc: MarketplaceRoot & { unknown?: boolean }) => void)[])(
    'validates authenticated protocol invariants independently of crypto',
    (change) => {
      // Only this isolated schema/domain test bypasses crypto; the other cases verify the real key.
      const doc = JSON.parse(rootBytes.toString())
      change(doc)
      const body = { ...doc }
      delete body.revision
      doc.revision = sha256(json(body))
      vi.mocked(verify).mockImplementationOnce(() => true)
      expect(() => verifyMarketplaceRoot(json(doc), signature)).toThrow()
    }
  )

  it('rejects bad revision, index membership, duplicate index entries and descriptor identity', () => {
    const badRoot = { ...root, revision: 'a'.repeat(64) }
    vi.mocked(verify).mockImplementationOnce(() => true)
    expect(() => verifyMarketplaceRoot(json(badRoot), signature)).toThrow('revision')
    expect(() => verifyMarketplaceIndex(json({ schema_version: 1, releases: [] }), root)).toThrow(
      'digest'
    )
    for (const releases of [[], [root.skills[0].release, root.skills[0].release]]) {
      const bytes = json({ schema_version: 1, releases })
      expect(() =>
        verifyMarketplaceIndex(bytes, {
          ...root,
          release_index: { path: '', sha256: sha256(bytes) }
        })
      ).toThrow()
    }
    expect(() => verifyMarketplaceDetail(Buffer.from('{}'), root.skills[0])).toThrow('digest')
    expect(() => verifyMarketplaceDetail(descriptor, { ...root.skills[0], id: 'wrong' })).toThrow(
      'identity'
    )
  })

  it('does not invent absent author or assessment fields', () => {
    const doc = JSON.parse(descriptor.toString())
    delete doc.skill.evaluation
    delete doc.skill.authors
    const bytes = json(doc)
    const listing = { ...root.skills[0] }
    delete listing.evaluation
    delete listing.authors
    const detail = verifyMarketplaceDetail(bytes, {
      ...listing,
      release: { ...listing.release, sha256: sha256(bytes) }
    })
    expect(detail.entry.evaluation).toBeUndefined()
    expect(detail.entry.authors).toBeUndefined()
  })

  it('requires a server-owned snapshot and rejects caller supplied URL authority', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    expect(await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
    expect(fetch).not.toHaveBeenCalled()
    await service.list()
    const request = {
      snapshotId: root.revision,
      id: 'abstract-trimmer',
      url: 'https://attacker.test'
    }
    expect(await service.detail(request)).toEqual({ ok: false, error: 'snapshot-unavailable' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retains verified listings after a network refresh failure and retries without caching the failure', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockImplementation(async () => new Response('', { status: 503 }))
    expect(await service.list({ forceRefresh: true })).toMatchObject({
      ok: true,
      value: { snapshotId: root.revision, revalidate: true }
    })
    fetch.mockClear()
    expect(await service.list()).toMatchObject({ ok: true, value: { revalidate: true } })
    expect(fetch).not.toHaveBeenCalled()
    expect(await service.download({ snapshotId: root.revision, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'network'
    })
    fetch.mockImplementation(transport().getMockImplementation()!)
    expect(
      await service.detail({ snapshotId: root.revision, id: 'abstract-trimmer' })
    ).toMatchObject({
      ok: true
    })
    expect(await service.list({ forceRefresh: true })).toMatchObject({ ok: true })
    expect(await service.list()).toMatchObject({ ok: true, value: { revalidate: false } })
  })

  it('does not substitute cached listings for an integrity failure or an initial network failure', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    fetch.mockRejectedValue(new Error('offline'))
    expect(await service.list()).toEqual({ ok: false, error: 'network' })
    fetch.mockImplementation(transport().getMockImplementation()!)
    await service.list()
    fetch.mockImplementation(async () => new Response('{}'))
    expect(await service.list({ forceRefresh: true })).toEqual({ ok: false, error: 'integrity' })
    expect(await service.list()).toEqual({ ok: false, error: 'integrity' })
  })

  it.each([true, false])(
    'bounds both advertised and streamed metadata bytes (%s)',
    async (advertised) => {
      const cancel = vi.fn()
      const fetch = transport()
        .mockRejectedValue(new Error('offline'))
        .mockImplementationOnce(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
                },
                cancel
              }),
              { headers: advertised ? { 'content-length': String(4 * 1024 * 1024 + 1) } : {} }
            )
        )
        .mockResolvedValueOnce(new Response(signature.toString()))
      expect(await new SkillMarketplaceService(fetch).list()).toEqual({
        ok: false,
        error: 'integrity'
      })
      expect(cancel).toHaveBeenCalled()
    }
  )

  it('handles a timeout during body consumption as a network failure', async () => {
    const fetch = transport()
      .mockRejectedValue(new Error('offline'))
      .mockImplementationOnce(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(new Error('timeout')),
                  { once: true }
                )
                controller.error(new DOMException('Timed out', 'TimeoutError'))
              }
            })
          )
      )
    expect(await new SkillMarketplaceService(fetch).list()).toEqual({ ok: false, error: 'network' })
  })
})
