import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { FileObservationMismatchError, type FileObservation } from './bounded-file-io'
import type { OfficePreviewAdmissionError } from '../shared/office-preview'
import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../shared/preview-resources'
import type { ManagedFileReadLease } from './managed-file-versions/service'
import {
  exceedsDecodedImagePixelLimit,
  isPixelLimitedRasterMimeType,
  MAX_DECODED_IMAGE_PIXELS,
  readRasterImageDimensions,
  type RasterImageDimensions
} from './raster-image-safety'

const MAX_PREVIEW_RANGE_BYTES = 1024 * 1024
const MAX_IMAGE_HEADER_BYTES = 1024 * 1024
const MAX_RELEASED_RESOURCE_TOMBSTONES = 1024
const PREVIEW_SCHEME = 'open-science-preview'
const MANAGED_PREVIEW_SCHEME = {
  scheme: PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
} as const

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp'
}

// Accept only a valid MIME essence before exposing it as a response header.
const normalizeMimeType = (value: string | undefined): string | undefined => {
  const essence = value?.split(';', 1)[0]?.trim().toLowerCase()
  if (!essence || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence)) return undefined

  return essence === 'text/html' ? 'text/html; charset=utf-8' : essence
}

const inferMimeType = (filePath: string, fallback?: string): string =>
  MIME_TYPES_BY_EXTENSION[extname(filePath).toLowerCase()] ??
  normalizeMimeType(fallback) ??
  'application/octet-stream'

type ManagedPreviewResourcesOptions = {
  resolvePath: (
    source: 'local',
    request: Extract<AcquireManagedPreviewRequest, { source: 'local' }>
  ) => Promise<string>
  openLatestManagedFile?: (
    source: 'artifact' | 'upload',
    request: { projectId: string; fileId: string }
  ) => Promise<ManagedFileReadLease>
  openManagedFileVersion?: (
    source: 'artifact' | 'upload',
    request: { projectId: string; fileId: string; versionId: string }
  ) => Promise<ManagedFileReadLease>
  openNotebookInput?: (
    request: Extract<AcquireManagedPreviewRequest, { source: 'notebook-input' }>
  ) => Promise<ManagedPreviewTrustedLease>
  createId?: () => string
}

type ManagedPreviewTrustedLease = Pick<
  ManagedFileReadLease,
  'path' | 'size' | 'versionToken' | 'snapshot' | 'read' | 'readRange' | 'verifyUnchanged' | 'close'
>

type ManagedPreviewResourceSnapshot = {
  size: number
  version: number
  dev: bigint
  ino: bigint
  mtimeNs: bigint
}

type AcquireManagedPreviewOptions = {
  snapshot: ManagedPreviewResourceSnapshot
  maxBytes: number
}

type ResourceEntry = ManagedPreviewResource & {
  ownerId: number
  filePath: string
  trustedLease?: ManagedPreviewTrustedLease
  strictSnapshot?: {
    dev: bigint
    ino: bigint
    mtimeNs: bigint
    maxBytes: number
  }
  strictObservation?: FileObservation & { maxBytes: number }
}

type PreviewProtocolFileHandle = RangeReader & { close: () => Promise<void> }

type PreviewProtocolResource =
  | Pick<ResourceEntry, 'filePath' | 'mimeType'>
  | {
      fileHandle: PreviewProtocolFileHandle
      mimeType: string
      size: number
      verifyUnchanged: () => Promise<void>
    }

type RangeReader = {
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>
}

const snapshotFileStat = (fileStat: BigIntStats): ManagedPreviewResourceSnapshot => {
  if (fileStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Managed preview file size cannot be represented safely.')
  }

  return {
    size: Number(fileStat.size),
    version: Number(fileStat.mtimeNs) / 1_000_000,
    dev: fileStat.dev,
    ino: fileStat.ino,
    mtimeNs: fileStat.mtimeNs
  }
}

const readExactRange = async (
  reader: RangeReader,
  buffer: Uint8Array,
  position: number
): Promise<void> => {
  let totalBytesRead = 0

  // FileHandle.read may return a short read; EOF before the buffer is full means the file changed.
  while (totalBytesRead < buffer.byteLength) {
    const { bytesRead } = await reader.read(
      buffer,
      totalBytesRead,
      buffer.byteLength - totalBytesRead,
      position + totalBytesRead
    )
    if (bytesRead <= 0) throw new Error('Managed preview file changed during the range read.')
    totalBytesRead += bytesRead
  }
}

