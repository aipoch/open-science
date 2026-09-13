import {
  parsePdfStructureRequest,
  readPdfStructureThumbnailRequest
} from '../../../shared/pdf-structure'
import { z } from 'zod'
import type { ApplicationCallerLease } from '../../application-command-router'
import type { CallerContext } from '../../caller-context'
import { callerLeaseOwnershipKey } from '../../caller-lifecycle'
import type {
  ParsePdfStructureRequest,
  ReadPdfStructureThumbnailRequest,
  PdfStructureResult
} from '../../../shared/pdf-structure'
import type { PdfStructureOwner } from './owner'

const authorize = (caller: CallerContext, lease: ApplicationCallerLease): void => {
  if (
    caller.location !== 'local' ||
    !caller.isAuthorizationCurrent() ||
    !lease.isCurrent() ||
    lease.signal.aborted
  )
    throw new Error('Local PDF access is unavailable.')
}

export class PdfStructureReader {
  private readonly active = new Map<string, () => void>()
  constructor(private readonly owner: PdfStructureOwner) {}

  async parse(
    input: ParsePdfStructureRequest,
    caller: CallerContext,
    lease: ApplicationCallerLease
  ): Promise<PdfStructureResult> {
    authorize(caller, lease)
    const request = parsePdfStructureRequest.parse(input)
    const key = `${callerLeaseOwnershipKey(lease)}:${lease.generation}:${request.requestId}`
    if (this.active.has(key) || this.active.size >= 16)
      throw new Error('PDF request is already active or the queue is full.')
    const handle = this.owner.acquire(
      { kind: 'literature', attachmentVersionId: request.attachmentVersionId },
      [request.page],
      { signal: lease.signal }
    )
    this.active.set(key, handle.release)
    try {
      const result = await handle.result
      authorize(caller, lease)
      return result
    } finally {
      this.active.delete(key)
      handle.release()
    }
  }

  cancel(requestId: string, caller: CallerContext, lease: ApplicationCallerLease): void {
    authorize(caller, lease)
    z.string().uuid().parse(requestId)
    this.active.get(`${callerLeaseOwnershipKey(lease)}:${lease.generation}:${requestId}`)?.()
  }

  async readThumbnail(
    input: ReadPdfStructureThumbnailRequest,
    caller: CallerContext,
    lease: ApplicationCallerLease
  ): Promise<string | undefined> {
    authorize(caller, lease)
    const request = readPdfStructureThumbnailRequest.parse(input)
    const bytes = await this.owner.readThumbnail(
      { kind: 'literature', attachmentVersionId: request.attachmentVersionId },
      [request.page],
      request.extractionId,
      request.thumbnailId,
      lease.signal
    )
    authorize(caller, lease)
    return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : undefined
  }

  async clearCache(
    caller: CallerContext,
    lease: ApplicationCallerLease
  ): Promise<{ removedBytes: number; retainedEntries: number }> {
    authorize(caller, lease)
    const result = await this.owner.clearCache()
    authorize(caller, lease)
    return { removedBytes: result.removedBytes, retainedEntries: result.retained.length }
  }
}
