/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationPdfCache } from '../src/pdf-cache.js'
import { PdfTranslationWriter } from '../src/writer.js'
import type { TranslationCallerLease, TranslationWriteAdmission } from '../src/ports.js'
import type {
  PdfTranslationCheckpoint,
  PdfTranslationPdfRequest,
  PdfTranslationPdfResult,
  PdfTranslationRecordLayoutRequest
} from '../src/contracts.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const lease = (): TranslationCallerLease => ({
  leaseId: randomUUID(),
  generation: 1,
  signal: new AbortController().signal,
  isCurrent: () => true
})
// Preserve the inferred mock controls on this test fixture.
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pdf-cache-'))
  roots.push(root)
  const data = Buffer.from('%PDF-source')
  const rect = { x: 0.1, y: 0.1, width: 0.5, height: 0.1 }
  const input: PdfTranslationPdfRequest = {
    id: 'request',
    data,
    pages: [{ width: 400, height: 500 }],
    units: [{ source: 'cell', translation: '细胞', fragments: [{ pageNumber: 1, rect }] }]
  }
  const checkpoint: PdfTranslationCheckpoint = {
    version: 1,
    key: randomUUID(),
    revision: 2,
    sourceId: 'source',
    checksum: createHash('sha256').update(data).digest('hex'),
    fingerprint: 'fp',
    language: 'Chinese',
    glossary: [],
    model: { frameworkId: 'opencode' },
    targetKey: 'a'.repeat(64),
    sources: ['cell'],
    translations: ['细胞'],
    translatedSourceIndices: [0],
    layoutSnapshot: {
      version: 1,
      parserVersion: 'v1',
      fingerprint: 'fp',
      pages: [...input.pages],
      units: [
        {
          id: 'u',
          source: 'cell',
          fragments: [{ pageNumber: 1, rect, items: [{ index: 0, text: 'cell' }] }]
        }
      ],
      coverage: {
        pageCount: 1,
        textItemCount: 1,
        includedItemCount: 1,
        excludedItemCount: 0,
        pagesWithoutText: [],
        exclusions: [],
        warnings: []
      }
    }
  }
  const request = { ...input, cache: { source: 'source', checkpointKey: checkpoint.key } }
  const owner = { readCheckpoint: vi.fn(async () => checkpoint as PdfTranslationCheckpoint | null) }
  const native = new PdfTranslationWriter(() => 'unused')
  const writer = {
    valid: native.valid.bind(native),
    generateDetailed: vi.fn(async (): Promise<PdfTranslationPdfResult | null> => ({
      data: Buffer.from('%PDF-output'),
      layoutFailures: []
    })),
    cancel: vi.fn()
  }
  const options = { root: () => root, revision: vi.fn(async () => 'environment-v1'), owner, writer }
  const cache = new PdfTranslationPdfCache(options)
  const caller = lease()
  const report = (result: PdfTranslationPdfResult): PdfTranslationRecordLayoutRequest => ({
    source: 'source',
    checkpointKey: checkpoint.key,
    generatedAt: Date.now(),
    units: [{ sourceIndex: 0, source: 'cell', translation: '细胞' }],
    pdfCacheToken: result.cacheToken
  })
  const directory = join(root, 'literature', 'pdf-translation-cache')
  const publish = async (): Promise<PdfTranslationPdfResult> => {
    const result = await cache.generate(request, caller)
    expect(result?.cacheToken).toBeDefined()
    await cache.confirm(report(result!), caller)
    return result!
  }
  return {
    root,
    directory,
    input,
    request,
    checkpoint,
    owner,
    writer,
    options,
    cache,
    caller,
    report,
    publish
  }
}

it.each([true, false])('isolates publication queues by root (shared root: %s)', async (shared) => {
  const first = await setup()
  const second = shared ? first : await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const writes: TranslationWriteAdmission = {
    async write(operation) {
      entered.resolve()
      await release.promise
      return operation()
    },
    recover: (operation) => operation()
  }
  const otherWrite = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => operation())
  // realpath also exercises ancestor aliases such as /var -> /private/var on macOS.
  // Use a case alias when supported by the filesystem, otherwise its canonical spelling.
  const alternate = await realpath(second.root.toLowerCase())
    .then(() => second.root.toLowerCase())
    .catch(() => realpath(second.root))
  const one = new PdfTranslationPdfCache({ ...first.options, writes })
  const two = new PdfTranslationPdfCache({
    ...second.options,
    root: () => alternate,
    writes: { write: otherWrite, recover: (operation) => operation() }
  })
  const a = await one.generate(
    { ...first.request, cache: { ...first.request.cache!, bypass: true } },
    first.caller
  )
  const b = await two.generate(
    { ...second.request, cache: { ...second.request.cache!, bypass: true } },
    second.caller
  )
  const publishing = one.confirm(first.report(a!), first.caller)
  await entered.promise
  const other = two.confirm(second.report(b!), second.caller)
  try {
    if (shared) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(otherWrite).not.toHaveBeenCalled()
    } else {
      await expect.poll(() => otherWrite.mock.calls.length).toBe(1)
      await other
      expect(await readdir(second.directory)).toHaveLength(1)
    }
  } finally {
    release.resolve()
    await Promise.all([publishing, other])
  }
  expect(otherWrite).toHaveBeenCalledOnce()
  expect(await readdir(first.directory)).toHaveLength(1)
  expect(await readdir(second.directory)).toHaveLength(1)
})

it('releases a root queue after failed admission so another owner can publish', async () => {
  const h = await setup()
  const failed = new PdfTranslationPdfCache({
    ...h.options,
    writes: {
      write: async () => {
        throw new Error('write unavailable')
      },
      recover: (operation) => operation()
    }
  })
  const result = await failed.generate(
    { ...h.request, cache: { ...h.request.cache!, bypass: true } },
    h.caller
  )
  await failed.confirm(h.report(result!), h.caller)
  const published = await h.publish()
  const hit = await h.cache.generate(h.request, h.caller)
  expect(hit).toMatchObject({ cacheHit: true, data: published.data })
})
