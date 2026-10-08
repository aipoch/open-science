import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  PdfGenerationError,
  pdfTranslationDocumentSourceSchema,
  pdfTranslationLayoutFailureSchema,
  pdfTranslationRecordLayoutSchema,
  pdfTranslationSourceKey,
  type PdfTranslationCheckpoint,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationPdfRequest,
  type PdfTranslationPdfResult,
  type PdfTranslationRecordLayoutRequest
} from '../../../shared/pdf-translation'
import type { ApplicationCallerLease } from '../../application-command-router'
import { createLogger } from '../../logger'
import { withDataRootWrite } from '../../storage/migration-state'
import type { PdfTranslationOwner } from './index'
import type { PdfTranslationWriter } from './writer'

const log = createLogger('pdf-translation-pdf-cache')
const maxPdf = 64 * 1024 ** 2
const maxHeader = 4 * 1024 ** 2
const maxDisk = 256 * 1024 ** 2
const lifetime = 30 * 24 * 60 * 60 * 1000
const magic = Buffer.from('OSPDFC1\n')
const digest = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')
const descriptor = z
  .object({
    source: z.union([z.string().min(1).max(256), pdfTranslationDocumentSourceSchema]),
    checkpointKey: z.string().uuid(),
    bypass: z.boolean().optional()
  })
  .strict()
const headerSchema = z
  .object({
    version: z.literal(1),
    cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    outputBytes: z.number().int().min(1).max(maxPdf),
    outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    unitCount: z.number().int().min(1).max(10000),
    layoutFailures: z
      .array(
        pdfTranslationLayoutFailureSchema.extend({
          unitIndex: z.number().int().min(0).max(9999)
        })
      )
      .max(10000)
  })
  .strict()
type Header = z.infer<typeof headerSchema>
type Render = Pick<PdfTranslationPdfRequest, 'pages' | 'units' | 'preserveUnsupported'>
type Identity = {
  source: PdfTranslationCheckpointRequest
  checkpointKey: string
  checksum: string
  sourceBytes: number
  render: Render
}
type Pending = Identity & {
  token: string
  requestId: string
  root: string
  cacheKey: string
  caller: ApplicationCallerLease
  result: PdfTranslationPdfResult
  bytes: number
  release: () => void
  confirming: boolean
  cancelled: boolean
  expiry: ReturnType<typeof setTimeout>
}
// ponytail: one process-wide file queue; split by root only if cache I/O becomes a bottleneck.
let files: Promise<unknown> = Promise.resolve()
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = files.then(() => withDataRootWrite(operation))
  files = result.catch(() => undefined)
  return result
}

/** Disposable derived PDFs. Managed source authorization is checked before every reuse/publication. */
export class PdfTranslationPdfCache {
  private readonly pending = new Map<string, Pending>()
  private readonly active = new Map<
    string,
    { caller: ApplicationCallerLease; cancelled: boolean }
  >()
  constructor(
    private readonly options: {
      root: () => string
      revision: () => Promise<string>
      owner: Pick<PdfTranslationOwner, 'readCheckpoint'>
      writer: Pick<PdfTranslationWriter, 'generateDetailed' | 'cancel' | 'valid'>
    }
  ) {}

  private current(root: string, caller: ApplicationCallerLease): boolean {
    return resolve(this.options.root()) === root && !caller.signal.aborted && caller.isCurrent()
  }

  private key(
    checkpoint: PdfTranslationCheckpoint,
    identity: Identity,
    revision: string
  ): string | null {
    if (
      !checkpoint.layoutSnapshot ||
      checkpoint.key !== identity.checkpointKey ||
      checkpoint.checksum !== identity.checksum ||
      checkpoint.sources.length !== identity.render.units.length ||
      checkpoint.translations.length !== checkpoint.sources.length ||
      checkpoint.translatedSourceIndices.length !== checkpoint.sources.length ||
      !checkpoint.sources.every(
        (source, i) =>
          checkpoint.translatedSourceIndices[i] === i &&
          source === identity.render.units[i].source &&
          checkpoint.translations[i] === identity.render.units[i].translation
      )
    )
      return null
    // Deliberately excludes source bindings: independently authorized sources may share an edition.
    return digest(
      JSON.stringify({
        sourceBytes: identity.sourceBytes,
        checksum: identity.checksum,
        key: checkpoint.key,
        revision: checkpoint.revision,
        layout: checkpoint.layoutSnapshot,
        language: checkpoint.language,
        model: checkpoint.model,
        glossary: checkpoint.glossary,
        targetKey: checkpoint.targetKey,
        render: identity.render,
        environment: revision
      })
    )
  }

