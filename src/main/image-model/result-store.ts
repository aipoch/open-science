import { createHash } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import {
  ImageModelError,
  ImageRequestConflictError,
  MAX_IMAGE_BYTES,
  type ImageModelRequest,
  type ImageModelResult
} from './contract'
import { imageModelErrorSchema } from '../../shared/image-model-error'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const reference = z.object({ artifactId: identity, versionId: identity }).strict()
const recordSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    result: z
      .object({
        mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        serviceId: z.string(),
        presetId: z.string(),
        model: z.string(),
        parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
        promptSha256: z.string().optional(),
        promptLength: z.number().optional(),
        generatedImages: z.number().optional(),
        usage: z
          .object({
            inputTokens: z.number(),
            outputTokens: z.number(),
            cacheTokens: z.number(),
            cachedReadTokens: z.number().optional(),
            cachedWriteTokens: z.number().optional(),
            turnCount: z.number().optional()
          })
          .optional()
      })
      .optional(),
    checksum: z.string().optional(),
    published: reference.optional(),
    error: imageModelErrorSchema.optional()
  })
  .strict()
type Context = ImageModelRequest['context']
type Record = z.infer<typeof recordSchema>
type PublishedVersion = z.infer<typeof reference>
type PublishedResultLease = Pick<
  ManagedFileReadLease,
  'size' | 'readRange' | 'verifyUnchanged' | 'close'
> & {
  logicalFile: Pick<ManagedFileReadLease['logicalFile'], 'sessionId'>
  version: Pick<ManagedFileReadLease['version'], 'checksum'>
}
type OpenPublishedResult = (
  context: Context,
  version: PublishedVersion
) => Promise<PublishedResultLease>
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

// Receipts contain only request identity and published Version metadata, never image bytes.
export class ImageResultStore {
  constructor(
    private readonly root: () => string,
    private readonly openPublishedResult: OpenPublishedResult
  ) {}
  private async path(context: Context, create = false): Promise<string | undefined> {
    identity.parse(context.projectId)
    identity.parse(context.sessionId)
    let directory = this.root()
    for (const part of ['artifacts', context.projectId, context.sessionId, '.image-results']) {
      directory = join(directory, part)
      if (create)
        await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (!stat) return undefined
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe image result directory.')
    }
    return join(directory, `${hash(context.invocationId)}.json`)
  }
  private async read(context: Context): Promise<Record | undefined> {
    const path = await this.path(context)
    if (!path) return undefined
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe image result record.')
    return recordSchema.parse(JSON.parse(await readFileWithinLimit(path, 65536)))
  }
  private async write(context: Context, record: Record, create = false): Promise<void> {
    const path = await this.path(context, create)
    if (!path) throw new Error('Image result owner was removed.')
    await writeDurableJsonFile(path, JSON.stringify(recordSchema.parse(record)))
  }
  async recover(
    context: Context,
    fingerprint?: string,
    delivery?: {
      signal: AbortSignal
      reserveDelivery: (bytes: number) => Promise<void> | undefined
    }
  ): Promise<ImageModelResult | undefined> {
    const record = await this.read(context)
    if (!record) return undefined
    if (fingerprint && record.fingerprint !== fingerprint) throw new ImageRequestConflictError()
    this.throwFailure(record)
    if (!record.result || !record.published)
      throw new ImageModelError(
        'OUTCOME_UNKNOWN',
        'The image request was submitted; do not repeat it automatically.'
      )
    let bytes: Buffer
    try {
      const lease = await this.openPublishedResult(context, record.published)
      try {
        if (
          lease.logicalFile.sessionId !== context.sessionId ||
          !record.checksum ||
          lease.version.checksum !== record.checksum ||
          lease.size > MAX_IMAGE_BYTES
        )
          throw new Error('Unexpected image Version metadata.')
        if (delivery) {
          await delivery.reserveDelivery(lease.size)
          delivery.signal.throwIfAborted()
        }
        const range = await lease.readRange(0, lease.size)
        bytes = Buffer.from(range.buffer, range.byteOffset, range.byteLength)
        await lease.verifyUnchanged()
        if (bytes.length !== lease.size || hash(bytes) !== record.checksum)
          throw new Error('Unexpected image Version bytes.')
      } finally {
        await lease.close()
      }
    } catch (error) {
      if (delivery?.signal.aborted && error === delivery.signal.reason) throw error
      throw new ImageModelError(
        'OUTCOME_UNKNOWN',
        'Stored image result integrity could not be verified.'
      )
    }
    return { ...record.result, bytes }
  }
  async inspectReceipt(context: Context): Promise<boolean> {
    const record = await this.read(context).catch(() => {
      throw new ImageModelError(
        'OUTCOME_UNKNOWN',
        'The stored image request could not be verified.'
      )
    })
    if (record) this.throwFailure(record)
    return Boolean(record)
  }

  private throwFailure(record: Record): void {
    if (!record.error) return
    const { code, httpStatus, ...diagnostics } = record.error
    throw new ImageModelError(code, 'The stored image request failed.', httpStatus, diagnostics)
  }

  async fail(context: Context, fingerprint: string, error: ImageModelError): Promise<void> {
    await this.write(context, { fingerprint, error: error.detail })
  }
  async begin(context: Context, fingerprint: string): Promise<void> {
    await this.write(context, { fingerprint }, true)
  }
  async published(
    context: Context,
    result: ImageModelResult,
    { artifactId, versionId }: PublishedVersion
  ): Promise<void> {
    const record = await this.read(context)
    if (!record) throw new Error('Image request receipt is unavailable.')
    const { bytes, ...metadata } = result
    await this.write(context, {
      fingerprint: record.fingerprint,
      result: metadata,
      checksum: hash(bytes),
      published: { artifactId, versionId }
    })
  }
}
