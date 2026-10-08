import { createHash, randomUUID } from 'node:crypto'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationPdfCache } from './pdf-cache'
import { PdfTranslationWriter } from './writer'
import type { ApplicationCallerLease } from '../../application-command-router'
import type {
  PdfTranslationCheckpoint,
  PdfTranslationPdfRequest,
  PdfTranslationPdfResult,
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

it('publishes only after verification and survives restart; authorized source bindings share the same edition', async () => {
  const f = await setup()
  const generated = await f.cache.generate(f.request, f.caller)
  await expect(readdir(f.directory)).rejects.toThrow()
  await f.cache.confirm(f.report(generated!), f.caller)
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

it.each([
  'checksum',
  'revision',
  'key',
  'layout',
  'translation',
  'environment',
  'geometry',
  'language',
  'model',
  'glossary',
  'target'
] as const)('invalidates changed %s', async (kind) => {
  const f = await setup()
  await f.publish()
  let request = f.request
  if (kind === 'checksum') request = { ...request, data: Buffer.from('%PDF-other') }
  if (kind === 'revision') f.checkpoint.revision++
  if (kind === 'key') f.checkpoint.key = randomUUID()
  if (kind === 'layout') f.checkpoint.layoutSnapshot!.parserVersion = 'v2'
  if (kind === 'translation') f.checkpoint.translations[0] = 'new'
  if (kind === 'environment') f.options.revision.mockResolvedValue('v2')
  if (kind === 'geometry') request = { ...request, pages: [{ width: 401, height: 500 }] }
  if (kind === 'language') f.checkpoint.language = 'English'
  if (kind === 'model') f.checkpoint.model.modelId = 'new'
  if (kind === 'glossary') f.checkpoint.glossary = [{ source: 'cell', target: 'new' }]
  if (kind === 'target') f.checkpoint.targetKey = 'b'.repeat(64)
  expect((await f.cache.generate(request, f.caller))?.cacheHit).toBeUndefined()
  expect(f.writer.generateDetailed).toHaveBeenCalledTimes(2)
})

it.each(['null', 'revoked', 'malformed', 'incomplete', 'missing-layout'] as const)(
  'never admits %s checkpoint sources',
  async (kind) => {
    const f = await setup()
    await f.publish()
    let request = f.request
    if (kind === 'null') f.owner.readCheckpoint.mockResolvedValue(null)
    if (kind === 'revoked') f.owner.readCheckpoint.mockRejectedValue(new Error('unauthorized'))
    if (kind === 'malformed')
      request = { ...request, cache: { ...request.cache, source: {} as never } }
    if (kind === 'incomplete') f.checkpoint.translations = []
    if (kind === 'missing-layout') f.checkpoint.layoutSnapshot = undefined
    const result = await f.cache.generate(request, f.caller)
    expect(result?.cacheHit).toBeUndefined()
    expect(result?.cacheToken).toBeUndefined()
  }
)

it.each(['truncated', 'digest', 'header', 'symlink', 'expired'] as const)(
  'treats %s cache files as misses and replaces them safely',
  async (kind) => {
    const f = await setup()
    await f.publish()
    const file = join(f.directory, (await readdir(f.directory))[0])
    if (kind === 'truncated') await truncate(file, 2)
    if (kind === 'digest') {
      const bytes = await readFile(file)
      bytes[bytes.length - 1] ^= 1
      await writeFile(file, bytes)
    }
    if (kind === 'header') {
      const bytes = await readFile(file)
      bytes.writeUInt32BE(0xffffffff, 8)
      await writeFile(file, bytes)
    }
    if (kind === 'symlink') {
      const outside = join(f.root, 'outside.pdf')
      await writeFile(outside, 'untouched')
      await rm(file)
      await symlink(outside, file)
    }
    if (kind === 'expired') {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 86400000)
    }
    const regenerated = await f.cache.generate(f.request, f.caller)
    expect(regenerated?.cacheHit).toBeUndefined()
    await f.cache.confirm(f.report(regenerated!), f.caller)
    if (kind === 'symlink')
      expect(await readFile(join(f.root, 'outside.pdf'), 'utf8')).toBe('untouched')
    expect((await f.cache.generate(f.request, f.caller))?.cacheHit).toBe(true)
    vi.restoreAllMocks()
  }
)

it.each([
  'wrong-caller',
  'wrong-source',
  'wrong-key',
  'translation',
  'failure',
  'incomplete',
  'revoked',
  'root-switch',
  'cancel',
  'abort'
] as const)('rejects %s confirmation', async (kind) => {
  const f = await setup()
  const controller = new AbortController()
  const caller = { ...f.caller, signal: controller.signal }
  const result = await f.cache.generate(f.request, caller)
  const report = f.report(result!)
  if (kind === 'wrong-source') report.source = 'other'
  if (kind === 'wrong-key') report.checkpointKey = randomUUID()
  if (kind === 'translation') report.units[0].translation = 'wrong'
  if (kind === 'failure')
    Object.assign(report.units[0], {
      failure: {
        code: 'validation-failed',
        phase: 'verification',
        pageNumbers: [1],
        fragmentCount: 1
      }
    })
  if (kind === 'incomplete') report.units = []
  if (kind === 'revoked') f.owner.readCheckpoint.mockResolvedValue(null)
  if (kind === 'root-switch') f.options.root = () => join(f.root, 'new-root')
  if (kind === 'cancel') f.cache.cancel(f.request.id, caller)
  if (kind === 'abort') controller.abort()
  await f.cache.confirm(report, kind === 'wrong-caller' ? lease() : caller)
  await expect(readdir(f.directory)).rejects.toThrow()
})

it('bounds pending candidates, expires tokens, and ignores late confirmation after eviction', async () => {
  vi.useFakeTimers()
  const f = await setup()
  const first = await f.cache.generate(f.request, f.caller)
  await f.cache.generate({ ...f.request, id: 'second' }, f.caller)
  const third = await f.cache.generate({ ...f.request, id: 'third' }, f.caller)
  await f.cache.confirm(f.report(first!), f.caller)
  await expect(readdir(f.directory)).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  await f.cache.confirm(f.report(third!), f.caller)
  await expect(readdir(f.directory)).rejects.toThrow()
})

it('skips lookup for incremental/bypass, but publishes complete incremental verification', async () => {
  const f = await setup()
  await f.publish()
  for (const input of [
    { ...f.request, cache: { ...f.request.cache, bypass: true } },
    { ...f.request, incremental: { data: Buffer.from('%PDF-existing'), pageNumbers: [1] } }
  ]) {
    const result = await f.cache.generate(input, f.caller)
    expect(result?.cacheHit).toBeUndefined()
    expect(result?.cacheToken).toBeDefined()
    await f.cache.confirm(f.report(result!), f.caller)
  }
  expect(f.writer.generateDetailed).toHaveBeenCalledTimes(3)
})

it('requires exact native retained failures and never caches verification failures', async () => {
  const f = await setup()
  const failure = {
    code: 'overflow',
    phase: 'planning',
    pageNumbers: [1],
    fragmentCount: 1
  } as const
  f.writer.generateDetailed.mockResolvedValue({
    data: Buffer.from('%PDF-retained'),
    layoutFailures: [{ ...failure, pageNumbers: [1], unitIndex: 0 }]
  })
  const result = await f.cache.generate({ ...f.request, preserveUnsupported: true }, f.caller)
  const report = f.report(result!)
  Object.assign(report.units[0], { failure })
  await f.cache.confirm(report, f.caller)
  expect(
    (await f.cache.generate({ ...f.request, preserveUnsupported: true }, f.caller))?.cacheHit
  ).toBe(true)
})

it('enforces file count/byte quotas, removes only owned stale files, and serializes concurrent publication', async () => {
  const f = await setup()
  await f.publish()
  await writeFile(join(f.directory, 'keep.txt'), 'keep')
  const old = new Date(Date.now() - 32 * 86400000)
  const stale = join(f.directory, `.${'e'.repeat(64)}.${randomUUID()}.tmp`)
  await writeFile(stale, 'temp')
  await utimes(stale, old, old)
  // Sparse files exercise disk accounting without allocating hundreds of MiB in the test.
  for (let i = 0; i < 18; i++) {
    const file = join(f.directory, `${i.toString(16).padStart(64, '0')}.pdfcache`)
    await writeFile(file, '')
    await truncate(file, 20 * 1024 ** 2)
  }
  const a = await f.cache.generate(
    { ...f.request, id: 'a', cache: { ...f.request.cache, bypass: true } },
    f.caller
  )
  const b = await f.cache.generate(
    { ...f.request, id: 'b', cache: { ...f.request.cache, bypass: true } },
    f.caller
  )
  await Promise.all([
    f.cache.confirm(f.report(a!), f.caller),
    f.cache.confirm(f.report(b!), f.caller)
  ])
  const names = await readdir(f.directory)
  expect(names.filter((n) => n.endsWith('.pdfcache')).length).toBeLessThanOrEqual(13)
  expect(names).toContain('keep.txt')
  expect(names).not.toContain(stale.split('/').at(-1))
  expect((await f.cache.generate(f.request, f.caller))?.cacheHit).toBe(true)
})

it('does not follow a symlink cache directory or fail generation on disk errors', async () => {
  const f = await setup()
  await writeFile(join(f.root, 'literature'), 'not a directory')
  const result = await f.cache.generate(f.request, f.caller)
  await expect(f.cache.confirm(f.report(result!), f.caller)).resolves.toBeUndefined()
  expect(result?.data).toEqual(Buffer.from('%PDF-output'))
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

it('cancellation during confirmation authorization prevents a late publication', async () => {
  const f = await setup()
  const result = await f.cache.generate(f.request, f.caller)
  const authorization = Promise.withResolvers<PdfTranslationCheckpoint | null>()
  const entered = Promise.withResolvers<void>()
  f.owner.readCheckpoint.mockImplementation(() => {
    entered.resolve()
    return authorization.promise
  })
  const confirmation = f.cache.confirm(f.report(result!), f.caller)
  await entered.promise
  f.cache.cancel(f.request.id, f.caller)
  authorization.resolve(f.checkpoint)
  await confirmation
  await expect(readdir(f.directory)).rejects.toThrow()
})

it('returns no token and writes no directory for a read-only package checkpoint', async () => {
  const f = await setup()
  f.owner.readCheckpoint.mockResolvedValue(null)
  const result = await f.cache.generate(f.request, f.caller)
  expect(result?.cacheToken).toBeUndefined()
  await f.cache.confirm(f.report(result!), f.caller)
  await expect(readdir(f.directory)).rejects.toThrow()
})

it('refuses cache-directory symlinks and preserves their external destination', async () => {
  const f = await setup()
  await f.publish()
  await rm(f.directory, { recursive: true })
  const destination = await mkdtemp(join(tmpdir(), 'pdf-cache-outside-'))
  roots.push(destination)
  await symlink(destination, f.directory)
  const result = await f.cache.generate(f.request, f.caller)
  expect(result?.cacheHit).toBeUndefined()
  await f.cache.confirm(f.report(result!), f.caller)
  expect(await readdir(destination)).toEqual([])
})

it('does not bypass writer input bounds on a potential cache hit', async () => {
  const f = await setup()
  await f.publish()
  const result = await f.cache.generate(
    { ...f.request, id: '', incremental: { data: new Uint8Array(), pageNumbers: [1] } },
    f.caller
  )
  expect(result?.cacheHit).toBeUndefined()
  expect(f.writer.generateDetailed).toHaveBeenCalledTimes(2)
})

it('rechecks authorization after writing the temporary file and before publication', async () => {
  const f = await setup()
  const result = await f.cache.generate(f.request, f.caller)
  f.owner.readCheckpoint.mockResolvedValueOnce(f.checkpoint).mockResolvedValueOnce(null)
  await f.cache.confirm(f.report(result!), f.caller)
  expect(await readdir(f.directory)).toEqual([])
})

it('keeps confirming candidates counted until their asynchronous authorization settles', async () => {
  const f = await setup()
  const first = await f.cache.generate(f.request, f.caller)
  const second = await f.cache.generate({ ...f.request, id: 'second' }, f.caller)
  const waiting = Promise.withResolvers<PdfTranslationCheckpoint | null>()
  const entered = Promise.withResolvers<void>()
  f.owner.readCheckpoint.mockImplementationOnce(() => {
    entered.resolve()
    return waiting.promise
  })
  const confirmations = [
    f.cache.confirm(f.report(first!), f.caller),
    f.cache.confirm(f.report(second!), f.caller)
  ]
  await entered.promise
  f.cache.cancel(f.request.id, f.caller)
  const third = await f.cache.generate(
    { ...f.request, id: 'third', cache: { ...f.request.cache, bypass: true } },
    f.caller
  )
  expect(third?.cacheToken).toBeUndefined()
  waiting.resolve(f.checkpoint)
  await Promise.all(confirmations)
})

it('removes fresh owned crash temporaries while preserving unknown files and the active publication', async () => {
  const f = await setup()
  await f.publish()
  const crashName = `.${'d'.repeat(64)}.${randomUUID()}.tmp`
  await writeFile(join(f.directory, crashName), 'fresh crash residue')
  const unknownName = 'unrelated.tmp'
  await writeFile(join(f.directory, unknownName), 'keep this file')
  const result = await f.cache.generate(
    { ...f.request, cache: { ...f.request.cache, bypass: true } },
    f.caller
  )
  await f.cache.confirm(f.report(result!), f.caller)
  const names = await readdir(f.directory)
  expect(names).not.toContain(crashName)
  expect(await readFile(join(f.directory, unknownName), 'utf8')).toBe('keep this file')
  expect(names.filter((name) => name.endsWith('.pdfcache'))).toHaveLength(1)
  expect((await f.cache.generate(f.request, f.caller))?.cacheHit).toBe(true)
})

it('addresses the requested edition throughout cache lookup and publication', async () => {
  const f = await setup()
  await f.publish()
  expect((await f.cache.generate(f.request, f.caller))?.cacheHit).toBe(true)
  expect(f.owner.readCheckpoint.mock.calls.length).toBeGreaterThan(1)
  for (const args of f.owner.readCheckpoint.mock.calls)
    expect(args).toEqual(['source', f.caller, f.checkpoint.key])
})
