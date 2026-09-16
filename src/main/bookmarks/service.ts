import { resolveManagedProjectFileAnnotationIdentity } from '../../shared/annotations'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import type {
  Bookmark,
  BookmarkListResult,
  BookmarkPdfSourceResult,
  CreateBookmarkRequest,
  DeleteBookmarkRequest,
  ListBookmarksRequest,
  ResolvePdfBookmarkSourceRequest,
  UpdateBookmarkNoteRequest
} from '../../shared/bookmarks'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createLiteratureAttachmentVersionReference } from '../../shared/literature'
import { createUploadVersionReference } from '../../shared/uploads'
import type { ResolvedSessionPdfVersion } from '../literature/session-pdf-source-resolver'
import type { BookmarkRepository } from './repository'
import { createLogger, diagnosticErrorFields } from '../logger'

const log = createLogger('bookmarks')

type SessionAuthority = {
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
}

type PdfVersionAuthority = {
  resolveVersion(request: {
    projectId: string
    sourceKind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
    sourceVersionId: string
    expectedSourceFileId?: string
  }): Promise<ResolvedSessionPdfVersion | undefined>
}

type BookmarkRepositoryPort = Pick<
  BookmarkRepository,
  'recoverCreate' | 'create' | 'list' | 'updateNote' | 'delete'
>

type BookmarkServiceOptions = Readonly<{
  repository: BookmarkRepositoryPort
  sessions: SessionAuthority
  pdfVersions?: PdfVersionAuthority
  validateProjectFile?: (
    source: Extract<CreateBookmarkRequest['target'], { kind: 'text' }>['source'],
    owningSession: PersistedChatSession
  ) => Promise<boolean>
  runWithSessionAuthority: <Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ) => Promise<Result>
}>

const allMessages = (session: PersistedChatSession): PersistedChatSession['messages'] =>
  session.conversationGraph?.messages ?? session.messages

const allActivities = (
  session: PersistedChatSession
): NonNullable<PersistedChatSession['activities']> =>
  session.conversationGraph?.activities ?? session.activities ?? []

const isPlanActivity = (
  activity: NonNullable<PersistedChatSession['activities']>[number]
): boolean =>
  [activity.providerToolName, activity.title].some((name) =>
    /(?:^|[._])generate_plan$/u.test(name?.trim() ?? '')
  )

const canonicalPdfPath = (projectId: string, resolved: ResolvedSessionPdfVersion): string =>
  resolved.sourceKind === 'artifact-version'
    ? createArtifactVersionLocator({
        projectId,
        appSessionId: resolved.sourceSessionId,
        artifactId: resolved.sourceFileId,
        versionId: resolved.sourceVersionId
      })
    : resolved.sourceKind === 'upload-version'
      ? createUploadVersionReference(resolved.sourceVersionId, {
          projectId,
          sessionId: resolved.sourceSessionId,
          fileId: resolved.sourceFileId
        })
      : createLiteratureAttachmentVersionReference(resolved.sourceVersionId)

class BookmarkService {
  constructor(private readonly options: BookmarkServiceOptions) {}

  private async resolveReadablePdfVersion(
    request: {
      projectId: string
      sourceKind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
      sourceVersionId: string
      expectedSourceFileId: string
    },
    onStage?: (stage: string) => void
  ): Promise<ResolvedSessionPdfVersion | undefined> {
    onStage?.('version-resolution')
    const resolved = await this.options.pdfVersions?.resolveVersion(request)
    if (
      !resolved ||
      !(
        resolved.contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' ||
        resolved.filename.toLowerCase().endsWith('.pdf')
      ) ||
      !Number.isSafeInteger(resolved.sizeBytes) ||
      resolved.sizeBytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(resolved.checksum) ||
      !resolved.openContent
    ) {
      return undefined
    }
    onStage?.('content-open')
    const lease = await resolved.openContent()
    try {
      onStage?.('content-verification')
      await lease.verifyUnchanged()
    } finally {
      await lease.close().catch((error: unknown) => {
        onStage?.('content-close')
        throw error
      })
    }
    return resolved
  }

