import {
  readObservationBindingsRequestSchema,
  type ReadObservationBindingsRequest,
  type ReadObservationBindingsResult
} from '../../shared/research-replay-observations'
import { SessionReadingOwner } from './session-reading'
import {
  unlinkSessionReadingRequestSchema,
  type UnlinkSessionReadingRequest
} from '../../shared/session-replay'
import type { PersistedChatSession, SessionSummary } from '../../shared/session-persistence'
import {
  setResearchMembershipRequestSchema,
  type SetResearchMembershipRequest,
  sessionReplayRequestSchema,
  sessionReplayListRequestSchema,
  saveSessionReplayProgressRequestSchema,
  saveSessionDiscussionSnapshotRequestSchema,
  getSessionDiscussionSnapshotRequestSchema,
  type SaveSessionDiscussionSnapshotRequest,
  type GetSessionDiscussionSnapshotRequest,
  type SessionDiscussionSnapshot,
  type SessionReplayRequest,
  type SessionReplayListRequest,
  type SessionReplaySnapshot,
  type SessionDiscussionMatch,
  type SaveSessionReplayProgressRequest,
  type SaveSessionReplayProgressResult
} from '../../shared/session-replay'
import { SessionReplayRepository, replayViewSnapshot } from './repository'

type SessionRead =
  { status: 'found'; session: PersistedChatSession } | { status: 'missing' | 'unreadable' }
