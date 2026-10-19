import {
  createArtifactVersionLocator,
  parseArtifactVersionLocator
} from '../../../../../shared/artifact-provenance'
import type {
  ArtifactPreviewResult,
  ReadArtifactPreviewRequest
} from '../../../../../shared/artifacts'
import type { ReplayResource } from '../../../../../shared/replay'
import type { RecordedObservationTarget } from '../../../../../shared/run-observation-recorded'
import {
  isRecordedObservationContent,
  isProjectRecordingContent,
  isBrowserRecordingContent
} from './recorded-file-entry'

export const RECORDING_DISCOVERY_PAGE_SIZE = 32
export const RECORDING_DISCOVERY_PREVIEW_BYTES = 4096
const publisherRecordingIdPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const publisherIndexName = new RegExp(
  `^web-recording-${publisherRecordingIdPattern}(?:-checkpoint-([1-9][0-9]*))?\\.json$`
)
const recordingProbePriority = (name: string): number => {
  const match = publisherIndexName.exec(name)
  if (!match) return 0
  if (!match[1]) return Infinity
  const checkpoint = Number(match[1])
  return Number.isSafeInteger(checkpoint) ? checkpoint : 0
}
export type RecordingDiscoverySource = { projectId: string; sessionId: string }
export type RecordingCandidate = {
  resource: ReplayResource
  target: RecordedObservationTarget
  format?: 'project-recording' | 'web-recording'
  /** Presentation grouping only; opening still uses the exact receiving Artifact Version. */
  browserIndex?: { recordingId: string; checkpoint: number | null }
}
export type RecordingDiscoveryPage = {
  supportingResourceIds?: string[]
  recordings: RecordingCandidate[]
  nextOffset: number
  unchecked: number
  unavailable: number
}

// A name/content-type only narrows a bounded byte inspection. It never admits a viewer or
// substitutes an author's Run identity for the receiving Artifact Version.
export const recordingCandidates = (
  resources: readonly ReplayResource[],
  source: RecordingDiscoverySource
): RecordingCandidate[] => {
  const candidates = new Map<string, RecordingCandidate>()
  const conflicting = new Set<string>()
  for (const resource of resources) {
    if (
      (resource.source ?? 'artifact') !== 'artifact' ||
      resource.projectId !== source.projectId ||
      resource.sessionId !== source.sessionId ||
      !resource.artifactId ||
      !resource.versionId
    )
      continue
    const mime = resource.mimeType?.split(';')[0].trim().toLowerCase()
    if (
      mime &&
      !mime.startsWith('text/') &&
      !mime.includes('json') &&
      !/\.json$/i.test(resource.name)
    )
      continue
    const target = {
      // ReplayDocument.source also carries title/fingerprint presentation metadata. Project the
      // strict receiving identity explicitly instead of forwarding its extra runtime properties.
      projectId: source.projectId,
      sessionId: source.sessionId,
      artifactId: resource.artifactId,
      versionId: resource.versionId
    }
    const locator = resource.locator ? parseArtifactVersionLocator(resource.locator) : undefined
    if (
      resource.locator &&
      (!locator ||
        locator.projectId !== source.projectId ||
        locator.appSessionId !== source.sessionId ||
        locator.artifactId !== target.artifactId ||
        locator.versionId !== target.versionId)
    )
      continue
    const previous = candidates.get(target.versionId)
    if (previous && previous.target.artifactId !== target.artifactId) {
      conflicting.add(target.versionId)
      continue
    }
    if (!previous) candidates.set(target.versionId, { resource, target })
  }
  return (
    [...candidates.values()]
      .filter(({ target }) => !conflicting.has(target.versionId))
      // Prioritize likely final indexes before potentially thousands of checkpoints. Names only
      // order the existing bounded content probes; they never assign a format or grant access.
      .sort((left, right) => {
        const a = recordingProbePriority(left.resource.name)
        const b = recordingProbePriority(right.resource.name)
        return a === b ? 0 : a > b ? -1 : 1
      })
  )
}

