import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import type { OfficePreviewAdmissionError } from '../shared/office-preview'
import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ManagedPreviewSource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../shared/preview-resources'

const MAX_PREVIEW_RANGE_BYTES = 1024 * 1024
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
  resolvePath: (source: ManagedPreviewSource, request: { path: string }) => Promise<string>
  createId?: () => string
}

type AcquireManagedPreviewOptions = {
  snapshot: { size: number; version: number }
  maxBytes: number
}

type ResourceEntry = ManagedPreviewResource & {
  ownerId: number
  filePath: string
  strictSnapshot?: {
    dev: number
    ino: number
    maxBytes: number
  }
}

type PreviewProtocolResource =
  | Pick<ResourceEntry, 'filePath' | 'mimeType'>
  | {
      fileHandle: FileHandle
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

  async inspect(request: AcquireManagedPreviewRequest): Promise<{ size: number; version: number }> {
    // Resolve through the managed repository so metadata checks never accept an arbitrary path.
    const filePath = await this.options.resolvePath(request.source, { path: request.path })
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) throw new Error('Managed preview path is not a file.')

    return { size: fileStat.size, version: fileStat.mtimeMs }
  }

  async acquire(
    ownerId: number,
    request: AcquireManagedPreviewRequest,
    options?: AcquireManagedPreviewOptions
  ): Promise<ManagedPreviewResource> {
    // Resolve through the managed repository before minting an owner-scoped capability URL.
    const filePath = await this.options.resolvePath(request.source, { path: request.path })
    const fileStat = await stat(filePath)

    if (!fileStat.isFile()) {
      throw new Error('Managed preview path is not a file.')
    }
    if (options && fileStat.size > options.maxBytes) {
      const error: OfficePreviewAdmissionError = Object.assign(
        new Error('Managed preview file is too large.'),
        {
          code: 'FILE_TOO_LARGE' as const,
          size: fileStat.size,
          limit: options.maxBytes
        }
      )
      throw error
    }
    if (
      options &&
      (fileStat.size !== options.snapshot.size || fileStat.mtimeMs !== options.snapshot.version)
    ) {
      throw new Error('Managed preview file changed after admission.')
    }

    const id = this.createId()
    const resource: ManagedPreviewResource = {
      id,
      url: `${PREVIEW_SCHEME}://${id}/${encodeURIComponent(basename(filePath))}`,
      size: fileStat.size,
      mimeType: inferMimeType(filePath, request.mimeType),
      version: fileStat.mtimeMs
    }

    this.releasedOwners.delete(id)
    this.resources.set(id, {
      ...resource,
      ownerId,
      filePath,
      ...(options
        ? {
            strictSnapshot: {
              dev: fileStat.dev,
              ino: fileStat.ino,
              maxBytes: options.maxBytes
            }
          }
        : {})
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

    if (!resource.strictSnapshot) {
      return { filePath: resource.filePath, mimeType: resource.mimeType }
    }

    // Open first and fstat the same handle that will be streamed. Holding the handle pins the
    // admitted inode while the protocol caps the response to the approved byte count.
    const fileHandle = await open(resource.filePath, 'r')
    try {
      const fileStat = await fileHandle.stat()
      if (
        !fileStat.isFile() ||
        fileStat.size !== resource.size ||
        fileStat.size > resource.strictSnapshot.maxBytes ||
        fileStat.mtimeMs !== resource.version ||
        fileStat.dev !== resource.strictSnapshot.dev ||
        fileStat.ino !== resource.strictSnapshot.ino
      ) {
        this.revokeResource(resourceId, resource.ownerId)
        throw new Error('Managed preview file changed after capability creation.')
      }

      const verifyUnchanged = async (): Promise<void> => {
        const finalStat = await fileHandle.stat()
        if (
          !finalStat.isFile() ||
          finalStat.size !== resource.size ||
          finalStat.size > resource.strictSnapshot!.maxBytes ||
          finalStat.mtimeMs !== resource.version ||
          finalStat.dev !== resource.strictSnapshot!.dev ||
          finalStat.ino !== resource.strictSnapshot!.ino
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
    this.resources.delete(resourceId)
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
  ManagedPreviewResourcesOptions,
  PreviewProtocolResource
}
