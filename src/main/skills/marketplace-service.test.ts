import { readFileSync } from 'node:fs'
import { verify } from 'node:crypto'
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
    expect(await service.list()).toEqual({ ok: false, error: 'network' })
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