  async generate(
    input: PdfTranslationPdfRequest,
    caller: ApplicationCallerLease
  ): Promise<PdfTranslationPdfResult | null> {
    caller.signal.throwIfAborted()
    if (!caller.isCurrent() || !this.options.writer.valid(input))
      return this.options.writer.generateDetailed(input, caller)
    if (this.active.size >= 2 || this.active.has(input.id))
      throw new PdfGenerationError({ code: 'busy' })
    const operation = { caller, cancelled: false }
    this.active.set(input.id, operation)
    const abort = (): void => this.cancel(input.id, caller)
    caller.signal.addEventListener('abort', abort, { once: true })
    const root = resolve(this.options.root())
    let identity: Identity | undefined
    let cacheKey: string | null = null
    try {
      const parsed = descriptor.safeParse(input.cache)
      if (parsed.success) {
        try {
          identity = {
            source: structuredClone(parsed.data.source),
            checkpointKey: parsed.data.checkpointKey,
            checksum: digest(input.data),
            sourceBytes: input.data.byteLength,
            render: structuredClone({
              pages: input.pages,
              units: input.units,
              preserveUnsupported: input.preserveUnsupported
            })
          }
          const checkpoint = await this.options.owner.readCheckpoint(
            identity.source,
            caller,
            identity.checkpointKey
          )
          if (checkpoint) cacheKey = this.key(checkpoint, identity, await this.options.revision())
          if (
            cacheKey &&
            !input.incremental &&
            !parsed.data.bypass &&
            this.current(root, caller) &&
            !operation.cancelled
          ) {
            const hit = await serialized(() => this.read(root, cacheKey!, input.units.length))
            if (hit && this.current(root, caller) && !operation.cancelled) {
              // Authorization may have changed while reading the disk file.
              const latest = await this.options.owner.readCheckpoint(
                identity.source,
                caller,
                identity.checkpointKey
              )
              if (
                latest &&
                this.key(latest, identity, await this.options.revision()) === cacheKey &&
                this.current(root, caller) &&
                !operation.cancelled
              ) {
                log.debug('PDF cache hit', {
                  requestId: input.id,
                  cacheKey,
                  checkpointKey: identity.checkpointKey,
                  outputBytes: hit.data.byteLength,
                  unitCount: input.units.length
                })
                return { ...hit, cacheHit: true }
              }
              cacheKey = null
            }
          }
        } catch {
          cacheKey = null
        }
      }
      if (operation.cancelled || caller.signal.aborted || !caller.isCurrent()) return null
      const result = await this.options.writer.generateDetailed(input, caller)
      if (!result || operation.cancelled || !this.current(root, caller)) return result
      if (!cacheKey || !identity || !this.safeResult(result, input.units.length)) return result
      const token = randomUUID()
      const bytes =
        result.data.byteLength +
        Buffer.byteLength(JSON.stringify(identity)) +
        Buffer.byteLength(JSON.stringify(result.layoutFailures))
      if (bytes > 128 * 1024 ** 2) return result
      while (
        this.pending.size >= 2 ||
        [...this.pending.values()].reduce((n, p) => n + p.bytes, bytes) > 128 * 1024 ** 2
      ) {
        const evictable = [...this.pending.values()].find((p) => !p.confirming)
        if (!evictable) return result
        this.drop(evictable.token)
      }
      const release = (): void => this.drop(token)
      caller.signal.addEventListener('abort', release, { once: true })
      const expiry = setTimeout(release, 5 * 60 * 1000)
      expiry.unref()
      this.pending.set(token, {
        ...identity,
        token,
        requestId: input.id,
        root,
        cacheKey,
        caller,
        bytes,
        release,
        expiry,
        confirming: false,
        cancelled: false,
        result: {
          data: Buffer.from(result.data),
          layoutFailures: headerSchema.shape.layoutFailures.parse(result.layoutFailures)
        }
      })
      return { ...result, cacheToken: token }
    } finally {
      caller.signal.removeEventListener('abort', abort)
      this.active.delete(input.id)
    }
  }

