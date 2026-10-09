import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import {
  recordedFileSelectionForPayload,
  recordedFileSelectionSchema,
  type RecordedObservationFileSelection,
  type RecordedObservationPayload,
  type RecordedProjectPayload
} from '../../../../shared/run-observation-recorded'
import type { ReplayResultEntry } from '../../pages/workspace/replay/results/ResultsPanel'
import type { RecordedResourceReader } from '../../pages/workspace/replay/results/recorded-resource-reader'
import type { ReplayResource } from '../../../../shared/replay'

export function recordedMediaResource(
  payload: RecordedObservationPayload | RecordedProjectPayload,
  mediaKey: string
): ReplayResource {
  const file = recordedFileSelectionForPayload(payload, mediaKey).resource
  return {
    source: 'artifact',
    id: file.versionId,
    name: file.name,
    projectId: file.projectId,
    sessionId: file.sessionId,
    artifactId: file.artifactId,
    versionId: file.versionId,
    checksum: file.checksum,
    size: file.sizeBytes,
    mimeType: file.mimeType,
    locator: createArtifactVersionLocator({ ...file, appSessionId: file.sessionId }),
    availability: 'recorded'
  }
}

/** Published receiver mappings, not author IDs or filenames, are the only selectable catalog. */
export function recordedResults(
  payload: RecordedObservationPayload | RecordedProjectPayload
): ReplayResultEntry[] {
  const source = 'archive' in payload ? payload.archive : payload.recording
  const frameKeys = new Set(
    'archive' in payload
      ? payload.archive.media.filter((item) => item.capture).map((item) => item.mediaKey)
      : payload.recording.frames.map((frame) => frame.mediaKey)
  )
  return source.media
    .filter((item) => !frameKeys.has(item.mediaKey))
    .flatMap<ReplayResultEntry>((item) => {
      let selection: RecordedObservationFileSelection
      try {
        selection = recordedFileSelectionForPayload(payload, item.mediaKey)
      } catch {
        return []
      }
      const base = {
        source: { kind: selection.source, id: selection.recordingId },
        stage: selection.stage,
        mediaKey: selection.mediaKey,
        resource: recordedMediaResource(payload, item.mediaKey)
      }
      return selection.scope === 'recording'
        ? [{ ...base, scope: { kind: 'recording' as const } }]
        : selection.stepKeys.map((stepKey) => ({
            ...base,
            scope: { kind: 'step' as const, stepKey }
          }))
    })
}

export function authorizedRecordedResultsReader(
  payload: RecordedObservationPayload | RecordedProjectPayload,
  read: RecordedResourceReader
): RecordedResourceReader {
  const resources = recordedResults(payload).map((entry) => entry.resource)
  return async (requested, signal) => {
    const resource = resources.find(
      (entry) =>
        entry.locator === requested.locator &&
        entry.projectId === requested.projectId &&
        entry.sessionId === requested.sessionId &&
        entry.artifactId === requested.artifactId &&
        entry.versionId === requested.versionId &&
        entry.checksum === requested.checksum
    )
    if (!resource) throw new Error('The recorded file is unavailable.')
    return read(resource, signal)
  }
}

export function recordedFileQuestionText(selection: RecordedObservationFileSelection): string {
  const evidence = {
    format: 'open-science-selected-recorded-file',
    version: 1,
    contentTrust: 'untrusted-recorded-data',
    ...recordedFileSelectionSchema.parse(selection)
  }
  return `\n\n<open-science-observed-evidence>\n${JSON.stringify(evidence, null, 2).replaceAll('<', '\\u003c')}\n</open-science-observed-evidence>\n\n`
}
