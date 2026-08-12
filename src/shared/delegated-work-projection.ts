import { resolveMessageBranchPath, type PersistedAgentFrame } from './conversation-graph'
import type { PersistedChatSession } from './session-persistence'

// Resource-safety checks (quit, migration, archive) must consider every delegated record in the
// Session, including work attached to an inactive conversation branch. An Attempt is "current" only
// when it is the record's latest Attempt; an older running value is historical once a continuation
// has appended a newer terminal Attempt.
const hasCurrentRunningDelegatedAttempt = (
  session: Pick<PersistedChatSession, 'runtimeContext'> | undefined
): boolean =>
  session?.runtimeContext?.delegatedWork?.records.some(
    (record) => record.attempts.at(-1)?.status === 'running'
  ) === true

const earliestCurrentDelegatedAttemptStartedAt = (
  session: Pick<PersistedChatSession, 'runtimeContext'> | undefined
): number | undefined => {
  const startedAt =
    session?.runtimeContext?.delegatedWork?.records.flatMap((record) => {
      const attempt = record.attempts.at(-1)
      return attempt?.status === 'running' ? [attempt.startedAt] : []
    }) ?? []
  return startedAt.length > 0 ? Math.min(...startedAt) : undefined
}

const resolveActiveRootMessageIds = (
  graph: NonNullable<PersistedChatSession['conversationGraph']>
): ReadonlySet<string> | undefined => {
  const root = graph.frames.find((frame) => frame.id === graph.rootFrameId)
  if (!root) return undefined
  try {
    return new Set(resolveMessageBranchPath(graph, root.activeBranchId).map(({ id }) => id))
  } catch {
    return undefined
  }
}

const projectActiveRootDelegatedFrames = (
  session: Pick<PersistedChatSession, 'conversationGraph'> | undefined
): readonly PersistedAgentFrame[] => {
  const graph = session?.conversationGraph
  if (!graph) return []
  const activeRootMessageIds = resolveActiveRootMessageIds(graph)
  if (!activeRootMessageIds) return []

  return graph.frames.filter(
    (frame) =>
      frame.kind === 'delegate' &&
      frame.parentFrameId === graph.rootFrameId &&
      (frame.originBindingState === 'legacy-unavailable' ||
        (frame.originBindingState === 'validated' &&
          Boolean(frame.originMessageId && activeRootMessageIds.has(frame.originMessageId))))
  )
}

export {
  earliestCurrentDelegatedAttemptStartedAt,
  hasCurrentRunningDelegatedAttempt,
  projectActiveRootDelegatedFrames,
  resolveActiveRootMessageIds
}