// Stores capability metadata only; file bytes remain on disk until a protocol or range read occurs.
class ManagedPreviewResources {
  private readonly resources = new Map<string, ResourceEntry>()
  private readonly releasedOwners = new Map<string, number>()
  private readonly createId: () => string

  constructor(private readonly options: ManagedPreviewResourcesOptions) {
    this.createId = options.createId ?? randomUUID
  }

  async inspect(request: AcquireManagedPreviewRequest): Promise<ManagedPreviewResourceSnapshot> {
    const trustedLease = await this.openTrustedLease(request)
    if (trustedLease) {
      try {
        return {
          size: trustedLease.size,
          version: trustedLease.versionToken,
          dev: trustedLease.snapshot.dev,
          ino: trustedLease.snapshot.ino,
          mtimeNs: trustedLease.snapshot.mtimeNs
        }
      } finally {
        await trustedLease.close()
      }
    }
    if (request.source === 'artifact' || request.source === 'upload') {
      throw new Error('Managed preview Version lease is unavailable.')
    }
    if (request.source !== 'local') throw new Error('Managed preview lease is unavailable.')
    // Path-backed sources still resolve through their source-specific trust boundary.
    const filePath = await this.options.resolvePath('local', request)
    const fileStat = await stat(filePath, { bigint: true })
    if (!fileStat.isFile()) throw new Error('Managed preview path is not a file.')

    return snapshotFileStat(fileStat)
  }

  async acquire(
    ownerId: number,
    request: AcquireManagedPreviewRequest,
    options?: AcquireManagedPreviewOptions
  ): Promise<ManagedPreviewResource> {
    const trustedLease = await this.openTrustedLease(request)
    let admitted = false
    try {
      // Resolve through the managed repository before minting an owner-scoped capability URL.
      const filePath = trustedLease
        ? trustedLease.path
        : request.source === 'artifact' || request.source === 'upload'
          ? (() => {
              throw new Error('Managed preview Version lease is unavailable.')
            })()
          : request.source === 'local'
            ? await this.options.resolvePath('local', request)
            : (() => {
                throw new Error('Managed preview lease is unavailable.')
              })()
      const fileSnapshot = trustedLease
        ? {
            size: trustedLease.size,
            version: trustedLease.versionToken,
            dev: trustedLease.snapshot.dev,
            ino: trustedLease.snapshot.ino,
            mtimeNs: trustedLease.snapshot.mtimeNs
          }
        : await stat(filePath, { bigint: true }).then((fileStat) => {
            if (!fileStat.isFile()) throw new Error('Managed preview path is not a file.')
            return snapshotFileStat(fileStat)
          })
      if (options && fileSnapshot.size > options.maxBytes) {
        const error: OfficePreviewAdmissionError = Object.assign(
          new Error('Managed preview file is too large.'),
          {
            code: 'FILE_TOO_LARGE' as const,
            size: fileSnapshot.size,
            limit: options.maxBytes
          }
        )
        throw error
      }
      if (
        options &&
        (fileSnapshot.size !== options.snapshot.size ||
          fileSnapshot.mtimeNs !== options.snapshot.mtimeNs ||
          fileSnapshot.dev !== options.snapshot.dev ||
          fileSnapshot.ino !== options.snapshot.ino)
      ) {
        throw new Error('Managed preview file changed after admission.')
      }

      const mimeType = inferMimeType(filePath, request.mimeType)
      // Reused below as the resource's width/height, so consumers learn the exact geometry from
      // the same header read that enforces the decoded-pixel limit.
      let imageDimensions: RasterImageDimensions | undefined
      if (isPixelLimitedRasterMimeType(mimeType)) {
        const headerLength = Math.min(fileSnapshot.size, MAX_IMAGE_HEADER_BYTES)
        let header: Buffer
        if (trustedLease) {
          const bytes = await trustedLease.readRange(0, headerLength)
          if (bytes.byteLength !== headerLength) {
            throw new Error('Image preview changed while reading its dimensions.')
          }
          header = Buffer.from(bytes)
          await trustedLease.verifyUnchanged()
        } else {
          const fileHandle = await open(filePath, 'r')
          try {
            const before = snapshotFileStat(await fileHandle.stat({ bigint: true }))
            if (
              before.size !== fileSnapshot.size ||
              before.mtimeNs !== fileSnapshot.mtimeNs ||
              before.dev !== fileSnapshot.dev ||
              before.ino !== fileSnapshot.ino
            ) {
              throw new Error('Image preview changed before reading its dimensions.')
            }
            header = Buffer.allocUnsafe(headerLength)
            if (headerLength > 0) await readExactRange(fileHandle, header, 0)
            const after = snapshotFileStat(await fileHandle.stat({ bigint: true }))
            if (
              after.size !== fileSnapshot.size ||
              after.mtimeNs !== fileSnapshot.mtimeNs ||
              after.dev !== fileSnapshot.dev ||
              after.ino !== fileSnapshot.ino
            ) {
              throw new Error('Image preview changed while reading its dimensions.')
            }
          } finally {
            await fileHandle.close()
          }
        }
        const dimensions = readRasterImageDimensions(header, mimeType)
        if (!dimensions) throw new Error('Could not read image preview dimensions safely.')
        if (exceedsDecodedImagePixelLimit(dimensions)) {
          throw new Error(
            `Image preview exceeds the ${MAX_DECODED_IMAGE_PIXELS.toLocaleString('en-US')}-pixel limit.`
          )
        }
        imageDimensions = dimensions
      }

      const id = this.createId()
      const resource: ManagedPreviewResource = {
        id,
        url: `${PREVIEW_SCHEME}://${id}/${encodeURIComponent(basename(filePath))}`,
        size: fileSnapshot.size,
        mimeType,
        version: fileSnapshot.version,
        ...(imageDimensions ? { width: imageDimensions.width, height: imageDimensions.height } : {})
      }

      this.releasedOwners.delete(id)
      this.resources.set(id, {
        ...resource,
        ownerId,
        filePath,
        ...(trustedLease ? { trustedLease } : {}),
        ...(options
          ? {
              strictSnapshot: {
                dev: options.snapshot.dev,
                ino: options.snapshot.ino,
                mtimeNs: options.snapshot.mtimeNs,
                maxBytes: options.maxBytes
              }
            }
          : {})
      })
      admitted = true
      return resource
    } finally {
      if (trustedLease && !admitted) await trustedLease.close()
    }
  }

