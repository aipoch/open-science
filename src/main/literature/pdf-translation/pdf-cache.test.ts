import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationPdfCache } from './pdf-cache'
import { PdfTranslationWriter } from './writer'
import type { ApplicationCallerLease } from '../../application-command-router'
import type { PdfTranslationPdfResult } from '@aipoch/pdf-translation/contracts'
import type {
  PdfTranslationCheckpoint,
  PdfTranslationPdfRequest,
  PdfTranslationRecordLayoutRequest
} from '../../../shared/pdf-translation'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const lease = (): ApplicationCallerLease => ({
  leaseId: randomUUID(),
  generation: 1,
  signal: new AbortController().signal,
  isCurrent: () => true
})
// Preserve the inferred mock controls on this test fixture.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
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
    attachmentVersionId: 'source',
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
  const owner = {
    recordLayout: vi.fn(async () => {}),
    readCheckpoint: vi.fn(async () => checkpoint as PdfTranslationCheckpoint | null)
  }
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
    await cache.recordLayout(report(result!), caller)
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

it('publishes only after verification and survives restart; authorized source bindings share the same edition', async () => {
  const f = await setup()
  const generated = await f.cache.generate(f.request, f.caller)
  await expect(readdir(f.directory)).rejects.toThrow()
  await f.cache.recordLayout(f.report(generated!), f.caller)
  expect(await readdir(f.directory)).toHaveLength(1)
  const restarted = new PdfTranslationPdfCache(f.options)
  const hit = await restarted.generate(
    {
      ...f.request,
      id: 'second',
      cache: { ...f.request.cache, source: 'another-authorized-source' }
    },
    lease()
  )
  expect(hit).toEqual({ data: Buffer.from('%PDF-output'), layoutFailures: [], cacheHit: true })
  expect(f.writer.generateDetailed).toHaveBeenCalledTimes(1)
})

it('checks source permission again before returning a hit', async () => {
  const f = await setup()
  await f.publish()
  f.owner.readCheckpoint.mockResolvedValueOnce(f.checkpoint).mockResolvedValueOnce(null)
  expect((await f.cache.generate(f.request, f.caller))?.cacheHit).toBeUndefined()
})

it('cancels while authorization is pending and never starts generation', async () => {
  const f = await setup()
  const pending = Promise.withResolvers<PdfTranslationCheckpoint | null>()
  f.owner.readCheckpoint.mockReturnValue(pending.promise)
  const result = f.cache.generate(f.request, f.caller)
  f.cache.cancel(f.request.id, f.caller)
  pending.resolve(f.checkpoint)
  expect(await result).toBeNull()
  expect(f.writer.generateDetailed).not.toHaveBeenCalled()
})

it('returns no token and writes no directory for a read-only package checkpoint', async () => {
  const f = await setup()
  f.owner.readCheckpoint.mockResolvedValue(null)
  const result = await f.cache.generate(f.request, f.caller)
  expect(result?.cacheToken).toBeUndefined()
  await f.cache.recordLayout(f.report(result!), f.caller)
  await expect(readdir(f.directory)).rejects.toThrow()
})

it('addresses the requested edition throughout cache lookup and publication', async () => {
  const f = await setup()
  await f.publish()
  expect((await f.cache.generate(f.request, f.caller))?.cacheHit).toBe(true)
  expect(f.owner.readCheckpoint.mock.calls.length).toBeGreaterThan(1)
  for (const args of f.owner.readCheckpoint.mock.calls)
    expect(args).toEqual(['source', f.caller, f.checkpoint.key])
})

it('adapts a workspace source and checkpoint in both cache directions', async () => {
  const f = await setup()
  const source = {
    kind: 'upload-version' as const,
    projectId: 'project',
    sourceFileId: 'file',
    versionId: 'version',
    checksum: f.checkpoint.checksum,
    name: 'paper.pdf',
    path: 'upload-version:version'
  }
  f.owner.readCheckpoint.mockResolvedValue({
    ...f.checkpoint,
    attachmentVersionId: undefined,
    documentSource: source
  })
  const request = { ...f.request, cache: { ...f.request.cache, source } }
  const result = await f.cache.generate(request, f.caller)
  expect(result?.cacheToken).toBeDefined()
  await f.cache.recordLayout({ ...f.report(result!), source }, f.caller)
  expect((await f.cache.generate(request, f.caller))?.cacheHit).toBe(true)
  for (const args of f.owner.readCheckpoint.mock.calls)
    expect(args).toEqual([source, f.caller, f.checkpoint.key])
  expect(f.writer.generateDetailed).toHaveBeenCalledOnce()
})
