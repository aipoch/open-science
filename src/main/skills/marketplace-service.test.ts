import { readFileSync } from 'node:fs'
import { verify } from 'node:crypto'
import { zipSync } from 'fflate'
import { marketplaceContentDigest } from './marketplace-package'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplaceService } from './marketplace-service'
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

function transport(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url) => {
    const value = String(url)
    if (value.endsWith('/git/ref/heads/published'))
      return new Response(JSON.stringify({ object: { sha: commit, type: 'commit' } }))
    expect(value).toContain(`/${commit}/`)
    if (value.endsWith('/marketplace.json')) return new Response(rootBytes.toString())
    if (value.endsWith('/marketplace.json.sig')) return new Response(signature.toString())
    if (value.endsWith(root.release_index.path)) return new Response(index.toString())
    if (value.endsWith(root.skills[0].release.path)) return new Response(descriptor.toString())
    throw new Error(`Unexpected metadata request: ${value}`)
  })
}
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('verified Skill Marketplace browsing', () => {
  it('reuses verified metadata for five minutes and checks only the ref for an unchanged commit', async () => {
    vi.useFakeTimers()
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    const first = await service.list()
    expect(fetch).toHaveBeenCalledTimes(4)
    if (!first.ok) throw new Error('fixture failed')
    first.value.entries.length = 0
    expect(await service.list()).toMatchObject({
      ok: true,
      value: { revalidate: false, entries: [expect.anything()] }
    })
    expect(fetch).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(await service.list()).toMatchObject({ ok: true, value: { revalidate: true } })
    expect(fetch).toHaveBeenCalledTimes(4)
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
    expect(await service.list({ snapshotId: commit })).toMatchObject({ ok: true })
    expect(await service.list({ snapshotId: 'f'.repeat(40) })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
    expect(await service.list({ snapshotId: commit, forceRefresh: true })).toEqual({
      ok: false,
      error: 'integrity'
    })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('coalesces and caches verified details without exposing mutable cache values', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    const request = { snapshotId: commit, id: 'abstract-trimmer' }
    const [first, second] = await Promise.all([service.detail(request), service.detail(request)])
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(first).toEqual(second)
    if (!first.ok) throw new Error('fixture failed')
    first.value.entry.displayName = 'mutated'
    expect(await service.detail(request)).toEqual(second)
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('does not cache a failed detail read', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockRejectedValueOnce(new Error('offline'))
    const request = { snapshotId: commit, id: 'abstract-trimmer' }
    expect(await service.detail(request)).toEqual({ ok: false, error: 'network' })
    expect(await service.detail(request)).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(6)
  })
  it('retains the confirmed batch snapshot across catalog refreshes and releases it afterward', async () => {
    let currentCommit = commit
    const metadata = transport()
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith('/git/ref/heads/published'))
        return Response.json({ object: { sha: currentCommit, type: 'commit' } })
      return metadata(String(url).replace(currentCommit, commit), init)
    })
    const service = new SkillMarketplaceService(fetch)
    const request = {
      snapshotId: commit,
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
      currentCommit = i.toString(16).padStart(40, '0')
      expect((await service.list({ forceRefresh: true })).ok).toBe(true)
    }
    expect((await service.detail({ snapshotId: commit, id: 'abstract-trimmer' })).ok).toBe(true)
    release()
    release()
    currentCommit = 'f'.repeat(40)
    await service.list({ forceRefresh: true })
    expect(await service.detail({ snapshotId: commit, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
  })

  it('downloads the root-selected Release asset, follows only the GitHub asset hop, and verifies package contents', async () => {
    const files = [
      {
        relativePath: 'SKILL.md',
        content: Buffer.from(
          '---\nname: abstract-trimmer\ndescription: Test-only package\n---\nTest instructions\n'
        )
      }
    ]
    const archive = Buffer.from(zipSync({ 'abstract-trimmer/SKILL.md': files[0].content }))
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
      if (value === assetUrl) {
        expect(init?.redirect).toBe('manual')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/test?signature=test' }
        })
      }
      if (value.startsWith('https://release-assets.githubusercontent.com/')) {
        expect(init?.redirect).toBe('error')
        expect(init?.headers).toBeUndefined()
        return new Response(archive)
      }
      throw new Error('Unexpected URL')
    })
    const service = new SkillMarketplaceService(fetch)
    // This synthetic package is confined to the transport test. Production has no key override.
    vi.mocked(verify).mockImplementationOnce(() => true)
    expect((await service.list()).ok).toBe(true)
    expect((await service.detail({ id: listing.id, snapshotId: commit })).ok).toBe(true)
    expect(await service.download({ id: listing.id, snapshotId: commit })).toMatchObject({
      ok: true,
      value: {
        files,
        receipt: { id: listing.id, version: '1.0.0', contentSha256: listing.content_sha256 }
      }
    })
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith(listing.release.path))
    ).toHaveLength(2)
  })

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
    expect(await service.download({ id: 'abstract-trimmer', snapshotId: commit })).toEqual({
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
        snapshotId: commit,
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
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(new Set(fetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(1)
    const detail = await service.detail({ snapshotId: commit, id: 'abstract-trimmer' })
    expect(detail).toMatchObject({
      ok: true,
      value: {
        entry: { source: { path: 'scientific-skills/Academic Writing/abstract-trimmer' } },
        licenseEvidence: [{ url: expect.stringContaining('/blob/') }]
      }
    })
    expect(fetch).toHaveBeenCalledTimes(5)
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
    expect(await service.detail({ snapshotId: commit, id: 'abstract-trimmer' })).toEqual({
      ok: false,
      error: 'snapshot-unavailable'
    })
    expect(fetch).not.toHaveBeenCalled()
    await service.list()
    const request = { snapshotId: commit, id: 'abstract-trimmer', url: 'https://attacker.test' }
    expect(await service.detail(request)).toEqual({ ok: false, error: 'snapshot-unavailable' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('fails closed on refresh failure but keeps an already verified detail snapshot usable', async () => {
    const fetch = transport()
    const service = new SkillMarketplaceService(fetch)
    await service.list()
    fetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(await service.list({ forceRefresh: true })).toEqual({ ok: false, error: 'network' })
    expect(await service.detail({ snapshotId: commit, id: 'abstract-trimmer' })).toMatchObject({
      ok: true
    })
    expect(await service.list()).toMatchObject({ ok: true })
  })

  it.each([true, false])(
    'bounds both advertised and streamed metadata bytes (%s)',
    async (advertised) => {
      const cancel = vi.fn()
      const fetch = transport().mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16385))
            },
            cancel
          }),
          { headers: advertised ? { 'content-length': '16385' } : {} }
        )
      )
      expect(await new SkillMarketplaceService(fetch).list()).toEqual({
        ok: false,
        error: 'integrity'
      })
      expect(cancel).toHaveBeenCalled()
    }
  )

  it('handles a timeout during body consumption as a network failure', async () => {
    const fetch = transport().mockImplementationOnce(
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
