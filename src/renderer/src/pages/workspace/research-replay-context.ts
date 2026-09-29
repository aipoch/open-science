import { i18next } from '@/i18n'
import type { Annotation, TextAnnotation } from '../../../../shared/annotations'
import { ANNOTATION_LIMITS } from '../../../../shared/annotations'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import { MAX_SESSION_REFERENCES_PER_MESSAGE } from '../../../../shared/session-persistence'
import type { ComposerDoc } from './composer/composer-doc'
import type { ReplayStepContext, ReplaySeekTarget } from './replay/replay-context'

const REPLAY_ANNOTATION_PREFIX = 'research-replay:'

// An existing annotation ID carries a local replay locator. Its source and quote remain ordinary
// annotation fields, so exported history uses the current .science message contract unchanged.
export const replayAnnotationId = (context: ReplaySeekTarget, contextId?: string): string =>
  REPLAY_ANNOTATION_PREFIX +
  encodeURIComponent(
    JSON.stringify([
      context.projectId,
      context.sourceSessionId,
      context.branchId,
      context.stepId,
      context.stepOffsetMs ?? 0,
      ...(contextId ? [contextId] : [])
    ])
  )

export const replayAnnotationTarget = (
  annotation: Annotation
): (ReplaySeekTarget & { contextId?: string }) | undefined => {
  if (!annotation.id.startsWith(REPLAY_ANNOTATION_PREFIX)) return undefined
  try {
    const value: unknown = JSON.parse(
      decodeURIComponent(annotation.id.slice(REPLAY_ANNOTATION_PREFIX.length))
    )
    if (
      !Array.isArray(value) ||
      (value.length !== 4 && value.length !== 5 && value.length !== 6) ||
      !value
        .slice(0, 4)
        .every((item) => typeof item === 'string' && item.length > 0 && item.length <= 2048)
    )
      return undefined
    if (
      value.length >= 5 &&
      (typeof value[4] !== 'number' || !Number.isFinite(value[4]) || value[4] < 0)
    )
      return undefined
    if (
      value.length === 6 &&
      (typeof value[5] !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value[5]))
    )
      return undefined
    const [projectId, sourceSessionId, branchId, stepId] = value as string[]
    if (annotation.kind !== 'text' || annotation.source.sessionId !== sourceSessionId)
      return undefined
    return {
      projectId,
      sourceSessionId,
      branchId,
      stepId,
      stepOffsetMs: value[4] ?? 0,
      ...(value[5] ? { contextId: value[5] as string } : {})
    }
  } catch {
    return undefined
  }
}

export const referenceReplaySource = (
  doc: ComposerDoc,
  context: Pick<ReplayStepContext, 'sourceSessionId' | 'sourceTitle'>
): ComposerDoc => {
  if (
    doc.nodes.some((node) => node.type === 'session' && node.sessionId === context.sourceSessionId)
  )
    return doc
  if (
    new Set(doc.nodes.flatMap((node) => (node.type === 'session' ? [node.sessionId] : []))).size >=
    MAX_SESSION_REFERENCES_PER_MESSAGE
  )
    throw new Error('Remove a session reference before adding this research.')
  return {
    nodes: [
      { type: 'session', sessionId: context.sourceSessionId, title: context.sourceTitle },
      { type: 'text', text: ' ' },
      ...doc.nodes
    ]
  }
}

// Keep the source identity readable even when a discussion is exported without the local locator.
export const replayQuestionQuote = (
  context: ReplayStepContext,
  limit: number = ANNOTATION_LIMITS.quote
): string => {
  let truncated = false
  const bounded = (text: string, cap: number): string => {
    if (text.length > cap) truncated = true
    return text.slice(0, cap)
  }
  // Reserve space for the actual visible excerpt before the potentially dense evidence index.
  // The full index lives in QuestionContext; exported text remains independently understandable.
  const header = [
    `Research: ${bounded(context.sourceTitle, 240)}`,
    `Source project: ${bounded(context.projectId, 128)}`,
    `Source session: ${bounded(context.sourceSessionId, 128)}`,
    `Source fingerprint: ${bounded(context.fingerprint, 128)}`,
    `Branch: ${bounded(context.branchId, 128)}`,
    `Step: ${bounded(context.stepId, 256)} (+${context.stepOffsetMs} ms)`
  ].join('\n')
  const marker =
    i18next.t('Preview is truncated. Open the evidence for the complete record.') ||
    'Preview is truncated. Open the evidence for the complete record.'
  const budget = Math.max(0, limit - marker.length - 1)
  let text = bounded(header, Math.floor(budget / 2))
  if (context.excerpt)
    text += `\n${bounded(context.excerpt, Math.min(1800, Math.max(0, budget - text.length - 1)))}`
  for (const item of context.evidence) {
    const line = `${item.kind}: ${item.id}${item.versionId ? ` (version ${item.versionId})` : ''}${item.part ? ` [${item.part}]` : ''}`
    if (text.length + line.length + 1 > budget) {
      truncated = true
      continue
    }
    text += `\n${line}`
  }
  return (truncated ? `${text}\n${marker}` : text).slice(0, limit)
}

export const createReplayStepAnnotation = (
  context: ReplayStepContext,
  contextId?: string
): TextAnnotation | undefined => {
  const message = context.evidence.find((item) => item.kind === 'message')
  const activity = context.evidence.find((item) => item.kind === 'activity')
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
        : undefined
  if (!source) return undefined
  return {
    id: replayAnnotationId(context, contextId),
    kind: 'text',
    target: 'agent',
    source,
    quote: replayQuestionQuote(context)
  }
}