const publisherBrowserIndex = (
  candidate: RecordingCandidate,
  content: string,
  complete: boolean
): RecordingCandidate['browserIndex'] => {
  // Only our owner's UUID-based names participate. Arbitrary renamed/imported material remains
  // independently discoverable. This bounded header inspection confers no reader authority.
  const uuid = publisherRecordingIdPattern
  let recordingId: unknown
  if (complete) {
    try {
      const value = JSON.parse(content)
      if (value?.format !== 'open-science-web-recording' || value.version !== 1) return undefined
      recordingId = value.recordingId
    } catch {
      return undefined
    }
  } else {
    recordingId = new RegExp(
      `^\\s*\\{\\s*"format"\\s*:\\s*"open-science-web-recording"\\s*,\\s*"version"\\s*:\\s*1\\s*,\\s*"recordingId"\\s*:\\s*"(${uuid})"\\s*[,}]`
    ).exec(content.slice(0, RECORDING_DISCOVERY_PREVIEW_BYTES))?.[1]
  }
  if (typeof recordingId !== 'string' || !new RegExp(`^${uuid}$`).test(recordingId))
    return undefined
  if (candidate.resource.name === `web-recording-${recordingId}.json`)
    return { recordingId, checkpoint: null }
  const match = new RegExp(`^web-recording-${recordingId}-checkpoint-([1-9][0-9]*)\\.json$`).exec(
    candidate.resource.name
  )
  const checkpoint = match && Number(match[1])
  return checkpoint && Number.isSafeInteger(checkpoint) ? { recordingId, checkpoint } : undefined
}

/** Stable presentation catalog merge, including when a final index arrives on a later page. */
export const mergeRecordingCandidates = (
  ...pages: readonly (readonly RecordingCandidate[])[]
): RecordingCandidate[] => {
  const result: RecordingCandidate[] = []
  const groups = new Map<string, number>()
  const versions = new Set<string>()
  for (const candidate of pages.flat()) {
    const exact = JSON.stringify(candidate.target)
    if (versions.has(exact)) continue
    versions.add(exact)
    const index = candidate.format === 'web-recording' ? candidate.browserIndex : undefined
    if (!index) {
      result.push(candidate)
      continue
    }
    const key = JSON.stringify([
      candidate.target.projectId,
      candidate.target.sessionId,
      index.recordingId
    ])
    const position = groups.get(key)
    if (position === undefined) {
      groups.set(key, result.length)
      result.push(candidate)
      continue
    }
    const previous = result[position]
    const score = index.checkpoint ?? Infinity
    const priorScore = previous.browserIndex!.checkpoint ?? Infinity
    if (
      score > priorScore ||
      (score === priorScore &&
        (candidate.resource.versionNumber ?? 0) > (previous.resource.versionNumber ?? 0))
    )
      result[position] = candidate
  }
  return result
}

const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Recording discovery cancelled', 'AbortError')
}

/** At most 32 exact Versions and two 4 KB reads at once. Main validates the complete archive on open. */
export const discoverRecordingPage = async (
  candidates: readonly RecordingCandidate[],
  readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>,
  offset = 0,
  signal?: AbortSignal
): Promise<RecordingDiscoveryPage> => {
  checkAbort(signal)
  const start = Math.max(0, Math.min(candidates.length, Math.floor(offset)))
  const page = candidates.slice(start, start + RECORDING_DISCOVERY_PAGE_SIZE)
  const found = new Map<number, RecordingCandidate>()
  let unavailable = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < page.length) {
      checkAbort(signal)
      const index = next++
      const candidate = page[index]
      if (candidate.resource.availability !== 'recorded') {
        unavailable += 1
        continue
      }
      const { target } = candidate
      try {
        const preview = await readPreview({
          path: createArtifactVersionLocator({ ...target, appSessionId: target.sessionId }),
          projectId: target.projectId,
          sessionId: target.sessionId,
          fileId: target.artifactId,
          versionId: target.versionId,
          maxBytes: RECORDING_DISCOVERY_PREVIEW_BYTES,
          encoding: 'utf8'
        })
        checkAbort(signal)
        if (
          preview.encoding === 'utf8' &&
          isRecordedObservationContent(preview.content, !preview.truncated)
        )
          found.set(index, candidate)
        else if (
          preview.encoding === 'utf8' &&
          isProjectRecordingContent(preview.content, !preview.truncated)
        )
          found.set(index, { ...candidate, format: 'project-recording' })
        else if (
          preview.encoding === 'utf8' &&
          isBrowserRecordingContent(preview.content, !preview.truncated)
        )
          found.set(index, {
            ...candidate,
            format: 'web-recording',
            browserIndex: publisherBrowserIndex(candidate, preview.content, !preview.truncated)
          })
      } catch {
        checkAbort(signal)
        unavailable += 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, page.length) }, worker))
  const nextOffset = start + page.length
  return {
    supportingResourceIds: [...found.values()].map((candidate) => candidate.resource.id),
    recordings: mergeRecordingCandidates(
      [...found.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)
    ),
    nextOffset,
    unchecked: candidates.length - nextOffset,
    unavailable
  }
}
