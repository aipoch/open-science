import {
  activateConversationBranch,
  ensureConversationRuntimeSegment,
  forkConversationAfterActivity,
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages,
  type PersistedRuntimeSegment
} from './conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedActiveRun,
  type PersistedChatMessage,
  type PersistedChatSession
} from './session-persistence'
import { z } from 'zod'

const identity = z.string().min(1).max(256)
const commandBase = { id: identity, timestamp: z.number().finite().nonnegative() }
const agentFrameworkId = z.enum(['claude-code', 'opencode', 'codex', 'codebuddy'])
const segmentSchema = z.object({
  id: identity,
  frameworkId: agentFrameworkId,
  providerId: identity.optional(),
  backendId: identity.optional(),
  model: z.string().max(1024).optional(),
  startedAt: z.number().finite().nonnegative()
})
const wireCommands = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({
        ...commandBase,
        kind: z.literal('append-user'),
        branchId: identity,
        parentMessageId: identity.optional(),
        message: z.object({ id: identity, role: z.literal('user') }).passthrough()
      }),
      z.object({
        ...commandBase,
        kind: z.literal('fork-message'),
        branchId: identity,
        parentBranchId: identity,
        messageId: identity
      }),
      z.object({
        ...commandBase,
        kind: z.literal('fork-activity'),
        branchId: identity,
        parentBranchId: identity,
        messageId: identity,
        activityId: identity
      }),
      z.object({
        ...commandBase,
        kind: z.literal('select-branch'),
        branchId: identity,
        previousBranchId: identity
      }),
      z.object({ ...commandBase, kind: z.literal('open-segment'), segment: segmentSchema }),
      z.object({
        ...commandBase,
        kind: z.literal('start-run'),
        run: z.object({ promptMessageId: identity, startedAt: z.number().finite().nonnegative() })
      })
    ])
  )
  .max(256)

export const sanitizeSessionConversationCommands = (
  value: unknown,
  submitted?: PersistedChatSession
): SessionConversationCommand[] => {
  if (value === undefined) return []
  const commands = wireCommands.parse(value)
  return commands.map((command): SessionConversationCommand => {
    if (command.kind !== 'append-user') return command
    // Reuse the already-sanitized Session message; options cannot smuggle an unsanitized message,
    // attribution or file grant past the public Session codec.
    const graphMessage = submitted?.conversationGraph?.messages.find(
      (entry) => entry.id === command.message.id && entry.role === 'user'
    )
    const message =
      graphMessage ??
      submitted?.messages.find((entry) => entry.id === command.message.id && entry.role === 'user')
    if (!message)
      throw new Error('Conversation command user Message is absent from the submitted Session.')
    return {
      ...command,
      message: projectConversationMessage(
        message as Parameters<typeof projectConversationMessage>[0]
      )
    }
  })
}

// User actions carry intent, never a replacement copy of the runtime-owned graph. Stable Message,
// Branch and Segment identities make replay independent of a lost renderer acknowledgement.
export type SessionConversationCommand = {
  id: string
  timestamp: number
} & (
  | {
      kind: 'append-user'
      branchId: string
      parentMessageId?: string
      message: PersistedChatMessage
    }
  | { kind: 'fork-message'; branchId: string; parentBranchId: string; messageId: string }
  | {
      kind: 'fork-activity'
      branchId: string
      parentBranchId: string
      messageId: string
      activityId: string
    }
  | { kind: 'select-branch'; branchId: string; previousBranchId: string }
  | { kind: 'open-segment'; segment: Omit<PersistedRuntimeSegment, 'agentFrameId' | 'endedAt'> }
  | { kind: 'start-run'; run: PersistedActiveRun }
)

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined)
    .sort()
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined)
    .sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key])
    )
  )
}

const sameCommand = (
  left: SessionConversationCommand,
  right: SessionConversationCommand
): boolean => sameValue(left, right)

const projection = (session: PersistedChatSession): PersistedChatSession => {
  const graph = session.conversationGraph!
  return {
    ...session,
    messages: resolveActiveConversationMessages(graph).map(projectConversationMessage),
    ...resolveActiveConversationActivities(graph)
  }
}

