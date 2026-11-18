import { randomUUID } from 'node:crypto'

import type { ManagedFileIdentity } from '../../shared/managed-file-versions'
import { applyOperations, pptxOperationsSchema, readOutline } from '../../shared/pptx-edit'
import type {
  PptxEditSessionApplyRequest,
  PptxEditSessionOpenRequest,
  PptxEditSessionSaveRequest,
  PptxEditSessionView
} from '../../shared/pptx-edit-session'
import type { ManagedPreviewTrustedLease } from '../managed-preview-resources'
import type { ManagedFileVersionService } from './../managed-file-versions/service'
import type { ApplicationCallerLease } from '../application-command-router'
import { createStagedBytesLease } from './staged-lease'

const MAX_SESSIONS = 8
const RETAINED_REVISIONS = 3

class PptxEditSessionError extends Error {
  constructor(
    readonly code: 'SESSION_NOT_FOUND',
    message: string
  ) {
    super(message)
    this.name = 'PptxEditSessionError'
  }
}

const sessionNotFound = (): PptxEditSessionError =>
  new PptxEditSessionError('SESSION_NOT_FOUND', 'Edit session is not available.')

type Session = {
  id: string
  owner: ApplicationCallerLease
  identity: ManagedFileIdentity
  basedOnVersionId: string
  name: string
  base: Uint8Array
  revisions: Map<number, Uint8Array>
  revision: number
}

type SessionService = Pick<ManagedFileVersionService, 'openVersion' | 'saveBinaryEdit'>

class PptxEditSessions {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly service: SessionService) {}

  async open(
    owner: ApplicationCallerLease,
    request: PptxEditSessionOpenRequest
  ): Promise<PptxEditSessionView> {
    const { versionId, ...identity } = request
    const lease = await this.service.openVersion(identity, versionId)
    let base: Uint8Array
    try {
      base = await lease.readRange(0, lease.size)
      await lease.verifyUnchanged()
    } finally {
      await lease.close()
    }
    const session: Session = {
      id: randomUUID(),
      owner,
      identity,
      basedOnVersionId: versionId,
      name: lease.logicalFile.displayName,
      base,
      revisions: new Map([[0, base]]),
      revision: 0
    }
    this.sessions.set(session.id, session)
    this.evictOldest()
    return this.view(session, '', 0)
  }

  openStaged(key: string): ManagedPreviewTrustedLease {
    const [sessionId, revisionText] = key.split(':')
    const session = this.sessions.get(sessionId ?? '')
    if (!session) throw sessionNotFound()
    const bytes = session.revisions.get(Number(revisionText))
    if (!bytes) throw new Error('Staged edit revision is no longer available.')
    return createStagedBytesLease(session.name, bytes, Number(revisionText))
  }

  // The renderer owns the operation list; each apply replays it onto the pinned base version.
  apply(owner: ApplicationCallerLease, request: PptxEditSessionApplyRequest): PptxEditSessionView {
    const session = this.owned(owner, request.sessionId)
    // Undoing every operation leaves an empty list, which shows the pinned base again.
    const operations = request.operations.length
      ? pptxOperationsSchema.parse(request.operations)
      : []
    const result = operations.length
      ? applyOperations(session.base, operations)
      : { bytes: session.base, summary: '' }
    session.revision += 1
    session.revisions.set(session.revision, result.bytes)
    for (const key of session.revisions.keys()) {
      if (key <= session.revision - RETAINED_REVISIONS) session.revisions.delete(key)
    }
    return this.view(session, result.summary, operations.length)
  }

  async save(
    owner: ApplicationCallerLease,
    request: PptxEditSessionSaveRequest
  ): ReturnType<SessionService['saveBinaryEdit']> {
    const session = this.owned(owner, request.sessionId)
    // Restoring a historical version saves its bytes unchanged, so it may carry no operations.
    const operations =
      request.restore === true && request.operations.length === 0
        ? []
        : pptxOperationsSchema.parse(request.operations)
    const result = operations.length
      ? applyOperations(session.base, operations)
      : { bytes: session.base, summary: 'restore' }
    return this.service.saveBinaryEdit({
      ...session.identity,
      ...(request.restore ? { restore: true } : {}),
      basedOnVersionId: session.basedOnVersionId,
      expectedHeadVersionId: request.expectedHeadVersionId,
      operationId: request.operationId,
      content: result.bytes,
      actor: 'user',
      summary: result.summary,
      opCount: operations.length
    })
  }

  close(owner: ApplicationCallerLease, sessionId: string): void {
    if (this.sessions.get(sessionId)?.owner === owner) this.sessions.delete(sessionId)
  }

  identityOf(sessionId: string): ManagedFileIdentity | undefined {
    return this.sessions.get(sessionId)?.identity
  }

  closeOwner(owner: ApplicationCallerLease): void {
    for (const [id, session] of this.sessions) {
      if (session.owner === owner) this.sessions.delete(id)
    }
  }

  private owned(owner: ApplicationCallerLease, sessionId: string): Session {
    const session = this.sessions.get(sessionId)
    if (!session || session.owner !== owner) throw sessionNotFound()
    return session
  }

  private view(session: Session, summary: string, opCount: number): PptxEditSessionView {
    const bytes = session.revisions.get(session.revision) ?? session.base
    return {
      sessionId: session.id,
      basedOnVersionId: session.basedOnVersionId,
      revision: session.revision,
      opCount,
      summary,
      outline: readOutline(bytes),
      stagedKey: `${session.id}:${session.revision}`
    }
  }

  private evictOldest(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) return
      this.sessions.delete(oldest)
    }
  }
}

export { PptxEditSessionError, PptxEditSessions }
