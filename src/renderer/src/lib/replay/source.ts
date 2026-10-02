import type { ReviewWithChecks, ReviewSessionRequest } from '../../../../shared/reviewer'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  GetArtifactLineageRequest
} from '../../../../shared/artifact-provenance'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import type {
  NotebookRunCursor,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState,
  NotebookSessionStateRequest
} from '../../../../shared/notebook'
import type { ProvenanceReadResult } from '../../../../shared/provenance-read-result'
import { unwrapProvenanceRead } from '../../../../shared/provenance-read-result'
import type {
  ReplayDocument,
  ReplayIssue,
  ReplayResource,
  ReplayRunIndex
} from '../../../../shared/replay'
import type {
  LoadSessionRequest,
  PersistedArtifact,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import { createUploadVersionReference } from '../../../../shared/uploads'
import { buildReplayDocument } from './timeline'
import { indexReplayRun } from './run-index'

// Deliberately excludes execution, mutation, event subscriptions and global renderer stores.
export type ReplayReaderApi = {
  reviewer?: { getForSession: (request: ReviewSessionRequest) => Promise<ReviewWithChecks[]> }
  sessions: {
    loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
  }
  notebook: {
    runIndex?: (request: NotebookSessionRequest) => Promise<ReplayRunIndex[]>
    getReference: (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
    state: (request: NotebookSessionStateRequest) => Promise<NotebookSessionState>
  }
  artifacts: {
    getLineage: (
      request: GetArtifactLineageRequest
    ) => Promise<ProvenanceReadResult<ArtifactLineageProvenance | undefined>>
  }
}

export type ReplaySourceData = {
  session: PersistedChatSession
  runs: ReplayRunIndex[]
  reviews?: ReviewWithChecks[]
  resources: ReplayResource[]
  issues: ReplayIssue[]
}

export type ReplayLoadOptions = { signal?: AbortSignal }

const checkAbort = (signal?: AbortSignal): void => signal?.throwIfAborted()
const errorDetail = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000)

const timestamp = (value?: string): number | undefined => {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) && time >= 0 ? time : undefined
}

const readRuns = async (
  api: ReplayReaderApi['notebook'],
  request: NotebookSessionRequest,
  signal?: AbortSignal
): Promise<{ runs: ReplayRunIndex[]; issues: ReplayIssue[] }> => {
  const runs = new Map<string, ReplayRunIndex>()
  const issues: ReplayIssue[] = []
  try {
    checkAbort(signal)
    if (api.runIndex) {
      const runs = await api.runIndex(request)
      checkAbort(signal)
      return { runs, issues }
    }
    const reference = await api.getReference(request)
    checkAbort(signal)
    if (!reference) return { runs: [], issues }
    let historyBefore: NotebookRunCursor | undefined
    const cursors = new Set<string>()
    let expectedCount = 0
    for (;;) {
      // state() is the application's existing persisted-history reader. It does not execute code.
      const state = await api.state({ ...request, ...(historyBefore ? { historyBefore } : {}) })
      checkAbort(signal)
      expectedCount = Math.max(expectedCount, state.runCount)
      // Retain only compact relationship/timing metadata. The complete page becomes collectable
      // before the next IPC response; selecting a step rereads its exact runIds separately.
      for (const run of state.runs) runs.set(run.runId, indexReplayRun(run))
      if (!state.historyPage?.hasEarlierRuns) break
      historyBefore = state.historyPage.oldestCursor
      const key = JSON.stringify(historyBefore)
      if (!historyBefore || cursors.has(key)) {
        issues.push({ code: 'incomplete-history' })
        break
      }
      cursors.add(key)
    }
    if (runs.size < expectedCount && !issues.some((issue) => issue.code === 'incomplete-history')) {
      issues.push({ code: 'incomplete-history' })
    }
  } catch (error) {
    checkAbort(signal)
    issues.push({ code: 'notebook-unavailable', detail: errorDetail(error) })
  }
  return {
    runs: [...runs.values()].sort(
      (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId)
    ),
    issues
  }
}

