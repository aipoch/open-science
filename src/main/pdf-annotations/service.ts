import type { PersistedChatSession } from '../../shared/session-persistence'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../shared/uploads'
import { createLiteratureAttachmentVersionReference } from '../../shared/literature'
import type { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { PdfAnnotationScope, PdfAnnotationSource } from '../../shared/pdf-annotations'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { SetTagAssignmentRequest } from '../../shared/tags'
import {
  createPdfAnnotationRequestSchema,
  updatePdfAnnotationRequestSchema
} from '../../shared/pdf-annotations'
import type { PdfAnnotationRepository } from './repository'
import type { BookmarkPdfSourceResult } from '../../shared/bookmarks'
import type { SessionAuthority } from '../bookmarks/service'
import type { ResolvedSessionPdfVersion } from '../literature/session-pdf-source-resolver'
import {
  parseNativePdfAnnotations,
  nativeImportReceipt,
  type NativePdfAnnotationProgress
} from './native-import'
import type {
  CreatePdfAnnotationRequest,
  DeletePdfAnnotationRequest,
  ListPdfAnnotationsRequest,
  UpdatePdfAnnotationRequest,
  PdfAnnotation,
  PdfReconcileRequest,
  PdfSharingPreview,
  PdfAnnotationListResult,
  DeletePdfAnnotationResult,
  PdfNativeAnnotationCancelRequest,
  PdfNativeAnnotationImportProgress,
  PdfNativeAnnotationImportRequest,
  PdfNativeAnnotationImportResult
} from '../../shared/pdf-annotations'

const log = createLogger('pdf-annotations')

const isPdfVersion = (version: { filename: string; contentType?: string }): boolean =>
  version.contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/pdf' ||
  version.filename.toLowerCase().endsWith('.pdf')

type Options = Readonly<{
  repository: Pick<
    PdfAnnotationRepository,
    | 'get'
    | 'list'
    | 'create'
    | 'recoverCreate'
    | 'update'
    | 'delete'
    | 'createMany'
    | 'nativeImportReceipt'
    | 'registerVerifiedSource'
    | 'reconcileSource'
  >
  literature: Pick<LiteratureAttachmentAuthority, 'resolveVersion' | 'openContent'>
  packageNotes?: (request: ListPdfAnnotationsRequest) => Promise<PdfAnnotationListResult>
  sessions: SessionAuthority
  runWithSessionAuthority: <T>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<T>
  ) => Promise<T>
  resolveSessionPdfVersion: (
    request: Pick<
      PdfNativeAnnotationImportRequest,
      'projectId' | 'sourceKind' | 'sourceFileId' | 'versionId'
    >
  ) => Promise<ResolvedSessionPdfVersion | undefined>
  onNativeImportProgress?: (progress: PdfNativeAnnotationImportProgress) => void
}>
const projectDocumentSource = (
  projectId: string,
  resolved: ResolvedSessionPdfVersion & { sourceKind: 'upload-version' | 'artifact-version' }
): PdfAnnotationSource & { projectId: string } => ({
  kind: resolved.sourceKind,
  projectId,
  sessionId: resolved.sourceSessionId,
  sourceFileId: resolved.sourceFileId,
  versionId: resolved.sourceVersionId,
  checksum: resolved.checksum,
  name: resolved.filename,
  path:
    resolved.sourceKind === 'upload-version'
      ? createUploadVersionReference(resolved.sourceVersionId, {
          projectId,
          sessionId: resolved.sourceSessionId,
          fileId: resolved.sourceFileId
        })
      : createArtifactVersionLocator({
          projectId,
          appSessionId: resolved.sourceSessionId,
          artifactId: resolved.sourceFileId,
          versionId: resolved.sourceVersionId
        })
})

class PdfAnnotationService {
  private readonly shutdown = new AbortController()
  private readonly pendingImports = new Set<Promise<PdfNativeAnnotationImportResult>>()
  private readonly nativeImports = new Map<string, AbortController>()
  private readonly completedNativeImports = new Map<
    string,
    Omit<PdfNativeAnnotationImportResult, 'operationId'>
  >()

