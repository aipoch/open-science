import { createHash } from 'node:crypto'
import { lstat, open, unlink } from 'node:fs/promises'

import type { SessionCatalog } from '../../session-persistence/coordinator'
import type { LiteratureAttachmentAuthority } from '../attachment-authority'
import { resolveCurrentPdfContext } from '../pdf-context'
import type {
  ResolvedSessionPdfVersion,
  SessionPdfSourceResolver
} from '../session-pdf-source-resolver'

export type PdfStructureSourceRequest =
  | Readonly<{ kind: 'literature'; attachmentVersionId: string }>
  | Readonly<{
      kind: 'session'
      projectId: string
      sessionId: string
      promptMessageId: string
      bindingId: string
    }>

type Dependencies = {
  literature: Pick<LiteratureAttachmentAuthority, 'resolveVersion'>
  sources: Pick<SessionPdfSourceResolver, 'resolveVersion'>
  sessions: Pick<SessionCatalog, 'loadSessionForContinuation'>
}

const unavailable = (): Error =>
  new Error('LINKED_PDF_UNAVAILABLE: The immutable PDF source is unavailable or has changed.')

const sameSource = (left: ResolvedSessionPdfVersion, right: ResolvedSessionPdfVersion): boolean =>
  left.sourceKind === right.sourceKind &&
  left.sourceFileId === right.sourceFileId &&
  left.sourceVersionId === right.sourceVersionId &&
  left.sourceSessionId === right.sourceSessionId &&
  left.sizeBytes === right.sizeBytes &&
  left.checksum === right.checksum

// Internal authority: callers supply source identities, never paths or checksums as access grants.
export class PdfStructureSourceAuthority {
  constructor(private readonly dependencies: Dependencies) {}

  async resolve(request: PdfStructureSourceRequest): Promise<ResolvedSessionPdfVersion> {
    let source: ResolvedSessionPdfVersion | undefined
    if (request.kind === 'literature') {
      const version = await this.dependencies.literature.resolveVersion(request.attachmentVersionId)
      if (version && version.versionId === request.attachmentVersionId) {
        source = {
          sourceKind: 'literature-attachment-version',
          sourceFileId: version.attachmentId,
          sourceVersionId: version.versionId,
          filename: version.filename,
          contentType: version.contentType,
          sizeBytes: version.sizeBytes,
          checksum: version.checksum,
          path: version.path
        }
      }
    } else {
      const context = await resolveCurrentPdfContext(this.dependencies.sessions, request)
      const binding = context.bindings.find(({ bindingId }) => bindingId === request.bindingId)
      if (!binding) throw unavailable()
      source = await this.dependencies.sources.resolveVersion({
        projectId: request.projectId,
        sourceKind: binding.sourceKind,
        sourceVersionId: binding.sourceVersionId,
        expectedSourceFileId: binding.sourceFileId
      })
      if (
        !source ||
        source.checksum !== binding.checksum ||
        source.sizeBytes !== binding.sizeBytes ||
        source.sourceKind !== binding.sourceKind ||
        source.sourceFileId !== binding.sourceFileId ||
        source.sourceVersionId !== binding.sourceVersionId ||
        source.sourceSessionId !== binding.sourceSessionId
      )
        throw unavailable()
    }
    if (
      !source ||
      !(
        source.contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
        source.filename.toLowerCase().endsWith('.pdf')
      ) ||
      !Number.isSafeInteger(source.sizeBytes) ||
      source.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(source.checksum)
    )
      throw unavailable()
    return source
  }

  async reauthorize(
    request: PdfStructureSourceRequest,
    expected: ResolvedSessionPdfVersion
  ): Promise<ResolvedSessionPdfVersion> {
    const current = await this.resolve(request)
    if (!sameSource(current, expected)) throw unavailable()
    return current
  }

  // destination is an owner-created staging path, not a renderer/tool argument. The caller holds
  // the job's data-root writer. Keep bounded reads and the source lease until validation completes.
  stage(
    request: PdfStructureSourceRequest,
    expected: ResolvedSessionPdfVersion,
    destination: string,
    signal: AbortSignal
  ): { ready: Promise<void>; dispose(): Promise<void> } {
    let lease:
      Awaited<ReturnType<NonNullable<ResolvedSessionPdfVersion['openContent']>>> | undefined
    let file: Awaited<ReturnType<typeof open>> | undefined
    let output: Awaited<ReturnType<typeof open>> | undefined
    let created = false
    const closeSource = async (): Promise<void> => {
      if (file) {
        await file.close()
        file = undefined
      }
      if (lease) {
        await lease.close()
        lease = undefined
      }
    }
    const ready = (async (): Promise<void> => {
      signal.throwIfAborted()
      const source = await this.reauthorize(request, expected)
      signal.throwIfAborted()
      lease = await source.openContent?.()
      if (!lease) {
        // Managed Artifact/Upload paths are only identity hints; never read them without a lease.
        if (source.sourceKind !== 'literature-attachment-version') throw unavailable()
        const before = await lstat(source.path)
        if (!before.isFile() || before.isSymbolicLink()) throw unavailable()
        file = await open(source.path, 'r')
        const opened = await file.stat()
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== source.sizeBytes
        )
          throw unavailable()
      }
      signal.throwIfAborted()
      output = await open(destination, 'wx', 0o600)
      created = true
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0
      while (true) {
        signal.throwIfAborted()
        if (lease && position === source.sizeBytes) break
        const length = Math.min(buffer.length, source.sizeBytes + 1 - position)
        let bytesRead: number
        if (lease) {
          const bytes = await lease.readRange(
            position,
            Math.min(position + length, source.sizeBytes)
          )
          bytesRead = bytes.byteLength
          if (bytesRead > length) throw unavailable()
          buffer.set(bytes)
        } else {
          bytesRead = (await file!.read(buffer, 0, length, position)).bytesRead
        }
        if (!bytesRead) break
        position += bytesRead
        if (position > source.sizeBytes) throw unavailable()
        hash.update(buffer.subarray(0, bytesRead))
        let written = 0
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written)
          if (!result.bytesWritten) throw new Error('PDF staging write made no progress.')
          written += result.bytesWritten
        }
      }
      if (position !== source.sizeBytes || hash.digest('hex') !== source.checksum)
        throw unavailable()
      await lease?.verifyUnchanged()
      await this.reauthorize(request, expected)
      signal.throwIfAborted()
      await output.close()
      output = undefined
      await closeSource()
    })()
    // Return ownership before any await. A failed close must remain retryable, including when the
    // copy is already complete. Never infer file ownership merely from the existence of a path.
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposing ??= (async () => {
        await ready.catch(() => undefined)
        if (output) {
          await output.close()
          output = undefined
        }
        await closeSource()
        if (created) {
          await unlink(destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
          created = false
        }
      })().finally(() => {
        disposing = undefined
      })
      return disposing
    }
    return { ready, dispose }
  }
}