const versionResource = (
  request: LoadSessionRequest,
  version: ArtifactVersionDescriptor
): ReplayResource => ({
  id: `artifact-version:${version.versionId}`,
  name: version.name,
  projectId: request.projectId,
  sessionId: request.sessionId,
  artifactId: version.artifactId,
  versionId: version.versionId,
  versionNumber: version.versionNumber,
  locator: createArtifactVersionLocator({
    projectId: request.projectId,
    appSessionId: request.sessionId,
    artifactId: version.artifactId,
    versionId: version.versionId
  }),
  mimeType: version.mimeType,
  size: version.size,
  checksum: version.checksum,
  createdAt: timestamp(version.createdAt),
  messageId: version.messageId,
  producerRunId: version.producerRunId,
  availability: 'recorded'
})

const unavailableResource = (
  request: LoadSessionRequest,
  artifact: PersistedArtifact
): ReplayResource => ({
  id: artifact.versionId ? `artifact-version:${artifact.versionId}` : `artifact:${artifact.id}`,
  name: artifact.name ?? artifact.id,
  projectId: request.projectId,
  sessionId: request.sessionId,
  artifactId: artifact.artifactId,
  versionId: artifact.versionId,
  versionNumber: artifact.versionNumber,
  mimeType: artifact.mimeType,
  size: artifact.size,
  checksum: artifact.sha256,
  createdAt: artifact.createdAt,
  availability: 'unavailable'
})

const readResources = async (
  api: ReplayReaderApi['artifacts'],
  request: LoadSessionRequest,
  artifacts: PersistedArtifact[],
  signal?: AbortSignal
): Promise<{ resources: ReplayResource[]; issues: ReplayIssue[] }> => {
  const grouped = new Map<string, PersistedArtifact[]>()
  for (const artifact of artifacts) {
    const key = artifact.artifactId ?? `unversioned:${artifact.id}`
    grouped.set(key, [...(grouped.get(key) ?? []), artifact])
  }
  const groups = [...grouped.values()]
  const results: Array<{ resources: ReplayResource[]; issues: ReplayIssue[] }> = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < groups.length) {
      const index = nextIndex++
      const group = groups[index]
      const artifact = group[0]
      const resources = new Map<string, ReplayResource>()
      const issues: ReplayIssue[] = []
      if (!artifact.artifactId) {
        for (const item of group) resources.set(item.id, unavailableResource(request, item))
        issues.push({ code: 'unversioned-artifact', sourceId: artifact.id })
      } else {
        try {
          let cursor: string | undefined
          const cursors = new Set<string>()
          do {
            checkAbort(signal)
            const page: ArtifactLineageProvenance | undefined = unwrapProvenanceRead(
              await api.getLineage({
                projectId: request.projectId,
                appSessionId: request.sessionId,
                artifactId: artifact.artifactId,
                ...(cursor ? { cursor } : {})
              })
            )
            checkAbort(signal)
            if (!page) break
            for (const version of page.versions) {
              if (version.artifactId !== artifact.artifactId) {
                throw new Error('Artifact lineage identity mismatch.')
              }
              resources.set(version.versionId, versionResource(request, version))
            }
            cursor = page.nextCursor
            if (cursor && cursors.has(cursor)) {
              issues.push({ code: 'incomplete-history', sourceId: artifact.artifactId })
              break
            }
            if (cursor) cursors.add(cursor)
          } while (cursor)
        } catch (error) {
          checkAbort(signal)
          issues.push({
            code: 'artifact-unavailable',
            sourceId: artifact.artifactId,
            detail: errorDetail(error)
          })
        }
        // A newer head must never substitute for an exact version referenced by the transcript.
        for (const item of group) {
          if (!item.versionId || !resources.has(item.versionId)) {
            const resource = unavailableResource(request, item)
            resources.set(item.versionId ?? item.id, resource)
            issues.push({ code: 'artifact-unavailable', sourceId: resource.id })
          }
        }
      }
      results[index] = { resources: [...resources.values()], issues }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, worker))
  return {
    resources: results.flatMap((result) => result.resources),
    issues: results.flatMap((result) => result.issues)
  }
}