export type SessionReplaySessions = {
  read(projectId: string, sessionId: string): Promise<SessionRead>
  list(): Promise<
    ReadonlyArray<
      Pick<
        SessionSummary,
        'id' | 'projectId' | 'updatedAt' | 'researchMembership' | 'importedResearch' | 'archivedAt'
      >
    >
  >
  setResearchMembership?(request: SetResearchMembershipRequest): Promise<PersistedChatSession>
  readCurrent(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
}
type DataRootAdmission = <T>(operation: () => Promise<T>) => Promise<T>

export class SessionReplayService {
  constructor(
    private readonly repository: SessionReplayRepository,
    private readonly sessions: SessionReplaySessions,
    private readonly withDataRootWrite: DataRootAdmission = (operation) => operation(),
    private readonly reading?: SessionReadingOwner,
    private readonly observationBindingsReader?: (
      request: ReadObservationBindingsRequest
    ) => Promise<ReadObservationBindingsResult>
  ) {}

  async readObservationBindings(
    input: ReadObservationBindingsRequest
  ): Promise<ReadObservationBindingsResult> {
    const request = readObservationBindingsRequestSchema.parse(input)
    if (!this.observationBindingsReader)
      return {
        sourceFingerprint: request.sourceFingerprint,
        bindings: [],
        unavailableTargets: request.targets
      }
    return this.observationBindingsReader(request)
  }

  async setResearchMembership(input: SetResearchMembershipRequest): Promise<PersistedChatSession> {
    const request = setResearchMembershipRequestSchema.parse(input)
    if (!this.sessions.setResearchMembership) throw new Error('Research membership is unavailable.')
    return this.withDataRootWrite(async () => {
      const client = await this.repository.getClient()
      const project = await client.project.findFirst({
        where: { id: request.projectId, deletedAt: null, archivedAt: null }
      })
      if (!project) throw new Error('The discussion Project is unavailable.')
      return this.sessions.setResearchMembership!(request)
    })
  }

  async unlinkSession(input: UnlinkSessionReadingRequest): Promise<void> {
    const request = unlinkSessionReadingRequestSchema.parse(input)
    if (!this.reading) throw new Error('Session reading is unavailable.')
    await this.withDataRootWrite(() => this.reading!.unlink(request))
  }

  async get(input: SessionReplayRequest): Promise<SessionReplaySnapshot> {
    const request = sessionReplayRequestSchema.parse(input)
    const client = await this.repository.getClient()
    const [project, row, source] = await Promise.all([
      client.project.findFirst({ where: { id: request.projectId, deletedAt: null } }),
      this.repository.get(request),
      this.sessions.read(request.projectId, request.sourceSessionId)
    ])
    const sourceStatus = !project
      ? 'missing'
      : source.status !== 'found'
        ? source.status
        : project.archivedAt || source.session.archivedAt !== undefined
          ? 'archived'
          : 'available'
    return {
      ...request,
      sourceStatus,
      ...(source.status === 'found' ? { sourceTitle: source.session.title } : {}),
      ...(replayViewSnapshot(row) ? { view: replayViewSnapshot(row) } : {})
    }
  }

  async findDiscussion(input: SessionReplayRequest): Promise<SessionDiscussionMatch> {
    const request = sessionReplayRequestSchema.parse(input)
    const source = await this.get(request)
    if (source.sourceStatus !== 'available') return null

    const imported = await this.sessions.read(request.projectId, request.sourceSessionId)
    if (imported.status !== 'found' || !imported.session.packageOrigin) return null
    const importId = imported.session.packageOrigin.importId
    // Grouping is a stable local relationship. Reading/quoting a source never enrolls an ordinary
    // Session, and startup navigation only opens JSON for actual projected discussion candidates.
    const matches = (membership: PersistedChatSession['researchMembership']): boolean =>
      membership?.sourceProjectId === request.projectId &&
      membership.sourceSessionId === request.sourceSessionId &&
      membership.sourceImportId === importId
    const candidates = (await this.sessions.list())
      .filter(
        ({ projectId, id, archivedAt, importedResearch, researchMembership }) =>
          projectId === request.projectId &&
          id !== request.sourceSessionId &&
          archivedAt === undefined &&
          !importedResearch &&
          matches(researchMembership)
      )
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    for (const candidate of candidates) {
      const session = await this.sessions.readCurrent(request.projectId, candidate.id)
      if (
        !session ||
        session.id !== candidate.id ||
        session.projectId !== request.projectId ||
        session.packageOrigin ||
        session.archivedAt !== undefined ||
        !matches(session.researchMembership)
      )
        continue
      // A source may have been removed/reimported while the candidate was being read.
      const currentSource = await this.sessions.read(request.projectId, request.sourceSessionId)
      if (
        currentSource.status !== 'found' ||
        currentSource.session.archivedAt !== undefined ||
        currentSource.session.packageOrigin?.importId !== importId
      )
        return null
      return { sessionId: session.id }
    }
    return null
  }

  async list(input: SessionReplayListRequest): Promise<SessionReplaySnapshot[]> {
    const { projectId } = sessionReplayListRequestSchema.parse(input)
    const rows = await this.repository.list(projectId)
    return Promise.all(
      rows.map(({ sessionId }) => this.get({ projectId, sourceSessionId: sessionId }))
    )
  }

  async saveView(
    input: SaveSessionReplayProgressRequest
  ): Promise<SaveSessionReplayProgressResult> {
    const request = saveSessionReplayProgressRequestSchema.parse(input)
    return this.withDataRootWrite(async () => {
      const source = await this.sessions.read(request.projectId, request.sourceSessionId)
      if (source.status !== 'found') throw new Error('The source Session cannot be read.')
      return this.repository.saveView(request)
    })
  }

  async saveSelectionSnapshot(input: SaveSessionDiscussionSnapshotRequest): Promise<void> {
    const request = saveSessionDiscussionSnapshotRequestSchema.parse(input)
    return this.withDataRootWrite(async () => {
      const saved = await this.repository.getSelectionSnapshot({
        projectId: request.projectId,
        id: request.context.id
      })
      // Exact retries remain possible after source removal. A new reference always needs a readable source.
      if (!saved) {
        const source = await this.sessions.read(request.projectId, request.sourceSessionId)
        if (source.status !== 'found') throw new Error('The source Session cannot be read.')
      }
      await this.repository.saveSelectionSnapshot(request.context)
    })
  }

  getSelectionSnapshot(
    input: GetSessionDiscussionSnapshotRequest
  ): Promise<SessionDiscussionSnapshot | undefined> {
    return this.repository.getSelectionSnapshot(
      getSessionDiscussionSnapshotRequestSchema.parse(input)
    )
  }

  listSelectionSnapshots(input: SessionReplayRequest): Promise<SessionDiscussionSnapshot[]> {
    return this.repository.listSelectionSnapshots(sessionReplayRequestSchema.parse(input))
  }
}
