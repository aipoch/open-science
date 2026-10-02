import type { TextAnnotation } from '../../../../shared/annotations'
import { ANNOTATION_LIMITS } from '../../../../shared/annotations'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import type { SessionDiscussionCapture } from './replay/replay-context'

export { replayAnnotationId, replayAnnotationTarget } from '../../../../shared/replay-reference'
import { replayAnnotationId, selectedSessionQuote } from '../../../../shared/replay-reference'

export const sessionDiscussionQuote = (
  context: SessionDiscussionCapture,
  limit: number = ANNOTATION_LIMITS.quote
): string => selectedSessionQuote(context, limit)

export const createSessionDiscussionAnnotation = (
  context: SessionDiscussionCapture,
  contextId?: string
): TextAnnotation | undefined => {
  const message = context.evidence.find((item) => item.kind === 'message')
  const activity = context.evidence.find((item) => item.kind === 'activity')
  const record = context.evidence.find(
    (item) => item.kind === 'notebook-run' || item.kind === 'review'
  )
  const artifact = context.evidence.find(
    (item) => item.kind === 'artifact-version' && item.artifactId && item.versionId
  )
  const source: TextAnnotation['source'] | undefined = message
    ? { kind: 'agent-message', sessionId: context.sourceSessionId, messageId: message.id }
    : activity
      ? {
          kind: 'session-item',
          sessionId: context.sourceSessionId,
          itemId: activity.id,
          itemType: 'tool-activity'
        }
      : artifact?.artifactId && artifact.versionId
        ? {
            kind: 'project-file',
            projectId: context.projectId,
            sessionId: context.sourceSessionId,
            fileSource: 'artifact',
            sourceFileId: artifact.artifactId,
            versionId: artifact.versionId,
            path: createArtifactVersionLocator({
              projectId: context.projectId,
              appSessionId: context.sourceSessionId,
              artifactId: artifact.artifactId,
              versionId: artifact.versionId
            })
          }
        : record && (record.kind === 'notebook-run' || record.kind === 'review')
          ? {
              kind: 'session-item',
              sessionId: context.sourceSessionId,
              itemId: record.id,
              itemType: record.kind
            }
          : undefined
  if (!source) return undefined
  return {
    id: replayAnnotationId(context, contextId),
    kind: 'text',
    target: 'agent',
    source,
    quote: contextId
      ? `Session: ${context.sourceTitle.replace(/[\r\n]/g, ' ').slice(0, 240)}\n${context.stepNumber ? `[${context.stepNumber}] ` : ''}${context.stepTitle ?? ''}`
      : sessionDiscussionQuote(context)
  }
}
