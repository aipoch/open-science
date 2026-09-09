import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'

type OpenedContent = {
  id: string
  path: string
  storageKey: string
  checksum: string
  sizeBytes: bigint
  contentType?: string
}

type ContentVerification =
  | { state: 'available'; content: OpenedContent }
  | {
      state: 'unavailable'
      reason:
        | 'missing-authority'
        | 'not-available'
        | 'missing'
        | 'not-file'
        | 'size-mismatch'
        | 'size-limit'
        | 'checksum-mismatch'
        | 'changed-during-verification'
    }

type ContentSweepReceipt = {
  removedIds: string[]
  retainedIds: string[]
  failedIds: string[]
}

type PublishContentRequest = {
  sourcePath: string
  contentType?: string
  commit?: (content: OpenedContent) => Promise<void>
}

type ContentRepositoryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
}

class ContentOpenError extends Error {
  constructor(
    readonly reason: Exclude<ContentVerification, { state: 'available' }>['reason'],
    message: string
  ) {
    super(message)
  }
}

const resolveContentStorageKey = (storageRoot: string, storageKey: string): string => {
  if (!storageKey || isAbsolute(storageKey) || storageKey.includes('\\')) {
    throw new Error('Invalid content storage key.')
  }
  const segments = storageKey.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid content storage key.')
  }
  const root = resolve(storageRoot)
  const candidate = resolve(root, ...segments)
  const relativePath = relative(root, candidate)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Invalid content storage key.')
  }
  return candidate
}

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const missingFile = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT'

const pathAlreadyExists = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'EEXIST'

const fileFingerprint = (file: Awaited<ReturnType<typeof stat>>): string =>
  [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':')

// Different repositories share the same immutable files. Keep a sweep's claim and unlink
// indivisible with publication so it cannot delete bytes that were just made available again.
const contentLifecycles = new Map<string, Promise<void>>()
// Reservations bridge publication and reference insertion without holding a database transaction.
// All content publishers and sweepers in the application process share these counts.
const pendingContentReferences = new Map<string, number>()
const contentLifecycleKey = (storageRoot: string, contentId: string): string =>
  JSON.stringify([resolve(storageRoot), contentId])