  // This main-process-only seam accepts a path already resolved and scope-checked by Reviewer.
  async acquireResolvedFile(
    ownerId: number,
    request: {
      path: string
      mimeType?: string
      verifiedObservation: FileObservation
      verifiedChecksum: string
    },
    maxBytes: number
  ): Promise<ManagedPreviewResource> {
    const observedStat = await stat(request.path)
    const expected = request.verifiedObservation
    if (
      observedStat.dev !== expected.device ||
      observedStat.ino !== expected.inode ||
      observedStat.size !== expected.sizeBytes ||
      observedStat.mtimeMs !== expected.modifiedAtMs ||
      observedStat.ctimeMs !== expected.changedAtMs
    ) {
      throw new FileObservationMismatchError(
        `Verified Reviewer artifact changed before preview admission (${request.verifiedChecksum}).`
      )
    }
    if (!observedStat.isFile()) throw new Error('Managed preview path is not a file.')
    if (expected.sizeBytes > maxBytes) {
      const error: OfficePreviewAdmissionError = Object.assign(
        new Error('Managed preview file is too large.'),
        { code: 'FILE_TOO_LARGE' as const, size: expected.sizeBytes, limit: maxBytes }
      )
      throw error
    }

    const id = this.createId()
    const resource: ManagedPreviewResource = {
      id,
      url: `${PREVIEW_SCHEME}://${id}/${encodeURIComponent(basename(request.path))}`,
      size: expected.sizeBytes,
      mimeType: inferMimeType(request.path, request.mimeType),
      version: expected.modifiedAtMs
    }
    this.releasedOwners.delete(id)
    this.resources.set(id, {
      ...resource,
      ownerId,
      filePath: request.path,
      strictObservation: { ...expected, maxBytes }
    })
    return resource
  }

