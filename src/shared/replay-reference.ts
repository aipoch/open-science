import type { Annotation } from './annotations'

export type ReplayReferenceTarget = {
  projectId: string
  sourceSessionId: string
  branchId: string
  stepId: string
  stepOffsetMs?: number
  scope?: 'step' | 'session'
}

const REPLAY_ANNOTATION_PREFIX = 'research-replay:'

// An existing annotation ID carries a local replay locator. Its source and quote remain ordinary
// annotation fields, so exported history uses the current .science message contract unchanged.
export const replayAnnotationId = (context: ReplayReferenceTarget, contextId?: string): string =>
  REPLAY_ANNOTATION_PREFIX +
  encodeURIComponent(
    JSON.stringify([
      context.projectId,
      context.sourceSessionId,
      context.branchId,
      context.stepId,
      context.stepOffsetMs ?? 0,
      ...(context.scope ? [contextId ?? null, context.scope] : contextId ? [contextId] : [])
    ])
  )

export const replayAnnotationTarget = (
  annotation: Annotation
): (ReplayReferenceTarget & { contextId?: string }) | undefined => {
  if (!annotation.id.startsWith(REPLAY_ANNOTATION_PREFIX)) return undefined
  try {
    const value: unknown = JSON.parse(
      decodeURIComponent(annotation.id.slice(REPLAY_ANNOTATION_PREFIX.length))
    )
    if (
      !Array.isArray(value) ||
      value.length < 4 ||
      value.length > 7 ||
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
      value.length >= 6 &&
      !(value.length === 7 && value[5] === null) &&
      (typeof value[5] !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value[5]))
    )
      return undefined
    if (value.length === 7 && value[6] !== 'step' && value[6] !== 'session') return undefined
    const [projectId, sourceSessionId, branchId, stepId] = value as string[]
    if (annotation.kind !== 'text' || annotation.source.sessionId !== sourceSessionId)
      return undefined
    return {
      projectId,
      sourceSessionId,
      branchId,
      stepId,
      stepOffsetMs: value[4] ?? 0,
      ...(value[5] ? { contextId: value[5] as string } : {}),
      ...(value.length === 7 ? { scope: value[6] as 'step' | 'session' } : {})
    }
  } catch {
    return undefined
  }
}

// A local reference travels as ordinary, readable MessagePart text. It adds no .science fields.
// Source Project identity travels with new references; bare legacy UUIDs use the message Project.
export type ReplayReferenceTextPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'reference'
      text: string
      id: string
      projectId?: string
      label: string
    }
export const replayReferenceText = (id: string, label: string, projectId?: string): string =>
  `[${label.replace(/[[\]\r\n]/g, ' ')}](#research-replay:${projectId ? `${encodeURIComponent(projectId)}:` : ''}${id})`

export const splitReplayReferenceText = (text: string): ReplayReferenceTextPart[] => {
  const pattern =
    /\[([^\]\n]{1,200})\]\(#research-replay:(?:([a-zA-Z0-9%_.~-]{1,1536}):)?([a-zA-Z0-9-]{1,100})\)/g
  const parts: ReplayReferenceTextPart[] = []
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index > offset) parts.push({ kind: 'text', text: text.slice(offset, index) })
    let projectId: string | undefined
    try {
      projectId = match[2] ? decodeURIComponent(match[2]) : undefined
    } catch {
      parts.push({ kind: 'text', text: match[0] })
      offset = index + match[0].length
      continue
    }
    parts.push({
      kind: 'reference',
      text: match[0],
      label: match[1],
      id: match[3],
      ...(projectId ? { projectId } : {})
    })
    offset = index + match[0].length
  }
  if (offset < text.length) parts.push({ kind: 'text', text: text.slice(offset) })
  return parts
}

// Navigation IDs stay in application state. The Agent receives only the selected source content.
export const selectedSessionQuote = (
  context: Pick<
    import('./session-replay').SessionDiscussionSnapshot,
    'sourceTitle' | 'stepTitle' | 'phase' | 'records' | 'excerpt'
  >,
  limit = 4000
): string => {
  const selected = context.records?.filter((record) => record.scope === 'step')
  const content = selected
    ? selected
        .map((record) =>
          [record.text, record.status === 'unavailable' ? 'Content unavailable.' : '']
            .filter(Boolean)
            .join('\n')
        )
        .filter(Boolean)
        .join('\n\n')
    : context.excerpt
  const text = [
    `Session: ${context.sourceTitle.replace(/[\r\n]/g, ' ').slice(0, 240)}`,
    context.stepTitle ? context.stepTitle.slice(0, 240) : undefined,
    context.phase === 'input' ? 'Only the input was visible; no output is included.' : undefined,
    content || 'Selected content unavailable.'
  ]
    .filter(Boolean)
    .join('\n')
  const marker = '\n[Selected content is incomplete or truncated.]'
  return text.length > limit || selected?.some((record) => record.truncated)
    ? text.slice(0, Math.max(0, limit - marker.length)) + marker
    : text
}