const withContentLifecycle = async <T>(
  storageRoot: string,
  contentId: string,
  operation: () => Promise<T>
): Promise<T> => {
  const key = contentLifecycleKey(storageRoot, contentId)
  const previous = contentLifecycles.get(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  contentLifecycles.set(key, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (contentLifecycles.get(key) === current) contentLifecycles.delete(key)
  }
}

class ContentRepository {
  private readonly verifiedContent = new Map<string, { fingerprint: string; checksum: string }>()

  constructor(private readonly options: ContentRepositoryOptions) {}

  async publish(request: PublishContentRequest): Promise<OpenedContent> {
    return this.publishContent(request)
  }

  async withPublishedContent<T>(
    request: PublishContentRequest,
    acquireReference: (content: OpenedContent) => Promise<T>
  ): Promise<T> {
    const content = await this.publishContent(request, true)
    const key = contentLifecycleKey(this.options.storageRoot, content.id)
    try {
      return await acquireReference(content)
    } finally {
      const remaining = pendingContentReferences.get(key)! - 1
      if (remaining) pendingContentReferences.set(key, remaining)
      else pendingContentReferences.delete(key)
    }
  }

  private async publishContent(
    request: PublishContentRequest,
    reserve = false
  ): Promise<OpenedContent> {
    const sourceBefore = await stat(request.sourcePath)
    if (!sourceBefore.isFile()) throw new Error('Content source is not a file.')
    const sourceFingerprint = fileFingerprint(sourceBefore)
    const checksum = await sha256File(request.sourcePath)
    if (fileFingerprint(await stat(request.sourcePath)) !== sourceFingerprint) {
      throw new Error('Content source changed while it was being read.')
    }

    const sizeBytes = BigInt(sourceBefore.size)
    const id = `sha256:${checksum}:${sizeBytes}`
    const storageKey = `content/blobs/${checksum.slice(0, 2)}/${checksum}`
    return withContentLifecycle(this.options.storageRoot, id, async () => {
      const retain = (content: OpenedContent): OpenedContent => {
        if (reserve) {
          const key = contentLifecycleKey(this.options.storageRoot, content.id)
          pendingContentReferences.set(key, (pendingContentReferences.get(key) ?? 0) + 1)
        }
        return content
      }
      const client = await this.options.getClient()
      const existing = await client.contentBlob.findUnique({ where: { id } })
      if (existing?.state === 'available') {
        const verification = await this.verifyLocked(id)
        if (verification.state === 'available') {
          await request.commit?.(verification.content)
          return retain(verification.content)
        }
      }

      try {
        await client.contentBlob.upsert({
          where: { id },
          create: {
            id,
            checksum,
            storageKey,
            sizeBytes,
            contentType: request.contentType,
            state: 'staging'
          },
          update: {
            storageKey,
            sizeBytes,
            contentType: request.contentType ?? existing?.contentType,
            state: 'staging',
            verifiedAt: null
          }
        })

        const destination = resolveContentStorageKey(this.options.storageRoot, storageKey)
        await mkdir(dirname(destination), { recursive: true })
        const temporary = `${destination}.${randomUUID()}.tmp`
        try {
          await copyFile(request.sourcePath, temporary)
          const copied = await stat(temporary)
          if (BigInt(copied.size) !== sizeBytes || (await sha256File(temporary)) !== checksum) {
            throw new Error('Published content did not match its source.')
          }
          await link(temporary, destination).catch(async (error: unknown) => {
            if (!pathAlreadyExists(error)) throw error
            const stored = await stat(destination)
            if (BigInt(stored.size) !== sizeBytes || (await sha256File(destination)) !== checksum) {
              // The staged copy is verified and publication holds the content lifecycle lock.
              // Replace corrupt bytes atomically without changing the shared content identity.
              await rename(temporary, destination)
            }
          })
        } finally {
          await rm(temporary, { force: true })
        }

        const destinationFile = await stat(destination)
        if (
          BigInt(destinationFile.size) !== sizeBytes ||
          (await sha256File(destination)) !== checksum
        ) {
          await this.quarantine(id)
          throw new Error('Published content failed integrity verification.')
        }
        await client.contentBlob.update({
          where: { id },
          data: {
            state: 'available',
            verifiedAt: new Date(),
            lastVerificationFailure: null,
            lastVerificationAttemptAt: new Date()
          }
        })
        this.verifiedContent.set(id, {
          fingerprint: fileFingerprint(destinationFile),
          checksum
        })
        const content = await this.open(id)
        await request.commit?.(content)
        return retain(content)
      } catch (error) {
        // Only this publisher can own a newly created row. Reused bytes may still be
        // awaiting another caller's reference, so never reclaim them on callback failure.
        if (!existing && request.commit) await this.removeUnreferenced(client, id)
        throw error
      }
    })
  }

  async open(contentId: string): Promise<OpenedContent> {
    return this.readContent(contentId)
  }

  private async readContent(contentId: string, retry = false): Promise<OpenedContent> {
    const client = await this.options.getClient()
    const blob = await client.contentBlob.findUnique({ where: { id: contentId } })
    if (!blob) {
      throw new ContentOpenError(
        'missing-authority',
        `Content blob authority is missing: ${contentId}`
      )
    }
    if (blob.state !== 'available' && !(retry && blob.state === 'quarantined')) {
      throw new ContentOpenError('not-available', `Content blob is not available: ${contentId}`)
    }
    const path = resolveContentStorageKey(this.options.storageRoot, blob.storageKey)
    const file = await stat(path).catch((error: unknown) => {
      if (missingFile(error)) {
        throw new ContentOpenError('missing', `Content blob bytes are missing: ${contentId}`)
      }
      throw error
    })
    if (!file.isFile()) {
      throw new ContentOpenError('not-file', `Content blob path is not a file: ${contentId}`)
    }
    if (BigInt(file.size) !== blob.sizeBytes) {
      throw new ContentOpenError(
        'size-mismatch',
        `Content blob size does not match its authority: ${contentId}`
      )
    }
    return {
      id: blob.id,
      path,
      storageKey: blob.storageKey,
      checksum: blob.checksum,
      sizeBytes: blob.sizeBytes,
      contentType: blob.contentType ?? undefined
    }
  }

  async verify(
    contentId: string,
    options: { maxBytes?: number; retry?: boolean } = {}
  ): Promise<ContentVerification> {
    return withContentLifecycle(this.options.storageRoot, contentId, () =>
      this.verifyLocked(contentId, options)
    )
  }

  private async verifyLocked(
    contentId: string,
    options: { maxBytes?: number; retry?: boolean } = {}
  ): Promise<ContentVerification> {
    const observe = async (failure: string | null): Promise<void> => {
      if (failure) this.verifiedContent.delete(contentId)
      const client = await this.options.getClient()
      await client.contentBlob.updateMany({
        where: { id: contentId },
        data: {
          lastVerificationFailure: failure,
          lastVerificationAttemptAt: new Date(),
          ...(failure === null ? { state: 'available', verifiedAt: new Date() } : {})
        }
      })
    }
    try {
      const content = await this.readContent(contentId, options.retry)
      if (options.maxBytes !== undefined && content.sizeBytes > BigInt(options.maxBytes)) {
        return { state: 'unavailable', reason: 'size-limit' }
      }
      const beforeRead = await stat(content.path)
      const fingerprint = fileFingerprint(beforeRead)
      const cached = this.verifiedContent.get(content.id)
      if (
        !options.retry &&
        cached?.fingerprint === fingerprint &&
        cached.checksum === content.checksum
      ) {
        return { state: 'available', content }
      }
      if ((await sha256File(content.path)) !== content.checksum) {
        await this.quarantine(contentId)
        await observe('checksum-mismatch')
        return { state: 'unavailable', reason: 'checksum-mismatch' }
      }
      if (fileFingerprint(await stat(content.path)) !== fingerprint) {
        await this.quarantine(contentId)
        await observe('changed-during-verification')
        return { state: 'unavailable', reason: 'changed-during-verification' }
      }
      this.verifiedContent.set(content.id, { fingerprint, checksum: content.checksum })
      await observe(null)
      return { state: 'available', content }
    } catch (error) {
      if (missingFile(error)) {
        await this.quarantine(contentId)
        await observe('missing')
        return { state: 'unavailable', reason: 'missing' }
      }
      if (!(error instanceof ContentOpenError)) throw error
      if (
        error.reason === 'missing' ||
        error.reason === 'not-file' ||
        error.reason === 'size-mismatch'
      ) {
        await this.quarantine(contentId)
      }
      // A refusal to open quarantined bytes must not erase the original diagnosis.
      if (error.reason !== 'not-available' && error.reason !== 'missing-authority') {
        await observe(error.reason)
      }
      return { state: 'unavailable', reason: error.reason }
    }
  }

  async sweep(request: {
    createdBefore: Date
    contentIds?: string[]
  }): Promise<ContentSweepReceipt> {
    const client = await this.options.getClient()
    if (request.contentIds?.length === 0) {
      return { removedIds: [], retainedIds: [], failedIds: [] }
    }
    const candidateWhere = {
      createdAt: { lt: request.createdBefore },
      ...(request.contentIds ? { id: { in: [...new Set(request.contentIds)] } } : {})
    }
    const candidates = await client.contentBlob.findMany({
      where: candidateWhere,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    if (candidates.length === 0) return { removedIds: [], retainedIds: [], failedIds: [] }
    const where = request.contentIds
      ? { contentBlobId: { in: candidates.map(({ id }) => id) } }
      : undefined
    const [uploadReferences, artifactReferences, literatureReferences, inboxReferences] =
      await Promise.all([
        client.uploadVersion.findMany({
          where: where ?? { contentBlobId: { not: null } },
          select: { contentBlobId: true }
        }),
        client.artifactVersion.findMany({
          where: where ?? { contentBlobId: { not: null } },
          select: { contentBlobId: true }
        }),
        client.literatureAttachmentVersion.findMany({ where, select: { contentBlobId: true } }),
        client.literatureInboxPdf.findMany({ where, select: { contentBlobId: true } })
      ])
    const referencedIds = new Set(
      [
        ...uploadReferences,
        ...artifactReferences,
        ...literatureReferences,
        ...inboxReferences
      ].flatMap((reference) => (reference.contentBlobId ? [reference.contentBlobId] : []))
    )
    const receipt: ContentSweepReceipt = { removedIds: [], retainedIds: [], failedIds: [] }

    for (const candidate of candidates) {
      if (referencedIds.has(candidate.id)) {
        receipt.retainedIds.push(candidate.id)
        continue
      }
      try {
        const removed = await withContentLifecycle(this.options.storageRoot, candidate.id, () =>
          this.removeUnreferenced(client, candidate.id, request.createdBefore)
        )
        if (removed) receipt.removedIds.push(candidate.id)
        else receipt.retainedIds.push(candidate.id)
      } catch {
        receipt.failedIds.push(candidate.id)
      }
    }
    return receipt
  }

  // Caller holds the content lifecycle lock through claim, unlink and authority removal.
  private async removeUnreferenced(
    client: PrismaClient,
    contentId: string,
    createdBefore?: Date
  ): Promise<boolean> {
    if (pendingContentReferences.has(contentLifecycleKey(this.options.storageRoot, contentId)))
      return false
    const claimed = await client.$transaction(async (transaction) => {
      const current = await transaction.contentBlob.findUnique({ where: { id: contentId } })
      if (!current || (createdBefore && current.createdAt >= createdBefore)) return undefined
      const counts = await Promise.all([
        transaction.uploadVersion.count({ where: { contentBlobId: contentId } }),
        transaction.artifactVersion.count({ where: { contentBlobId: contentId } }),
        transaction.literatureAttachmentVersion.count({ where: { contentBlobId: contentId } }),
        transaction.literatureInboxPdf.count({ where: { contentBlobId: contentId } })
      ])
      if (counts.some((count) => count > 0)) return undefined
      await transaction.contentBlob.update({
        where: { id: contentId },
        data: { state: 'quarantined' }
      })
      return current
    })
    if (!claimed) return false
    await rm(resolveContentStorageKey(this.options.storageRoot, claimed.storageKey), {
      force: true
    })
    await client.contentBlob.deleteMany({ where: { id: contentId, state: 'quarantined' } })
    this.verifiedContent.delete(contentId)
    return true
  }

  private async quarantine(contentId: string): Promise<void> {
    this.verifiedContent.delete(contentId)
    const client = await this.options.getClient()
    await client.contentBlob.updateMany({
      where: { id: contentId, state: 'available' },
      data: { state: 'quarantined' }
    })
  }
}

export { ContentRepository, resolveContentStorageKey }
export type { ContentSweepReceipt, ContentVerification, OpenedContent, PublishContentRequest }