  async readRange(
    ownerId: number,
    request: ReadManagedPreviewRangeRequest
  ): Promise<ManagedPreviewRangeResult> {
    // IPC reads are intentionally bounded so PDF.js cannot transfer an entire large file at once.
    const resource = this.getOwnedResource(ownerId, request.resourceId)
    const { begin, end } = request

    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin) {
      throw new Error('Invalid managed preview range.')
    }
    if (end > resource.size) {
      throw new Error('Managed preview range is outside the file.')
    }
    if (end - begin > MAX_PREVIEW_RANGE_BYTES) {
      throw new Error('Managed preview range exceeds the maximum size.')
    }

    if (resource.trustedLease) {
      const data = await resource.trustedLease.readRange(begin, end)
      return { begin, end, total: resource.size, data: new Uint8Array(data) }
    }

    const buffer = Buffer.allocUnsafe(end - begin)
    const fileHandle = await open(resource.filePath, 'r')
    try {
      await readExactRange(fileHandle, buffer, begin)

      return {
        begin,
        end,
        total: resource.size,
        data: new Uint8Array(buffer)
      }
    } finally {
      await fileHandle.close()
    }
  }

  release(ownerId: number, request: ReleaseManagedPreviewRequest): void {
    const resource = this.resources.get(request.resourceId)
    if (!resource) {
      if (this.releasedOwners.get(request.resourceId) === ownerId) return
      throw new Error('Managed preview resource is not available.')
    }
    if (resource.ownerId !== ownerId) {
      throw new Error('Managed preview resource is not available.')
    }
    this.revokeResource(request.resourceId, resource.ownerId)
  }

  releaseOwner(ownerId: number): void {
    // Renderer teardown is the final backstop for resources not released by React cleanup.
    for (const [resourceId, resource] of this.resources) {
      if (resource.ownerId === ownerId) this.revokeResource(resourceId, ownerId)
    }
    for (const [resourceId, releasedOwnerId] of this.releasedOwners) {
      if (releasedOwnerId === ownerId) this.releasedOwners.delete(resourceId)
    }
  }

  async resolveProtocolResource(resourceId: string): Promise<PreviewProtocolResource> {
    // Protocol access uses the unguessable resource id and never accepts a renderer-supplied path.
    const resource = this.resources.get(resourceId)

    if (!resource) {
      throw new Error('Managed preview resource is not available.')
    }

    if (resource.trustedLease) {
      return {
        fileHandle: {
          read: (buffer, offset, length, position) =>
            resource.trustedLease!.read(buffer, offset, length, position),
          // One capability may serve several concurrent HTTP range requests. The resource owner,
          // not an individual response, closes the pinned handle.
          close: async () => undefined
        },
        mimeType: resource.mimeType,
        size: resource.size,
        verifyUnchanged: () => resource.trustedLease!.verifyUnchanged()
      }
    }

    if (!resource.strictSnapshot && !resource.strictObservation) {
      return { filePath: resource.filePath, mimeType: resource.mimeType }
    }

    // Open first and fstat the same handle that will be streamed. Holding the handle pins the
    // admitted inode while the protocol caps the response to the approved byte count.
    const fileHandle = await open(resource.filePath, 'r')
    try {
      const observation = resource.strictObservation
      if (observation) {
        const fileStat = await fileHandle.stat()
        if (
          !fileStat.isFile() ||
          fileStat.dev !== observation.device ||
          fileStat.ino !== observation.inode ||
          fileStat.size !== observation.sizeBytes ||
          fileStat.size > observation.maxBytes ||
          fileStat.mtimeMs !== observation.modifiedAtMs ||
          fileStat.ctimeMs !== observation.changedAtMs
        ) {
          this.revokeResource(resourceId, resource.ownerId)
          throw new FileObservationMismatchError(
            'Verified Reviewer artifact changed after preview admission.'
          )
        }
        const verifyUnchanged = async (): Promise<void> => {
          const finalStat = await fileHandle.stat()
          if (
            !finalStat.isFile() ||
            finalStat.dev !== observation.device ||
            finalStat.ino !== observation.inode ||
            finalStat.size !== observation.sizeBytes ||
            finalStat.size > observation.maxBytes ||
            finalStat.mtimeMs !== observation.modifiedAtMs ||
            finalStat.ctimeMs !== observation.changedAtMs
          ) {
            this.revokeResource(resourceId, resource.ownerId)
            throw new FileObservationMismatchError(
              'Verified Reviewer artifact changed during protocol streaming.'
            )
          }
        }
        return {
          fileHandle,
          mimeType: resource.mimeType,
          size: resource.size,
          verifyUnchanged
        }
      }

      const strictSnapshot = resource.strictSnapshot!
      const fileStat = await fileHandle.stat({ bigint: true })
      if (
        !fileStat.isFile() ||
        fileStat.size !== BigInt(resource.size) ||
        fileStat.size > BigInt(strictSnapshot.maxBytes) ||
        fileStat.mtimeNs !== strictSnapshot.mtimeNs ||
        fileStat.dev !== strictSnapshot.dev ||
        fileStat.ino !== strictSnapshot.ino
      ) {
        this.revokeResource(resourceId, resource.ownerId)
        throw new Error('Managed preview file changed after capability creation.')
      }

      const verifyUnchanged = async (): Promise<void> => {
        const finalStat = await fileHandle.stat({ bigint: true })
        if (
          !finalStat.isFile() ||
          finalStat.size !== BigInt(resource.size) ||
          finalStat.size > BigInt(strictSnapshot.maxBytes) ||
          finalStat.mtimeNs !== strictSnapshot.mtimeNs ||
          finalStat.dev !== strictSnapshot.dev ||
          finalStat.ino !== strictSnapshot.ino
        ) {
          this.revokeResource(resourceId, resource.ownerId)
          throw new Error('Managed preview file changed during protocol streaming.')
        }
      }

      return {
        fileHandle,
        mimeType: resource.mimeType,
        size: resource.size,
        verifyUnchanged
      }
    } catch (error) {
      await fileHandle.close()
      throw error
    }
  }

  private revokeResource(resourceId: string, ownerId: number): void {
    const resource = this.resources.get(resourceId)
    this.resources.delete(resourceId)
    if (resource?.trustedLease) void resource.trustedLease.close().catch(() => undefined)
    this.releasedOwners.set(resourceId, ownerId)
    while (this.releasedOwners.size > MAX_RELEASED_RESOURCE_TOMBSTONES) {
      const oldestResourceId = this.releasedOwners.keys().next().value
      if (oldestResourceId === undefined) break
      this.releasedOwners.delete(oldestResourceId)
    }
  }

  private getOwnedResource(ownerId: number, resourceId: string): ResourceEntry {
    const resource = this.resources.get(resourceId)

    if (!resource || resource.ownerId !== ownerId) {
      throw new Error('Managed preview resource is not available.')
    }

    return resource
  }

  private openTrustedLease(
    request: AcquireManagedPreviewRequest
  ): Promise<ManagedPreviewTrustedLease | undefined> {
    if (request.source === 'notebook-input') {
      if (!this.options.openNotebookInput) {
        return Promise.reject(new Error('Notebook input preview lease is not configured.'))
      }
      return this.options.openNotebookInput(request)
    }
    if (request.source !== 'artifact' && request.source !== 'upload') {
      return Promise.resolve(undefined)
    }
    if (!request.projectId?.trim() || !request.fileId?.trim()) {
      return Promise.reject(new Error('Managed preview requires a logical identity.'))
    }
    if (request.versionId) {
      if (!this.options.openManagedFileVersion) {
        return Promise.reject(new Error('Managed preview Version lease is not configured.'))
      }
      return this.options.openManagedFileVersion(request.source, {
        projectId: request.projectId,
        fileId: request.fileId,
        versionId: request.versionId
      })
    }
    if (!this.options.openLatestManagedFile) {
      return Promise.reject(new Error('Managed preview Version lease is not configured.'))
    }
    return this.options.openLatestManagedFile(request.source, {
      projectId: request.projectId,
      fileId: request.fileId
    })
  }
}

export {
  MANAGED_PREVIEW_SCHEME,
  ManagedPreviewResources,
  MAX_PREVIEW_RANGE_BYTES,
  PREVIEW_SCHEME,
  readExactRange
}
export type {
  AcquireManagedPreviewOptions,
  ManagedPreviewResourceSnapshot,
  ManagedPreviewResourcesOptions,
  PreviewProtocolResource
}
