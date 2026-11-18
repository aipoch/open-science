import { projectConversationMessage } from '../../shared/conversation-graph'
import {
  retainRecentSessionEventIds,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedToolActivity
} from '../../shared/session-persistence'
import type { PersistedSessionFile } from '../../shared/session-persistence-envelope'
import { encodeDataPath } from '../storage/data-path'
import type { SessionJournalRead } from './journal'
import type { MainSessionSaveOptions } from './save-session'

const sameEntries = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

const compactMessage = <T extends PersistedChatMessage>(message: T): T => ({
  ...message,
  uploads: undefined,
  images: undefined,
  annotations: undefined,
  eventIds:
    message.status === 'streaming'
      ? message.eventIds
      : retainRecentSessionEventIds(message.eventIds)
})

const compactActivity = <T extends PersistedToolActivity>(activity: T): T =>
  activity.status === 'pending' || activity.status === 'in_progress'
    ? activity
    : { ...activity, eventIds: retainRecentSessionEventIds(activity.eventIds) }

// Preserve the existing canonical arrays and ordering. Only changed records are encoded again;
// this still walks IDs, but never inspects the content of unchanged messages or tool results.
const replaceChanged = <T extends { id: string }>(
  current: readonly T[],
  previous: readonly T[],
  changed: ReadonlySet<string>,
  encode: (record: T) => T = (record) => record
): T[] | undefined => {
  const byId = new Map(previous.map((record) => [record.id, record]))
  const result: T[] = []
  for (const record of current) {
    const stored = changed.has(record.id) ? encode(record) : byId.get(record.id)
    if (!stored) return undefined
    result.push(stored)
  }
  return result
}

// Only the Main reducer can supply this evidence. Images/annotations/uploads and complex
// mutations use the existing full codec so its aggregate budgets and migration rules still apply.
export const createRuntimeSessionFile = (
  session: PersistedChatSession,
  authority: SessionJournalRead | undefined,
  evidence: MainSessionSaveOptions['runtimeChanges']
): PersistedSessionFile | undefined => {
  if (!evidence || authority?.format !== 'journal') return undefined
  const { previous, changes } = evidence
  const graph = session.conversationGraph
  const previousGraph = previous.conversationGraph
  const stored = authority.document as unknown as PersistedSessionFile
  const storedGraph = stored.session?.conversationGraph
  if (
    stored.version !== 2 ||
    !graph ||
    !previousGraph ||
    !storedGraph ||
    previous.id !== session.id ||
    previous.projectId !== session.projectId ||
    stored.session.id !== session.id ||
    (previous.revision ?? 0) !== authority.revision ||
    previous.recordProblems?.length ||
    session.artifacts !== previous.artifacts ||
    !sameEntries(graph.frames, previousGraph.frames) ||
    !sameEntries(graph.runtimeSegments, previousGraph.runtimeSegments) ||
    changes.messages.some(
      (message) => message.uploads?.length || message.images?.length || message.annotations?.length
    )
  )
    return undefined

  const messageIds = new Set(changes.messages.map(({ id }) => id))
  const activityIds = new Set(changes.activities.map(({ id }) => id))
  const groupIds = new Set(changes.activityGroups.map(({ id }) => id))
  const branchIds = new Set(changes.branches.map(({ id }) => id))
  // The full codec refreshes the active branch timestamp even for tool-only batches.
  const activeBranchId = graph.frames.find(({ id }) => id === graph.activeFrameId)?.activeBranchId
  if (activeBranchId) branchIds.add(activeBranchId)
  const messages = replaceChanged(graph.messages, storedGraph.messages, messageIds, compactMessage)
  const activities = replaceChanged(
    graph.activities,
    storedGraph.activities,
    activityIds,
    compactActivity
  )
  const activityGroups = replaceChanged(graph.activityGroups, storedGraph.activityGroups, groupIds)
  const branches = replaceChanged(graph.branches, storedGraph.branches, branchIds, (branch) =>
    branch.id === activeBranchId ? { ...branch, updatedAt: session.updatedAt } : branch
  )
  if (!messages || !activities || !activityGroups || !branches) return undefined
  const flatMessages = replaceChanged(
    session.messages,
    stored.session.messages,
    messageIds,
    (m) => {
      const node = messages.find(({ id }) => id === m.id)
      return node ? projectConversationMessage(node) : compactMessage(m)
    }
  )
  const flatActivities = replaceChanged(
    session.activities ?? [],
    stored.session.activities ?? [],
    activityIds,
    compactActivity
  )
  const flatGroups = replaceChanged(
    session.activityGroups ?? [],
    stored.session.activityGroups ?? [],
    groupIds
  )
  if (!flatMessages || !flatActivities || !flatGroups) return undefined

  const { recordProblems: ignored, ...durable } = session
  void ignored
  return {
    version: 2,
    session: {
      ...durable,
      cwd: encodeDataPath(session.cwd) as string,
      messages: flatMessages,
      activities: flatActivities,
      activityGroups: session.activityGroups === undefined ? undefined : flatGroups,
      artifacts: stored.session.artifacts,
      conversationGraph: {
        ...graph,
        frames: storedGraph.frames,
        runtimeSegments: storedGraph.runtimeSegments,
        messages,
        activities,
        activityGroups,
        branches
      }
    }
  }
}
