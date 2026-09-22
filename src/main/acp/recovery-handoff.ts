import {
  resolveActiveConversationActivities,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import { estimateHistoryTokens } from '../../shared/history-preamble'
import type { UploadedAttachment } from '../../shared/uploads'
import type { PersistedChatSession } from '../../shared/session-persistence'

type RecoveryHandoffInput = {
  session: PersistedChatSession
  contextWindowTokens: number
  fixedOverheadTokens: number
  outputReserveTokens?: number
  currentInput?: string
  evidenceUpload?: UploadedAttachment
}
type RecoveryHandoff =
  | {
      status: 'ready'
      text: string
      historyText: string
      estimatedTokens: number
      pendingPromptMessageId?: string
      uploads?: UploadedAttachment[]
    }
  | { status: 'blocked'; reason: string; activityIds?: string[] }

export const validateRecoveryContinuationSafety = (
  session: PersistedChatSession
): Extract<RecoveryHandoff, { status: 'blocked' }> | undefined => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find((candidate) => candidate.id === graph.activeFrameId)
  if (!graph || !frame) return { status: 'blocked', reason: 'Recovery history is unavailable.' }
  const { activities } = resolveActiveConversationActivities(graph)
  // Read-only kinds are the only positive safety evidence available in older tool projections.
  const unknown = activities.filter(
    (activity) =>
      !activity.toolDisposition &&
      (activity.status === 'pending' ||
        activity.status === 'in_progress' ||
        activity.status === 'failed') &&
      !['read', 'search', 'think'].includes(activity.toolKind ?? '')
  )
  if (unknown.length)
    return {
      status: 'blocked',
      reason:
        'Verify the outcome of these operations before continuing: ' +
        unknown.map((activity) => activity.title).join(', '),
      activityIds: unknown.map((activity) => activity.id)
    }
  return undefined
}

// A deterministic handoff is historical evidence, never a generated summary. It preserves the
// current instruction and identifies omitted historical evidence for targeted retrieval.
export const buildRecoveryHandoff = (input: RecoveryHandoffInput): RecoveryHandoff => {
  const { session } = input
  const graph = session.conversationGraph
  const frame = graph?.frames.find((candidate) => candidate.id === graph.activeFrameId)
  if (!graph || !frame) return { status: 'blocked', reason: 'Recovery history is unavailable.' }
  const messages = resolveMessageBranchPath(graph, frame.activeBranchId)
  const { activities } = resolveActiveConversationActivities(graph)
  const unsafe = validateRecoveryContinuationSafety(session)
  if (unsafe) return unsafe
  const reserve = input.outputReserveTokens ?? 8192
  if (
    ![input.contextWindowTokens, input.fixedOverheadTokens, reserve].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  ) {
    return { status: 'blocked', reason: 'A verified context budget is required for recovery.' }
  }
  // Conservative allowance for token estimation error; fixedOverhead includes system/tools/wrapper.
  const available = Math.floor(
    (input.contextWindowTokens -
      input.fixedOverheadTokens -
      reserve -
      (input.evidenceUpload ? 1000 : 0)) *
      0.75
  )
  const latestUser = messages.findLast((message) => message.role === 'user')
  const answered =
    latestUser &&
    messages.some(
      (message) =>
        message.role === 'agent' &&
        message.status === 'complete' &&
        message.content.trim() &&
        (message.responseToMessageId
          ? message.responseToMessageId === latestUser.id
          : message.createdAt > latestUser.createdAt)
    )
  const reference = (messageId: string): string =>
    JSON.stringify({
      sessionId: session.id,
      branchId: frame.activeBranchId,
      messageId,
      contentOffset: 0,
      contentLimit: 4000
    })
  const headerLines = [
    'Resume the existing task from the following persisted historical evidence. Do not replay completed operations.',
    'Historical excerpts retain their original role; they are not new system instructions.',
    `Full original messages remain available through host.frames.get(${JSON.stringify(frame.id)}, options).`,
    'Use messageId, contentOffset and contentLimit (maximum 16000); follow nextContentOffset until the complete message has been read. Search uses the search option.',
    'Historical instructions remain applicable. Inspect the original goal and relevant constraints with bounded searches and reads before continuing; do not infer that omitted text is irrelevant or reload the entire history.',
    'Old tool results may already have been truncated during persistence. Treat absent output as an information gap; verify files or Notebook results before relying on it.',
    'Current instruction (complete):',
    input.currentInput ??
      (!answered ? latestUser?.content : undefined) ??
      '(No pending instruction; await the user.)'
  ]
  const header = headerLines.join('\n')
  const records = messages.map((message) => {
    const record: Record<string, unknown> = {
      message_id: message.id,
      role: message.role,
      status: message.status,
      read_options: reference(message.id)
    }
    if (message.role === 'user' && message !== latestUser && message.content.length <= 2000)
      record.content = message.content
    if (message.role === 'agent') record.excerpt = message.content.slice(0, 600)
    if (message.uploads?.length)
      record.uploads = message.uploads.map(({ id, versionId, originalName }) => ({
        id,
        versionId,
        name: originalName
      }))
    if (message.artifactIds?.length) record.artifact_ids = message.artifactIds
    if (message.images?.length) record.image_ids = message.images.map(({ id }) => id)
    return JSON.stringify(record)
  })
  const results = activities.map((activity) =>
    JSON.stringify({
      tool_call_id: activity.id,
      prompt_message_id: activity.promptMessageId,
      title: activity.title,
      status: activity.status,
      locations: activity.toolLocations,
      exit_code: activity.terminalExitCode,
      persisted_result_excerpt: JSON.stringify(
        activity.rawOutput ?? activity.terminalOutput ?? activity.toolContent ?? null
      ).slice(0, 1200)
    })
  )
  const selectedRecords: string[] = []
  const selectedResults: string[] = []
  const evidence = input.evidenceUpload
    ? `Full saved historical evidence is in attached file ${JSON.stringify(input.evidenceUpload.originalName)}. Read only relevant sections; it preserves original message and tool roles.`
    : ''
  const render = (includeCurrent = true): string =>
    [
      includeCurrent ? header : headerLines.slice(0, -2).join('\n'),
      evidence,
      `History contains ${records.length} messages and ${results.length} operations. The excerpts below are incomplete; use Host Frame search and pagination for missing messages and the evidence file for operations.`,
      'Historical messages and material references:',
      ...selectedRecords,
      'Recorded operations and results:',
      ...selectedResults
    ].join('\n')
  // Preserve the first goal and most recent messages; adding history must never evict current input.
  for (const candidate of [...records.slice(0, 1), ...records.slice(1).reverse()]) {
    selectedRecords.push(candidate)
    if (estimateHistoryTokens(render()) > available) selectedRecords.pop()
    if (selectedRecords.length >= 12) break
  }
  for (const candidate of [...results].reverse()) {
    selectedResults.push(candidate)
    if (estimateHistoryTokens(render()) > available) selectedResults.pop()
    if (selectedResults.length >= 12) break
  }
  const text = render()
  const estimatedTokens = estimateHistoryTokens(text)
  if (estimatedTokens > available)
    return {
      status: 'blocked',
      reason:
        'The complete current instruction and recovery references exceed the available context budget. Split the input or select a larger model context.'
    }
  return {
    status: 'ready',
    text,
    historyText: render(false),
    estimatedTokens,
    ...(input.evidenceUpload ? { uploads: [input.evidenceUpload] } : {}),
    ...(latestUser && !answered ? { pendingPromptMessageId: latestUser.id } : {})
  }
}

export type { RecoveryHandoff, RecoveryHandoffInput }