  private safeResult(result: PdfTranslationPdfResult, unitCount: number): boolean {
    if (
      !(result.data instanceof Uint8Array) ||
      !result.data.byteLength ||
      result.data.byteLength > maxPdf
    )
      return false
    const parsed = headerSchema.shape.layoutFailures.safeParse(result.layoutFailures)
    return (
      parsed.success &&
      new Set(parsed.data.map((f) => f.unitIndex)).size === parsed.data.length &&
      parsed.data.every(
        (f) =>
          f.unitIndex < unitCount &&
          ['planning', 'ownership', 'glyphs'].includes(f.phase) &&
          !['validation-failed', 'worker-failed', 'timeout'].includes(f.code)
      )
    )
  }

  private drop(token: string): void {
    const pending = this.pending.get(token)
    if (!pending) return
    pending.caller.signal.removeEventListener('abort', pending.release)
    clearTimeout(pending.expiry)
    pending.cancelled = true
    if (!pending.confirming) this.pending.delete(token)
  }

  cancel(id: string, caller: ApplicationCallerLease): void {
    const operation = this.active.get(id)
    if (operation?.caller === caller) operation.cancelled = true
    for (const pending of this.pending.values())
      if (pending.requestId === id && pending.caller === caller) this.drop(pending.token)
    this.options.writer.cancel(id, caller)
  }

  async confirm(
    input: PdfTranslationRecordLayoutRequest,
    caller: ApplicationCallerLease
  ): Promise<void> {
    const parsed = pdfTranslationRecordLayoutSchema.safeParse(input)
    if (!parsed.success || !parsed.data.pdfCacheToken) return
    const report = parsed.data
    const pending = this.pending.get(report.pdfCacheToken!)
    if (!pending || pending.caller !== caller || pending.confirming) return
    pending.confirming = true
    const current = (): boolean =>
      this.pending.get(pending.token) === pending &&
      !pending.cancelled &&
      this.current(pending.root, caller)
    try {
      if (
        !current() ||
        report.checkpointKey !== pending.checkpointKey ||
        pdfTranslationSourceKey(report.source) !== pdfTranslationSourceKey(pending.source) ||
        report.units.length !== pending.render.units.length
      )
        return
      const failures = new Map(
        pending.result.layoutFailures.map((f) => {
          const { unitIndex, ...failure } = f
          return [unitIndex, failure]
        })
      )
      if (
        !report.units.every(
          (unit, i) =>
            unit.sourceIndex === i &&
            unit.source === pending.render.units[i].source &&
            unit.translation === pending.render.units[i].translation &&
            JSON.stringify(unit.failure) === JSON.stringify(failures.get(i)) &&
            (!unit.failure || pending.render.preserveUnsupported === true)
        )
      )
        return
      await serialized(async () => {
        if (!current()) return
        const checkpoint = await this.options.owner.readCheckpoint(
          pending.source,
          caller,
          pending.checkpointKey
        )
        if (
          !checkpoint ||
          this.key(checkpoint, pending, await this.options.revision()) !== pending.cacheKey ||
          !current()
        )
          return
        await this.publish(pending, current)
      })
    } catch (error) {
      log.warn('PDF cache publication skipped', {
        error: error instanceof Error ? error.name : 'unknown'
      })
    } finally {
      pending.confirming = false
      this.drop(pending.token)
    }
  }

  private async directory(root: string, create: boolean): Promise<string> {
    // No cache operation follows a symlink in its managed directory chain.
    for (const path of [
      root,
      join(root, 'literature'),
      join(root, 'literature', 'pdf-translation-cache')
    ]) {
      if (create && path !== root)
        await mkdir(path).catch((error) => {
          if (error.code !== 'EEXIST') throw error
        })
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid cache directory')
    }
    if (resolve(this.options.root()) !== root) throw new Error('Data root changed')
    return join(root, 'literature', 'pdf-translation-cache')
  }