// Upload records carry their exact immutable byte version; their filename/path is never a
// fallback. Read all graph messages, including inactive branches, without opening file payloads.
const readUploadResources = (session: PersistedChatSession): ReplayResource[] => {
  const messages = new Map(
    [...session.messages, ...(session.conversationGraph?.messages ?? [])].map((item) => [
      item.id,
      item
    ])
  )
  const resources = new Map<string, ReplayResource>()
  for (const message of messages.values()) {
    for (const upload of message.uploads ?? []) {
      const id = upload.versionId
        ? `upload-version:${upload.versionId}`
        : `upload:${encodeURIComponent(upload.sessionId)}:${encodeURIComponent(upload.id)}`
      const previous = resources.get(id)
      if (previous) {
        previous.messageIds!.push(message.id)
        continue
      }
      resources.set(id, {
        id,
        source: 'upload',
        name: upload.name || upload.originalName || upload.id,
        projectId: session.projectId,
        sessionId: upload.sessionId,
        fileId: upload.id,
        versionId: upload.versionId,
        versionNumber: upload.versionNumber,
        locator: upload.versionId
          ? createUploadVersionReference(upload.versionId, {
              projectId: session.projectId,
              sessionId: upload.sessionId,
              fileId: upload.id
            })
          : undefined,
        mimeType: upload.mimeType,
        size: upload.size,
        checksum: upload.sha256 ?? upload.checksum,
        createdAt: timestamp(upload.createdAt),
        messageId: message.id,
        messageIds: [message.id],
        availability: upload.versionId ? 'recorded' : 'unavailable'
      })
    }
  }
  return [...resources.values()]
}

export const loadReplaySource = async (
  api: ReplayReaderApi,
  request: LoadSessionRequest,
  { signal }: ReplayLoadOptions = {}
): Promise<ReplaySourceData> => {
  checkAbort(signal)
  // loadOne reads the authoritative complete session, independent of the visible transcript window.
  const session = await api.sessions.loadOne(request)
  checkAbort(signal)
  if (!session || session.id !== request.sessionId || session.projectId !== request.projectId) {
    throw new Error('Replay source session is unavailable.')
  }
  let reviewUnavailable = false
  const [notebook, artifacts, reviews] = await Promise.all([
    readRuns(api.notebook, { ...request, workspaceCwd: session.cwd }, signal),
    readResources(api.artifacts, request, session.artifacts ?? [], signal),
    api.reviewer
      ? api.reviewer
          .getForSession({ projectId: request.projectId, appSessionId: request.sessionId })
          .catch(() => {
            reviewUnavailable = true
            return []
          })
      : Promise.resolve([])
  ])
  checkAbort(signal)
  const uploads = readUploadResources(session)
  return {
    session,
    runs: notebook.runs,
    reviews: reviews.filter(
      (review) => review.projectId === request.projectId && review.sessionId === request.sessionId
    ),
    resources: [...artifacts.resources, ...uploads],
    issues: [
      ...notebook.issues,
      ...(reviewUnavailable ? [{ code: 'review-unavailable' as const }] : []),
      ...artifacts.issues,
      ...uploads
        .filter((resource) => resource.availability === 'unavailable')
        .map((resource) => ({
          code: 'unversioned-artifact' as const,
          sourceId: resource.id
        })),
      ...(session.packageOrigin?.excludedFiles?.length ? [{ code: 'excluded-files' as const }] : [])
    ]
  }
}

export const loadReplayDocument = async (
  api: ReplayReaderApi,
  request: LoadSessionRequest,
  options: ReplayLoadOptions = {}
): Promise<ReplayDocument> => buildReplayDocument(await loadReplaySource(api, request, options))