  constructor(private readonly options: Options) {}

  private async requireSession(
    projectId: string,
    sessionId: string,
    writable: boolean
  ): Promise<PersistedChatSession> {
    const loaded = await this.options.sessions.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status !== 'found' || loaded.session.projectId !== projectId)
      throw new Error('Session not available.')
    if (writable && loaded.session.packageOrigin)
      throw new Error('Imported Sessions are read-only.')
    return loaded.session
  }

  private async prepareSource(
    source: PdfAnnotationSource,
    lease: { path: string; size: number },
    signal = this.shutdown.signal
  ): Promise<void> {
    if (await this.options.repository.registerVerifiedSource(source, lease.size)) {
      const parsed = await parseNativePdfAnnotations(lease.path, { signal }).catch((error) => {
        signal.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
        // Keep historical groups pending: a failed parse is not an empty native baseline.
        log.warn(
          'Could not prepare native PDF annotation reconciliation',
          diagnosticErrorFields(error)
        )
        return undefined
      })
      signal.throwIfAborted()
      if (!parsed) return
      await this.options.repository.reconcileSource(source, lease.size, parsed.annotations)
    }
  }

  private async librarySource(versionId: string): Promise<PdfAnnotationSource> {
    const version = await this.options.literature.resolveVersion(versionId)
    if (!version || version.versionId !== versionId || !isPdfVersion(version))
      throw new Error('PDF annotation source is not available.')
    const source: PdfAnnotationSource = {
      kind: 'literature-attachment-version',
      sourceFileId: version.attachmentId,
      versionId,
      checksum: version.checksum,
      name: version.filename,
      path: createLiteratureAttachmentVersionReference(versionId)
    }
    const lease = await this.options.literature.openContent(versionId)
    try {
      await lease.verifyUnchanged()
      await this.prepareSource(source, lease)
    } finally {
      await lease.close()
    }
    return source
  }

  private withScope<T>(scope: PdfAnnotationScope, operation: () => Promise<T>): Promise<T> {
    if (scope.literatureVersionId) return operation()
    if (!scope.projectId) return Promise.reject(new Error('PDF annotation scope is not available.'))
    if (!scope.sessionId) return operation()
    return this.options.runWithSessionAuthority(scope.projectId, scope.sessionId, async () => {
      await this.requireSession(scope.projectId!, scope.sessionId!, true)
      return operation()
    })
  }

  async list(request: ListPdfAnnotationsRequest): Promise<PdfAnnotationListResult> {
    if (request.literatureVersionId) {
      const source = await this.librarySource(request.literatureVersionId)
      return { ...(await this.options.repository.list(request)), source }
    }
    const session = request.sessionId
      ? await this.requireSession(request.projectId!, request.sessionId, false)
      : undefined
    if (session?.packageOrigin) {
      const snapshot = (await this.options.packageNotes?.(request)) ?? { items: [], total: 0 }
      return { ...snapshot, readOnly: true }
    }
    const current = await this.options.repository.list(request)
    if (!session?.forkOrigin || !this.options.packageNotes) return current
    const snapshot = await this.options.packageNotes(request)
    const candidates = [...current.items, ...snapshot.items].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    )
    const items = candidates.slice(0, request.limit ?? 50)
    const last =
      candidates.length > items.length || current.nextCursor || snapshot.nextCursor
        ? items.at(-1)
        : undefined
    return {
      ...current,
      items,
      total: current.total + snapshot.total,
      nativeImport: current.nativeImport ?? snapshot.nativeImport,
      snapshotTags: snapshot.snapshotTags,
      readonlyIds: items
        .filter((note) => snapshot.readonlyIds?.includes(note.id))
        .map((note) => note.id),
      nextCursor: last ? { createdAt: last.createdAt, id: last.id } : undefined
    }
  }

  private async resolveDocumentSource(
    source: PdfAnnotationSource
  ): Promise<BookmarkPdfSourceResult> {
    if (!source.projectId || source.kind === 'literature-attachment-version')
      return { ok: false, reason: 'source-unavailable' }
    const resolved = await this.options.resolveSessionPdfVersion({
      projectId: source.projectId,
      sourceKind: source.kind,
      sourceFileId: source.sourceFileId,
      versionId: source.versionId
    })
    if (
      !resolved?.openContent ||
      resolved.sourceKind !== source.kind ||
      !isPdfVersion(resolved) ||
      resolved.sourceFileId !== source.sourceFileId ||
      resolved.sourceVersionId !== source.versionId ||
      resolved.checksum !== source.checksum
    )
      throw new Error('PDF annotation source is not available.')
    const lease = await resolved.openContent()
    try {
      await lease.verifyUnchanged()
      await this.prepareSource(projectDocumentSource(source.projectId, resolved), lease)
    } finally {
      await lease.close()
    }
    return { ok: true, source: projectDocumentSource(source.projectId, resolved) }
  }

  // Retain the session barrier and verified immutable lease through the consuming operation.
  async withVerifiedSource<T>(
    source: PdfAnnotationSource,
    operation: (
      lease: { path: string; size: number; verifyUnchanged(): Promise<void> },
      canonical: PdfAnnotationSource
    ) => Promise<T>
  ): Promise<T> {
    if (source.kind === 'literature-attachment-version') {
      const canonical = await this.librarySource(source.versionId)
      if (!isDeepStrictEqual(canonical, source))
        throw new Error('PDF annotation source is not available.')
      const lease = await this.options.literature.openContent(source.versionId)
      try {
        await lease.verifyUnchanged()
        return await operation(lease, canonical)
      } finally {
        await lease.close()
      }
    }
    if (!source.projectId || !source.sessionId)
      throw new Error('PDF annotation source is not available.')
    return this.options.runWithSessionAuthority(source.projectId, source.sessionId, async () => {
      await this.requireSession(source.projectId!, source.sessionId!, true)
      const resolved = await this.options.resolveSessionPdfVersion({
        projectId: source.projectId!,
        sourceKind: source.kind as 'upload-version' | 'artifact-version',
        sourceFileId: source.sourceFileId,
        versionId: source.versionId
      })
      if (
        !resolved?.openContent ||
        resolved.sourceKind === 'literature-attachment-version' ||
        !isPdfVersion(resolved) ||
        resolved.checksum !== source.checksum
      )
        throw new Error('PDF annotation source is not available.')
      const canonical = projectDocumentSource(source.projectId!, resolved)
      if (!isDeepStrictEqual(canonical, source))
        throw new Error('PDF annotation source is not available.')
      const lease = await resolved.openContent()
      try {
        await lease.verifyUnchanged()
        await this.prepareSource(canonical, lease)
        return await operation(lease, canonical)
      } finally {
        await lease.close()
      }
    })
  }

  async reconcile(request: PdfReconcileRequest): Promise<PdfSharingPreview | null> {
    return this.withVerifiedSource(request.source, async (lease, source) => {
      await this.options.repository.registerVerifiedSource(source, lease.size)
      const parsed = await parseNativePdfAnnotations(lease.path)
      await lease.verifyUnchanged()
      return this.options.repository.reconcileSource(
        source,
        lease.size,
        parsed.annotations,
        request.token,
        request.decisions
      )
    })
  }

  create(request: CreatePdfAnnotationRequest): Promise<PdfAnnotation> {
    if (!createPdfAnnotationRequestSchema.safeParse(request).success)
      return Promise.reject(new Error('PDF annotation source is not available.'))
    return this.withScope(request, async () => {
      const recovered = await this.options.repository.recoverCreate(request)
      if (recovered) return recovered
      const source = request.target.source
      if (source.projectId !== request.projectId)
        throw new Error('PDF annotation source is not available.')
      const resolved = request.literatureVersionId
        ? { ok: true as const, source: await this.librarySource(request.literatureVersionId) }
        : await this.resolveDocumentSource(source)
      if (
        !resolved.ok ||
        !isDeepStrictEqual(
          JSON.parse(JSON.stringify(resolved.source)),
          JSON.parse(JSON.stringify(source))
        )
      ) {
        throw new Error('PDF annotation source is not available.')
      }
      return this.options.repository.create(request)
    })
  }

  update(request: UpdatePdfAnnotationRequest): Promise<PdfAnnotation> {
    return this.withScope(request, async () => {
      return this.options.repository.update(request)
    })
  }

  async setTagAssignment(request: SetTagAssignmentRequest): Promise<void> {
    const annotation = await this.options.repository.get(request.resourceId)
    if (!annotation) throw new Error('PDF annotation not found.')
    const tagIds = new Set(annotation.tagIds)
    if (request.assigned) tagIds.add(request.tagId)
    else tagIds.delete(request.tagId)
    await this.update(
      updatePdfAnnotationRequestSchema.parse({
        id: annotation.id,
        ...(annotation.literatureVersionId
          ? { literatureVersionId: annotation.literatureVersionId }
          : { projectId: annotation.projectId }),
        tagIds: [...tagIds],
        expectedUpdatedAt: annotation.updatedAt
      })
    )
  }

  delete(request: DeletePdfAnnotationRequest): Promise<DeletePdfAnnotationResult> {
    return this.withScope(request, async () => {
      return { deleted: await this.options.repository.delete(request) }
    })
  }

  importNative(
    request: PdfNativeAnnotationImportRequest,
    signal?: AbortSignal
  ): Promise<PdfNativeAnnotationImportResult> {
    if (signal?.aborted || this.shutdown.signal.aborted)
      return Promise.reject(signal?.reason ?? this.shutdown.signal.reason)
    if (this.nativeImports.has(request.operationId))
      return Promise.reject(new Error('PDF annotation import operation is already active.'))
    const controller = new AbortController()
    this.nativeImports.set(request.operationId, controller)
    const combined = AbortSignal.any([
      controller.signal,
      this.shutdown.signal,
      ...(signal ? [signal] : [])
    ])
    const pending = this.runNativeImport(request, combined).catch((error) => {
      if (!combined.aborted) throw error
      const result = {
        operationId: request.operationId,
        importedCount: 0,
        unsupportedCount: 0,
        pageCount: 0,
        truncated: false,
        cancelled: true
      }
      this.options.onNativeImportProgress?.({
        operationId: request.operationId,
        pagesProcessed: 0,
        pageCount: 0,
        importedCount: 0,
        unsupportedCount: 0,
        phase: 'cancelled'
      })
      return result
    })
    this.pendingImports.add(pending)
    const release = (): void => {
      this.pendingImports.delete(pending)
      this.nativeImports.delete(request.operationId)
    }
    void pending.then(release, release)
    return pending
  }

  async dispose(): Promise<void> {
    this.shutdown.abort(new Error('PDF annotation importer stopped.'))
    await Promise.allSettled([...this.pendingImports])
  }

  private async runNativeImport(
    request: PdfNativeAnnotationImportRequest,
    signal?: AbortSignal
  ): Promise<PdfNativeAnnotationImportResult> {
    signal?.throwIfAborted()
    await this.requireSession(request.projectId, request.sessionId, true)
    signal?.throwIfAborted()
    const sourceKey = [
      request.projectId,
      request.sourceKind,
      request.sourceFileId,
      request.versionId
    ].join('\u0000')
    const completed = this.completedNativeImports.get(sourceKey)
    if (completed) return { ...completed, operationId: request.operationId }
    const resolved = await this.options.resolveSessionPdfVersion(request)
    if (
      !resolved ||
      !isPdfVersion(resolved) ||
      resolved.sourceKind !== request.sourceKind ||
      resolved.sourceFileId !== request.sourceFileId ||
      resolved.sourceVersionId !== request.versionId ||
      !resolved.openContent
    ) {
      throw new Error('PDF annotation source is not available.')
    }
    const source = projectDocumentSource(request.projectId, resolved)
    const identityLease = await resolved.openContent()
    try {
      await identityLease.verifyUnchanged()
      await this.prepareSource(source, identityLease, signal)
    } finally {
      await identityLease.close()
    }
    const receipt = await this.options.repository.nativeImportReceipt(request, source)
    if (receipt)
      return {
        operationId: request.operationId,
        importedCount: 0,
        pageCount: receipt.pageCount,
        unsupportedCount: receipt.unsupportedCount,
        truncated: receipt.truncated,
        cancelled: false
      }
    const importSignal = signal!
    let latest: NativePdfAnnotationProgress = {
      pagesProcessed: 0,
      pageCount: 0,
      annotationsFound: 0,
      unsupportedCount: 0
    }
    const publish = (
      phase: PdfNativeAnnotationImportProgress['phase'],
      extra: Partial<PdfNativeAnnotationImportProgress> = {}
    ): void => {
      this.options.onNativeImportProgress?.({
        operationId: request.operationId,
        source: {
          projectId: request.projectId,
          sessionId: request.sessionId,
          sourceKind: request.sourceKind,
          sourceFileId: request.sourceFileId,
          versionId: request.versionId
        },
        phase,
        pagesProcessed: latest.pagesProcessed,
        pageCount: latest.pageCount,
        importedCount: latest.annotationsFound,
        unsupportedCount: latest.unsupportedCount,
        ...extra
      })
    }
    publish('parsing')
    let lease:
      Awaited<ReturnType<NonNullable<ResolvedSessionPdfVersion['openContent']>>> | undefined
    try {
      lease = await resolved.openContent()
      await lease.verifyUnchanged()
      const parsed = await parseNativePdfAnnotations(lease.path, {
        signal: importSignal,
        onProgress: (progress) => {
          latest = progress
          publish('parsing')
        }
      })
      importSignal.throwIfAborted()
      await lease.verifyUnchanged()
      importSignal.throwIfAborted()
      latest = {
        pagesProcessed: parsed.pageCount,
        pageCount: parsed.pageCount,
        annotationsFound: parsed.annotations.length,
        unsupportedCount: parsed.unsupportedCount
      }
      publish('saving')
      const created = await this.withScope(request, async () => {
        importSignal.throwIfAborted()
        const current = await this.options.resolveSessionPdfVersion(request)
        if (!current || current.checksum !== resolved.checksum)
          throw new Error('PDF annotation source is not available.')
        await lease!.verifyUnchanged()
        importSignal.throwIfAborted()
        return this.options.repository.createMany(
          parsed.annotations.map((annotation) => ({
            projectId: request.projectId,
            sessionId: request.sessionId,
            id: `native:${createHash('sha256').update(sourceKey).digest('hex').slice(0, 32)}:${annotation.stableKey}`,
            kind: annotation.kind,
            color: annotation.color,
            origin: 'imported' as const,
            externalSubtype: annotation.subtype,
            tagIds: [],
            note: annotation.note,
            target: { source, selector: annotation.selector }
          })),
          { scope: request, source, result: nativeImportReceipt(parsed) }
        )
      })
      const result = {
        operationId: request.operationId,
        importedCount: created,
        unsupportedCount: parsed.unsupportedCount,
        pageCount: parsed.pageCount,
        truncated: parsed.truncated,
        cancelled: false
      }
      this.completedNativeImports.set(sourceKey, result)
      if (this.completedNativeImports.size > 256) {
        this.completedNativeImports.delete(this.completedNativeImports.keys().next().value!)
      }
      publish('completed', { importedCount: result.importedCount, truncated: result.truncated })
      return result
    } catch (error) {
      if (importSignal.aborted) {
        const result = {
          operationId: request.operationId,
          importedCount: 0,
          unsupportedCount: latest.unsupportedCount,
          pageCount: latest.pageCount,
          truncated: false,
          cancelled: true
        }
        publish('cancelled', { importedCount: 0, truncated: false })
        return result
      }
      publish('failed')
      throw error
    } finally {
      await lease?.close().catch(() => undefined)
    }
  }

  cancelImport(request: PdfNativeAnnotationCancelRequest): { cancelled: boolean } {
    const controller = this.nativeImports.get(request.operationId)
    if (!controller) return { cancelled: false }
    controller.abort(new Error('PDF annotation import cancelled.'))
    return { cancelled: true }
  }
}
export { PdfAnnotationService }
export type { Options as PdfAnnotationServiceOptions }