export const applySessionConversationCommands = (
  authority: PersistedChatSession,
  commands: readonly SessionConversationCommand[]
): PersistedChatSession => {
  let result: PersistedChatSession = materializeSessionConversationGraph(authority)
  const applied = new Set(authority.runtimeConversationCommandIds ?? [])
  const submittedById = new Map<string, SessionConversationCommand>()
  for (const command of commands) {
    const submitted = submittedById.get(command.id)
    if (submitted && !sameCommand(submitted, command)) {
      throw new Error('Session conversation command identity is already used by another operation.')
    }
    submittedById.set(command.id, command)
    if (applied.has(command.id)) continue
    if (!command.id || !Number.isFinite(command.timestamp)) {
      throw new Error('Invalid Session conversation command identity.')
    }
    let graph = result.conversationGraph!
    const root = graph.frames.find((frame) => frame.id === graph.rootFrameId)
    if (!root || root.kind !== 'root' || root.originBindingState !== 'root') {
      throw new Error('Conversation root Agent Frame is invalid.')
    }
    if (graph.activeFrameId !== graph.rootFrameId) {
      throw new Error('User conversation commands require the root Agent Frame.')
    }
    const branch = graph.branches.find((entry) => entry.id === root.activeBranchId)
    if (!branch || branch.agentFrameId !== root.id) {
      throw new Error('Root Agent Frame active Branch is invalid.')
    }
    switch (command.kind) {
      case 'append-user': {
        if (command.message.role !== 'user') throw new Error('Only user Messages may be submitted.')
        const existing = graph.messages.find((entry) => entry.id === command.message.id)
        if (existing) {
          if (
            existing.agentFrameId !== root.id ||
            existing.introducedOnBranchId !== command.branchId ||
            existing.parentMessageId !== command.parentMessageId ||
            existing.role !== 'user' ||
            !sameValue(projectConversationMessage(existing), command.message)
          ) {
            throw new Error('Conversation Message identity is already used by another operation.')
          }
          break
        }
        if (result.activeRun) {
          throw new Error('Cannot append a user Message while the Session run is active.')
        }
        if (branch.id !== command.branchId || branch.headMessageId !== command.parentMessageId) {
          throw new Error('Conversation Branch changed before the user Message was admitted.')
        }
        graph = synchronizeActiveConversationMessages(
          graph,
          [
            ...resolveActiveConversationMessages(graph).map(projectConversationMessage),
            command.message
          ],
          command.timestamp
        )
        break
      }
      case 'fork-message':
      case 'fork-activity': {
        const existing = graph.branches.find((entry) => entry.id === command.branchId)
        if (existing) {
          if (
            existing.agentFrameId !== root.id ||
            existing.parentBranchId !== command.parentBranchId ||
            existing.createdAt !== command.timestamp ||
            (command.kind === 'fork-message'
              ? existing.supersededMessageId !== command.messageId
              : existing.forkMessageId !== command.messageId ||
                existing.forkActivityId !== command.activityId)
          ) {
            throw new Error('Conversation Branch identity is already used by another operation.')
          }
          break
        }
        if (result.activeRun || branch.id !== command.parentBranchId) {
          throw new Error('Cannot fork a running or changed conversation Branch.')
        }
        graph =
          command.kind === 'fork-message'
            ? forkEditedConversationMessage(
                graph,
                command.messageId,
                command.branchId,
                command.timestamp
              )
            : forkConversationAfterActivity(
                graph,
                command.messageId,
                command.activityId,
                command.branchId,
                command.timestamp
              )
        result = {
          ...result,
          status: 'idle',
          activeRun: undefined,
          error: undefined,
          errorReportable: undefined,
          branchContextResetRequired: true
        }
        break
      }
      case 'select-branch':
        if (
          graph.branches.find((entry) => entry.id === command.branchId)?.agentFrameId !== root.id ||
          graph.branches.find((entry) => entry.id === command.previousBranchId)?.agentFrameId !==
            root.id
        ) {
          throw new Error('Selected Message Branch does not belong to the root Agent Frame.')
        }
        if (branch.id === command.branchId) break
        if (result.activeRun || branch.id !== command.previousBranchId) {
          throw new Error('Cannot select a running or changed conversation Branch.')
        }
        graph = activateConversationBranch(graph, command.branchId)
        result = { ...result, branchContextResetRequired: true }
        break
      case 'open-segment':
        {
          const existing = graph.runtimeSegments.find(
            (segment) => segment.id === command.segment.id
          )
          if (existing) {
            const { agentFrameId, ...existingIntent } = existing
            if (agentFrameId !== root.id || !sameValue(existingIntent, command.segment)) {
              throw new Error('Runtime Segment identity is already used by another operation.')
            }
            break
          }
        }
        graph = ensureConversationRuntimeSegment(graph, {
          ...command.segment,
          frameworkId: agentFrameworkId.parse(command.segment.frameworkId),
          forceNew: true
        })
        result = { ...result, pendingHistoryReplay: result.pendingHistoryReplay ?? { kind: 'all' } }
        break
      case 'start-run': {
        const prompt = resolveActiveConversationMessages(graph).find(
          (message) => message.id === command.run.promptMessageId
        )
        if (prompt?.role !== 'user') throw new Error('Run prompt is not on the selected Branch.')
        if (result.activeRun) {
          if (
            result.activeRun.promptMessageId === command.run.promptMessageId &&
            result.activeRun.startedAt === command.run.startedAt
          )
            break
          throw new Error('Session already has an active run.')
        }
        if (
          result.runtimeTranscriptLastRun?.promptMessageId === command.run.promptMessageId &&
          result.runtimeTranscriptLastRun.startedAt === command.run.startedAt
        )
          break
        if ((result.runtimeTranscriptLastRun?.startedAt ?? -1) >= command.run.startedAt) {
          throw new Error('The requested conversation run has already settled.')
        }
        result = {
          ...result,
          activeRun: command.run,
          status: 'running',
          error: undefined,
          errorReportable: undefined,
          // Resume validates this durable marker after the renderer has prepared its run.
          // Runtime admission consumes it; a different prompt must never inherit it.
          resumeRecovery:
            result.resumeRecovery?.promptMessageId === command.run.promptMessageId
              ? result.resumeRecovery
              : undefined
        }
        break
      }
      default:
        throw new Error('Unknown Session conversation command.')
    }
    applied.add(command.id)
    result = projection({
      ...result,
      conversationGraph: graph,
      updatedAt: Math.max(result.updatedAt, command.timestamp)
    })
  }
  // Old command identities also have structural witnesses (Message/Branch/Segment/last Run).
  // Keep a bounded acknowledgement window for live clients; stale operations outside it must
  // still satisfy their structural preconditions rather than overwriting current state.
  return { ...result, runtimeConversationCommandIds: [...applied].slice(-256) }
}