  private enqueue<Result>(
    projectId: string,
    sessionId: string,
    work: () => Promise<Result>
  ): Promise<Result> {
    return this.options.runWithSessionAuthority(projectId, sessionId, work)
  }

  private async loadWritableSession(
    projectId: string,
    sessionId: string,
    onStage?: (stage: string) => void
  ): Promise<PersistedChatSession> {
    const loaded = await this.options.sessions.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status === 'unreadable') {
      onStage?.('session-unreadable')
      throw new Error('Cannot use Bookmarks while the durable Session is unreadable.')
    }
    if (loaded.status === 'missing' || loaded.session.projectId !== projectId) {
      onStage?.('session-unavailable')
      throw new Error('Session not found.')
    }
    if (loaded.session.packageOrigin) {
      onStage?.('session-read-only')
      throw new Error('Imported Sessions are read-only.')
    }
    return loaded.session
  }

  private async validateNewSource(
    request: CreateBookmarkRequest,
    session: PersistedChatSession
  ): Promise<void> {
    const target = request.target
    if (target.kind === 'pdf') {
      const source = target.source
      if (source.projectId !== request.projectId || !this.options.pdfVersions) {
        throw new Error('Bookmark source is not available.')
      }
      const resolved = await this.resolveReadablePdfVersion({
        projectId: request.projectId,
        sourceKind: source.kind,
        sourceVersionId: source.versionId,
        expectedSourceFileId: source.sourceFileId
      })
      if (
        !resolved ||
        resolved.sourceKind !== source.kind ||
        resolved.sourceFileId !== source.sourceFileId ||
        resolved.sourceVersionId !== source.versionId ||
        resolved.checksum !== source.checksum ||
        resolved.filename !== source.name ||
        ('sourceSessionId' in resolved && resolved.sourceSessionId !== source.sessionId) ||
        (!('sourceSessionId' in resolved) && source.sessionId !== undefined) ||
        source.path !== canonicalPdfPath(request.projectId, resolved)
      ) {
        throw new Error('Bookmark source is not available.')
      }
      return
    }

    const source = target.source
    if (source.kind === 'agent-message') {
      const found =
        source.sessionId === request.sessionId &&
        allMessages(session).some(({ id, role }) => id === source.messageId && role === 'agent')
      if (!found) throw new Error('Bookmark source is not available.')
      return
    }
    if (source.kind === 'session-item') {
      if (source.sessionId !== request.sessionId) {
        throw new Error('Bookmark source is not available.')
      }
      const activity = allActivities(session).find(({ id }) => id === source.itemId)
      const found = (() => {
        if (source.itemType === 'subagent-message') {
          return (session.runtimeContext?.delegatedWork?.messageCommands ?? []).some(
            (command) =>
              command.messageId === source.itemId &&
              command.direction === 'to_parent' &&
              command.disposition === 'message' &&
              session.conversationGraph?.frames.some(
                (frame) =>
                  frame.id === command.sourceFrameId &&
                  frame.kind === 'delegate' &&
                  frame.parentFrameId === session.conversationGraph?.rootFrameId
              )
          )
        }
        if (source.itemType === 'delegated-elicitation') {
          return (session.runtimeContext?.delegatedWork?.questionRequests ?? []).some(
            ({ requestId }) => requestId === source.itemId
          )
        }
        if (!activity) return false
        if (source.itemType === 'plan') return isPlanActivity(activity)
        if (source.itemType === 'elicitation') return activity.elicitation !== undefined
        return source.itemType === 'tool-activity'
      })()
      if (!found) throw new Error('Bookmark source is not available.')
      return
    }
    if (source.projectId !== request.projectId) {
      throw new Error('Bookmark source is not available.')
    }
    const managed = resolveManagedProjectFileAnnotationIdentity(source)
    if (managed) {
      if (!this.options.pdfVersions) throw new Error('Bookmark source is not available.')
      const resolved = await this.options.pdfVersions.resolveVersion({
        projectId: request.projectId,
        sourceKind: `${managed.fileSource}-version`,
        sourceVersionId: managed.versionId,
        expectedSourceFileId: managed.fileId
      })
      if (
        !resolved ||
        resolved.sourceFileId !== managed.fileId ||
        resolved.sourceVersionId !== managed.versionId ||
        (source.sessionId !== undefined &&
          'sourceSessionId' in resolved &&
          resolved.sourceSessionId !== source.sessionId)
      ) {
        throw new Error('Bookmark source is not available.')
      }
      return
    }
    if (!(await this.options.validateProjectFile?.(source, session))) {
      throw new Error('Bookmark source is not available.')
    }
  }

  list(request: ListBookmarksRequest): Promise<BookmarkListResult> {
    return this.options.repository.list(request)
  }

  create(request: CreateBookmarkRequest): Promise<Bookmark> {
    return this.enqueue(request.projectId, request.sessionId, async () => {
      const recovered = await this.options.repository.recoverCreate(request)
      if (recovered) return recovered
      const session = await this.loadWritableSession(request.projectId, request.sessionId)
      await this.validateNewSource(request, session)
      return this.options.repository.create(request)
    })
  }

  updateNote(request: UpdateBookmarkNoteRequest): Promise<Bookmark> {
    return this.enqueue(request.projectId, request.sessionId, () =>
      this.options.repository.updateNote(request)
    )
  }

  delete(request: DeleteBookmarkRequest): Promise<{ deleted: boolean }> {
    return this.enqueue(request.projectId, request.sessionId, async () => ({
      deleted: await this.options.repository.delete(request)
    }))
  }

  async resolvePdfSource(
    request: ResolvePdfBookmarkSourceRequest
  ): Promise<BookmarkPdfSourceResult> {
    let stage = 'session-load'
    const onStage = (value: string): void => {
      stage = value
    }
    try {
      await this.loadWritableSession(request.projectId, request.sessionId, onStage)
      if (!this.options.pdfVersions) return { ok: false, reason: 'unsupported-source' }
      const resolved = await this.resolveReadablePdfVersion(
        {
          projectId: request.projectId,
          sourceKind: request.sourceKind,
          sourceVersionId: request.versionId,
          expectedSourceFileId: request.sourceFileId
        },
        onStage
      )
      if (!resolved) return { ok: false, reason: 'source-unavailable' }
      if (
        resolved.sourceKind !== request.sourceKind ||
        resolved.sourceFileId !== request.sourceFileId ||
        resolved.sourceVersionId !== request.versionId
      ) {
        return { ok: false, reason: 'identity-mismatch' }
      }
      stage = 'source-identity'
      const path = canonicalPdfPath(request.projectId, resolved)
      return {
        ok: true,
        source: {
          kind: resolved.sourceKind,
          projectId: request.projectId,
          sourceFileId: resolved.sourceFileId,
          versionId: resolved.sourceVersionId,
          ...('sourceSessionId' in resolved ? { sessionId: resolved.sourceSessionId } : {}),
          checksum: resolved.checksum,
          name: resolved.filename,
          path
        }
      }
    } catch (error) {
      try {
        // Fixed diagnostic stages only: never retain source IDs, paths, messages, or stacks.
        log.warn('PDF bookmark source verification failed', {
          stage,
          ...diagnosticErrorFields(error)
        })
      } catch {
        // Diagnostics cannot replace the authoritative rejection.
      }
      throw error
    }
  }
}

export { BookmarkService }
export type {
  BookmarkRepositoryPort,
  BookmarkServiceOptions,
  PdfVersionAuthority,
  SessionAuthority
}
