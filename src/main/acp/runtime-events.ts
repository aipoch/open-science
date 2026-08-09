import type { ContentBlock, SessionNotification, ToolCallContent } from '@agentclientprotocol/sdk'

import {
  ACP_MESSAGE_IMAGE_EVENT_TEXT,
  normalizeClaudeCodeRefusalText,
  sanitizeAcpMessageImage,
  type AcpRuntimeEvent
} from '../../shared/acp'

// Bounds how much of a failed tool's result text reaches the log, so large or sensitive tool output
// cannot flood it. Tuned to fit a typical error message (e.g. WebFetch's domain-safety preflight).
const TOOL_FAILURE_TEXT_LIMIT = 300
const MAX_RUNTIME_RAW_PAYLOAD_CHARS = 8_000
const MAX_SKILL_NAME_CHARS = 200
const SKILL_TOOL_TITLE_PATTERN = /^(?:run|loaded)\s+skill(?:\?|:|\s|$)/iu
const SKILL_CONTENT_PATTERN = /^\s*<skill_content(?:\s|>)/iu

// Narrows protocol extension values before reading provider-specific metadata.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Trims provider strings so blank metadata cannot override safer fallbacks.
const trimProviderValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined

  const trimmedValue = value.trim()

  return trimmedValue ? trimmedValue : undefined
}

const containsControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)

    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })

// Keeps small JSON payloads for activity details while dropping values that would make runtime
// snapshots expensive or impossible to structured-clone across IPC.
const sanitizeRawToolPayload = (value: unknown): unknown | undefined => {
  if (value === undefined || value === null) return undefined

  try {
    const serialized = JSON.stringify(value)

    if (serialized === undefined || serialized.length > MAX_RUNTIME_RAW_PAYLOAD_CHARS) {
      return undefined
    }

    return JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

// Extracts a safe tool identity (e.g. "WebFetch") from ACP extension metadata without exposing
// arguments. Accepts anything carrying `_meta`, so both stream updates and permission tool calls reuse it.
const extractProviderToolName = (source: { _meta?: unknown } | undefined): string | undefined => {
  const meta = source?._meta

  if (!isRecord(meta)) return undefined

  const claudeCodeMeta = meta.claudeCode

  if (isRecord(claudeCodeMeta)) {
    const claudeToolName = trimProviderValue(claudeCodeMeta.toolName)

    if (claudeToolName) return claudeToolName
  }

  return trimProviderValue(meta.toolName) ?? trimProviderValue(meta.tool_name)
}

type TerminalMeta = {
  terminalOutput?: string
  terminalExitCode?: number | null
}

// Extracts streamed Bash stdout/stderr and exit code from ACP terminal extension metadata.
const extractTerminalMeta = (update: SessionNotification['update']): TerminalMeta => {
  const meta = (update as { _meta?: unknown })._meta

  if (!isRecord(meta)) return {}

  const result: TerminalMeta = {}
  const terminalOutput = meta.terminal_output

  if (isRecord(terminalOutput) && typeof terminalOutput.data === 'string') {
    result.terminalOutput = terminalOutput.data
  }

  const terminalExit = meta.terminal_exit
  const exitCode = isRecord(terminalExit) ? terminalExit.exit_code : undefined

  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) {
    result.terminalExitCode = exitCode
  }

  return result
}

// Converts rich protocol content blocks into compact text for runtime output.
const contentToText = (content: ContentBlock): string => {
  switch (content.type) {
    case 'text':
      return content.text
    case 'image':
      return `[image: ${content.mimeType}]`
    case 'audio':
      return `[audio: ${content.mimeType}]`
    case 'resource_link':
      return content.name ? `[resource: ${content.name}]` : '[resource]'
    case 'resource':
      return content.resource.uri ? `[resource: ${content.resource.uri}]` : '[resource]'
    default:
      return '[content]'
  }
}

// Image notifications can carry megabytes of base64. Keep only bounded display data on the event;
// the internal text sentinel lets the existing runtime projection forward image-only messages.
const normalizeMessageContent = (
  content: ContentBlock,
  normalizeClaudeCodeRefusal = false
): Pick<AcpRuntimeEvent, 'text' | 'image'> => {
  if (content.type !== 'image') {
    const text = contentToText(content)
    return {
      text: normalizeClaudeCodeRefusal ? normalizeClaudeCodeRefusalText(text) : text
    }
  }

  const image = sanitizeAcpMessageImage(content)

  return image
    ? { image, text: ACP_MESSAGE_IMAGE_EVENT_TEXT }
    : { text: 'Agent image omitted because its type or size is unsupported.' }
}

const imageNotificationMetadata = (
  notification: SessionNotification,
  image: NonNullable<AcpRuntimeEvent['image']> | undefined
): unknown => ({
  sessionId: notification.sessionId,
  update: {
    sessionUpdate: notification.update.sessionUpdate,
    messageId:
      'messageId' in notification.update ? (notification.update.messageId ?? undefined) : undefined,
    content: image
      ? {
          type: 'image',
          mimeType: image.mimeType,
          data: image.data,
          byteLength: image.byteLength
        }
      : { type: 'image', omitted: true }
  }
})

// Extracts a bounded, text-only reason from a failed tool call's content for logging. Only text blocks
// are read (never raw arguments, diffs, or terminal output) and the result is truncated, so a failure is
// diagnosable without spilling large or sensitive tool output into the log.
const extractToolFailureText = (content: ToolCallContent[] | undefined): string | undefined => {
  if (!content) return undefined

  const text = content
    .map((item) => (item.type === 'content' ? contentToText(item.content) : ''))
    .filter(Boolean)
    .join(' ')
    .trim()

  if (!text) return undefined

  return text.length > TOOL_FAILURE_TEXT_LIMIT ? `${text.slice(0, TOOL_FAILURE_TEXT_LIMIT)}…` : text
}

type ToolCallUpdate = Extract<
  SessionNotification['update'],
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>

// codex-acp represents native automatic and manual context compaction as a tool lifecycle with a
// structural metadata marker. Normalize it before generic tool projection so every framework reaches
// the renderer through the same compaction interface.
const isContextCompactionUpdate = (update: ToolCallUpdate): boolean => {
  const meta = update._meta

  return isRecord(meta) && meta.contextCompaction === true
}

const projectContextCompactionUpdate = (
  update: ToolCallUpdate
): Pick<AcpRuntimeEvent, 'kind' | 'status' | 'title' | 'toolCallId'> => {
  const status =
    update.status ?? (update.sessionUpdate === 'tool_call_update' ? 'completed' : 'in_progress')
  const title =
    status === 'completed'
      ? 'Context compacted'
      : status === 'failed'
        ? 'Context compaction failed'
        : 'Compacting context'

  return {
    kind: 'compaction',
    status,
    title,
    toolCallId: update.toolCallId
  }
}

// Native Skill calls return their instruction document as a tool result. It is agent context, not
// user-facing output, so do not send it through the activity, IPC, or persistence pipelines.
const isNativeSkillToolUpdate = (update: ToolCallUpdate): boolean => {
  const title = trimProviderValue(update.title)
  const providerToolName = extractProviderToolName(update)?.toLowerCase()
  const containsSkillContent = update.content?.some(
    (item) =>
      item.type === 'content' &&
      item.content.type === 'text' &&
      SKILL_CONTENT_PATTERN.test(item.content.text)
  )

  return (
    providerToolName === 'skill' ||
    (title !== undefined && SKILL_TOOL_TITLE_PATTERN.test(title)) ||
    containsSkillContent === true
  )
}

// Keeps the single user-facing identity field from a native Skill call without retaining its input
// object or instruction document. Generic follow-up titles are omitted so they cannot overwrite the
// canonical name captured from the initial event in the renderer activity store.
const projectToolTitle = (update: ToolCallUpdate): string | undefined => {
  if (!isNativeSkillToolUpdate(update)) return update.title ?? undefined

  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined
  const skillName = trimProviderValue(rawInput?.name)

  if (
    skillName &&
    skillName.length <= MAX_SKILL_NAME_CHARS &&
    !containsControlCharacter(skillName)
  ) {
    return `Loaded skill: ${skillName}`
  }

  return trimProviderValue(update.title)?.toLowerCase() === 'skill'
    ? undefined
    : (update.title ?? undefined)
}

// Projects activity detail fields only for tools whose payload is safe and useful to show.
const projectToolDetailPayload = (update: ToolCallUpdate): Partial<AcpRuntimeEvent> => {
  if (isNativeSkillToolUpdate(update)) return {}

  return {
    toolContent: update.content ?? undefined,
    toolLocations: update.locations ?? undefined,
    rawInput: sanitizeRawToolPayload(update.rawInput),
    rawOutput: sanitizeRawToolPayload(update.rawOutput),
    ...extractTerminalMeta(update)
  }
}

// Normalizes protocol session notifications into a renderer-friendly event shape.
const toAcpRuntimeEvent = (
  notification: SessionNotification,
  id: string,
  timestamp = Date.now(),
  normalizeClaudeCodeRefusal = false
): AcpRuntimeEvent => {
  const { sessionId, update } = notification
  const base = {
    id,
    timestamp,
    sessionId,
    level: 'info' as const,
    raw: notification
  }

  // Group protocol update variants into the small set of event kinds the UI renders.
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const messageContent = normalizeMessageContent(update.content, normalizeClaudeCodeRefusal)

      return {
        ...base,
        kind: 'message',
        role: 'assistant',
        messageId: update.messageId ?? undefined,
        ...messageContent,
        ...(update.content.type === 'image'
          ? { raw: imageNotificationMetadata(notification, messageContent.image) }
          : {})
      }
    }
    case 'user_message_chunk': {
      const messageContent = normalizeMessageContent(update.content)

      return {
        ...base,
        kind: 'message',
        role: 'user',
        messageId: update.messageId ?? undefined,
        ...messageContent,
        ...(update.content.type === 'image'
          ? { raw: imageNotificationMetadata(notification, messageContent.image) }
          : {})
      }
    }
    case 'agent_thought_chunk':
      return {
        ...base,
        kind: 'thought',
        role: 'assistant',
        messageId: update.messageId ?? undefined,
        text: contentToText(update.content)
      }
    case 'tool_call':
      if (isContextCompactionUpdate(update)) {
        return {
          ...base,
          raw: undefined,
          ...projectContextCompactionUpdate(update)
        }
      }
      // Tool events expose only the bounded fields consumed by the UI. Do not retain the original
      // notification because it duplicates the unbounded arguments and results inside `raw`.
      return {
        ...base,
        raw: undefined,
        kind: 'tool',
        toolCallId: update.toolCallId,
        providerToolName: extractProviderToolName(update),
        toolKind: update.kind,
        ...projectToolDetailPayload(update),
        title: projectToolTitle(update),
        status: update.status
      }
    case 'tool_call_update':
      if (isContextCompactionUpdate(update)) {
        return {
          ...base,
          raw: undefined,
          ...projectContextCompactionUpdate(update)
        }
      }
      // Tool updates stay compact and do not expose future preview metadata assumptions.
      return {
        ...base,
        raw: undefined,
        kind: 'tool',
        toolCallId: update.toolCallId,
        providerToolName: extractProviderToolName(update),
        toolKind: update.kind ?? undefined,
        ...projectToolDetailPayload(update),
        title: projectToolTitle(update),
        status: update.status ?? undefined
      }
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
      return {
        ...base,
        kind: 'plan',
        title: 'Plan update',
        text: update.sessionUpdate
      }
    case 'usage_update':
      // Carry the real numbers on the event so the runtime can record context usage by session. The
      // runtime consumes this and suppresses the event, so it never appears as conversation noise.
      return {
        ...base,
        kind: 'system',
        title: 'Context usage update',
        text: 'Context usage changed',
        contextUsage: {
          used: update.used,
          size: update.size
        }
      }
    case 'available_commands_update':
    case 'config_option_update':
    case 'current_mode_update':
    case 'session_info_update':
      return {
        ...base,
        kind: 'system',
        title: update.sessionUpdate,
        text: update.sessionUpdate
      }
    default:
      return {
        ...base,
        kind: 'raw',
        title: 'ACP update',
        text: 'Unrecognized ACP update'
      }
  }
}

export {
  extractProviderToolName,
  extractTerminalMeta,
  extractToolFailureText,
  isNativeSkillToolUpdate,
  toAcpRuntimeEvent
}
