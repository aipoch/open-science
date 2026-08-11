import type { ArtifactRunFinalizationMarker } from './publication-types'
import { SAFE_SEGMENT_PATTERN } from './storage-layout'

const parseArtifactRunFinalizationMarker = (
  parsed: unknown,
  normalizeArtifactVersionIds: (versionIds: readonly string[]) => string[]
): { present: true; marker?: ArtifactRunFinalizationMarker } => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { present: true }
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.sessionId !== 'string' || !SAFE_SEGMENT_PATTERN.test(value.sessionId)) {
    return { present: true }
  }
  if (
    value.messageId !== undefined &&
    (typeof value.messageId !== 'string' || !SAFE_SEGMENT_PATTERN.test(value.messageId))
  ) {
    return { present: true }
  }
  let artifactVersionIds: string[] | undefined
  if (value.artifactVersionIds !== undefined) {
    if (!Array.isArray(value.artifactVersionIds)) return { present: true }
    try {
      artifactVersionIds = normalizeArtifactVersionIds(value.artifactVersionIds as string[])
    } catch {
      return { present: true }
    }
  }
  if (typeof value.provenanceContext === 'object' && value.provenanceContext !== null) {
    const context = value.provenanceContext as Record<string, unknown>
    const keys = [
      'rootFrameId',
      'agentFrameId',
      'messageBranchId',
      'runtimeSegmentId',
      'promptMessageId'
    ] as const
    if (
      keys.some(
        (key) =>
          typeof context[key] !== 'string' || !SAFE_SEGMENT_PATTERN.test(context[key] as string)
      )
    ) {
      return { present: true }
    }
    return {
      present: true,
      marker: {
        sessionId: value.sessionId,
        ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
        ...(artifactVersionIds ? { artifactVersionIds } : {}),
        provenanceContext: Object.fromEntries(
          keys.map((key) => [key, context[key]])
        ) as NonNullable<ArtifactRunFinalizationMarker['provenanceContext']>
      }
    }
  }
  return typeof value.messageId === 'string' && value.provenanceContext === undefined
    ? {
        present: true,
        marker: {
          sessionId: value.sessionId,
          messageId: value.messageId,
          ...(artifactVersionIds ? { artifactVersionIds } : {})
        }
      }
    : { present: true }
}

export { parseArtifactRunFinalizationMarker }
