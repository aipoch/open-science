import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { RecordedObservationTarget } from '../../../../../shared/run-observation-recorded'
import { parseArtifactVersionLocator } from '../../../../../shared/artifact-provenance'

/** A discovery hint only. Main validates all archive bytes and receiver authority on open. */
export const isRecordedObservationContent = (content: string, complete: boolean): boolean => {
  if (complete) {
    try {
      const value = JSON.parse(content)
      return value?.format === 'open-science-run-observation' && value.version === 1
    } catch {
      return false
    }
  }
  // The publisher puts the format/version header first. Partial or unrelated JSON is never
  // admitted here; this hint only makes the explicit validation/open action discoverable.
  return /^\s*\{\s*"format"\s*:\s*"open-science-run-observation"\s*,\s*"version"\s*:\s*1\s*[,}]/.test(
    content.slice(0, 4096)
  )
}
export const isProjectRecordingContent = (content: string, complete: boolean): boolean => {
  if (complete) {
    try {
      const value = JSON.parse(content)
      return value?.format === 'open-science-project-recording' && value.version === 1
    } catch {
      return false
    }
  }
  return /^\s*\{\s*"format"\s*:\s*"open-science-project-recording"\s*,\s*"version"\s*:\s*1\s*[,}]/.test(
    content.slice(0, 4096)
  )
}
export const isBrowserRecordingContent = (content: string, complete: boolean): boolean => {
  if (complete) {
    try {
      const value = JSON.parse(content)
      return value?.format === 'open-science-web-recording' && value.version === 1
    } catch {
      return false
    }
  }
  return /^\s*\{\s*"format"\s*:\s*"open-science-web-recording"\s*,\s*"version"\s*:\s*1\s*[,}]/.test(
    content.slice(0, 4096)
  )
}
export const recordedObservationTargetForFile = (
  item: PreviewFileItem
): RecordedObservationTarget | undefined => {
  if ((item.source ?? 'artifact') !== 'artifact' || !item.projectId || !item.selectedVersionId)
    return undefined
  const artifactId = item.artifactId ?? item.managedFileId
  if (!artifactId) return undefined
  const locator = parseArtifactVersionLocator(item.path)
  if (
    locator &&
    (locator.projectId !== item.projectId ||
      locator.artifactId !== artifactId ||
      locator.versionId !== item.selectedVersionId)
  )
    return undefined
  return {
    projectId: item.projectId,
    sessionId: locator?.appSessionId ?? item.sessionId,
    artifactId,
    versionId: item.selectedVersionId
  }
}