  private async read(
    root: string,
    cacheKey: string,
    unitCount: number
  ): Promise<PdfTranslationPdfResult | null> {
    try {
      const directory = await this.directory(root, false)
      const path = join(directory, `${cacheKey}.pdfcache`)
      const leaf = await lstat(path)
      if (!leaf.isFile() || leaf.isSymbolicLink()) return null
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (
          info.ino !== leaf.ino ||
          info.dev !== leaf.dev ||
          !info.isFile() ||
          info.size > maxPdf + maxHeader + 12 ||
          info.size < 13
        )
          return null
        const prefix = Buffer.alloc(12)
        if (
          (await file.read(prefix, 0, 12, 0)).bytesRead !== 12 ||
          !prefix.subarray(0, 8).equals(magic)
        )
          return null
        const size = prefix.readUInt32BE(8)
        if (size < 1 || size > maxHeader || size + 12 >= info.size) return null
        const metadata = Buffer.alloc(size)
        if ((await file.read(metadata, 0, size, 12)).bytesRead !== size) return null
        const header = headerSchema.parse(JSON.parse(metadata.toString('utf8')))
        if (
          header.cacheKey !== cacheKey ||
          header.unitCount !== unitCount ||
          header.createdAt > Date.now() ||
          Date.now() - header.createdAt > lifetime ||
          header.outputBytes + size + 12 !== info.size
        )
          return null
        const data = Buffer.alloc(header.outputBytes)
        if (
          (await file.read(data, 0, data.length, 12 + size)).bytesRead !== data.length ||
          digest(data) !== header.outputDigest
        )
          return null
        const result = { data, layoutFailures: header.layoutFailures }
        return this.safeResult(result, unitCount) ? result : null
      } finally {
        await file.close()
      }
    } catch {
      return null
    }
  }

  private async publish(pending: Pending, current: () => boolean): Promise<void> {
    const directory = await this.directory(pending.root, true)
    const header: Header = {
      version: 1,
      cacheKey: pending.cacheKey,
      createdAt: Date.now(),
      outputBytes: pending.result.data.byteLength,
      outputDigest: digest(pending.result.data),
      unitCount: pending.render.units.length,
      layoutFailures: [...pending.result.layoutFailures]
    }
    const metadata = Buffer.from(JSON.stringify(header))
    if (metadata.length > maxHeader) return
    const prefix = Buffer.alloc(12)
    magic.copy(prefix)
    prefix.writeUInt32BE(metadata.length, 8)
    const temporary = join(directory, `.${pending.cacheKey}.${randomUUID()}.tmp`)
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      try {
        await file.writeFile(prefix)
        await file.writeFile(metadata)
        await file.writeFile(pending.result.data)
        await file.sync()
      } finally {
        await file.close()
      }
      await this.directory(pending.root, false)
      if (!current()) return
      await this.clean(
        directory,
        `${pending.cacheKey}.pdfcache`,
        12 + metadata.length + pending.result.data.byteLength,
        temporary
      )
      if (!current()) return
      const latest = await this.options.owner.readCheckpoint(
        pending.source,
        pending.caller,
        pending.checkpointKey
      )
      if (
        !latest ||
        this.key(latest, pending, await this.options.revision()) !== pending.cacheKey ||
        !current()
      )
        return
      await rename(temporary, join(directory, `${pending.cacheKey}.pdfcache`))
      log.debug('PDF cache published', {
        requestId: pending.requestId,
        cacheKey: pending.cacheKey,
        checkpointKey: pending.checkpointKey,
        outputBytes: pending.result.data.byteLength,
        unitCount: pending.render.units.length
      })
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  private async clean(
    directory: string,
    replacing: string,
    incoming: number,
    temporary: string
  ): Promise<void> {
    const entries: { name: string; bytes: number; modified: number }[] = []
    for (const name of await readdir(directory)) {
      if (join(directory, name) === temporary) continue
      if (
        !/^[a-f0-9]{64}\.pdfcache$/.test(name) &&
        !/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name)
      )
        continue
      const info = await lstat(join(directory, name))
      if (!info.isFile() || info.isSymbolicLink()) continue
      // The process-wide queue leaves only this publication's protected temporary file active.
      if (name.endsWith('.tmp') || Date.now() - info.mtimeMs > lifetime)
        await unlink(join(directory, name))
      else if (name.endsWith('.pdfcache') && name !== replacing)
        entries.push({ name, bytes: info.size, modified: info.mtimeMs })
    }
    entries.sort((a, b) => a.modified - b.modified)
    let bytes = entries.reduce((n, entry) => n + entry.bytes, incoming)
    while (entries.length >= 16 || bytes > maxDisk) {
      const entry = entries.shift()
      if (!entry) break
      await unlink(join(directory, entry.name))
      bytes -= entry.bytes
    }
  }
}
