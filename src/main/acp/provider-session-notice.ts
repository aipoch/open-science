import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpRuntimeEvent, AcpRuntimeEventLevel } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import { isRecord } from '../value-guards'

// Adapters mark operational text at its source, independently of the framework identifier.
// This marker belongs on agent_message_chunk._meta, never inside model-authored text.
export const PROVIDER_NOTICE_META_KEY = 'open-science/provider-notice'
// Verified legacy Codex adapter notice, emitted as one unscoped assistant chunk.
const CODEX_WEBSOCKET_FALLBACK_WARNING =
  'Warning: Falling back from WebSockets to HTTPS transport. request timed out\n\n'
// Codex ACP 1.6.2 does not provide an AIR record for this fixed, unscoped banner.
const CODEX_CONTEXT_COMPACTED_NOTICE = "*Context compacted to fit the model's context window.*\n\n"
const MAX_NOTICE_TEXT_LENGTH = 2000

/** Inspect the current prompt response, never an uncorrelated session update. */
export function extractProviderPromptFailure(meta: unknown): 'error' | 'invalid' | undefined {
  if (!isRecord(meta) || !isRecord(meta.jetbrains) || !isRecord(meta.jetbrains.air))
    return undefined
  const air = meta.jetbrains.air
  if (!Object.hasOwn(air, 'sessionFailure')) return undefined
  const failure = air.sessionFailure
  if (
    air.version !== 1 ||
    !isRecord(failure) ||
    typeof failure.id !== 'string' ||
    failure.id.length === 0 ||
    typeof failure.revision !== 'number' ||
    !Number.isSafeInteger(failure.revision) ||
    failure.revision < 0 ||
    (failure.severity !== 'warning' && failure.severity !== 'error')
  )
    return 'invalid'
  return failure.severity === 'error' ? 'error' : undefined
}

// Pi 0.1.8 already supplies provenance at these two producers. Accept only their verified
// shapes: extra fields may describe a terminal outcome or an unknown future producer.
function piNoticeLevel(meta: unknown): AcpRuntimeEventLevel | undefined {
  if (!isRecord(meta) || Object.keys(meta).length !== 1 || !isRecord(meta.pi)) return undefined
  const pi = meta.pi
  if (Object.keys(pi).length !== 1) return undefined
  if (Object.hasOwn(pi, 'notice') && pi.notice === 'auto_retry') return 'warning'
  if (
    Object.hasOwn(pi, 'notify') &&
    isRecord(pi.notify) &&
    Object.keys(pi.notify).length === 2 &&
    Object.hasOwn(pi.notify, 'level') &&
    Object.hasOwn(pi.notify, 'message') &&
    typeof pi.notify.message === 'string' &&
    (pi.notify.level === 'info' || pi.notify.level === 'warning' || pi.notify.level === 'error')
  )
    return pi.notify.level
  return undefined
}

/** Separate proven adapter notices from model text without interpreting model prose. */
export function normalizeProviderSessionNotice(
  notification: Readonly<SessionNotification>,
  framework: AgentFrameworkId | undefined,
  event: AcpRuntimeEvent
): AcpRuntimeEvent {
  if (
    notification.update.sessionUpdate !== 'agent_message_chunk' ||
    !isRecord(notification.update.content) ||
    notification.update.content.type !== 'text' ||
    typeof notification.update.content.text !== 'string' ||
    event.kind !== 'message' ||
    event.role !== 'assistant' ||
    typeof event.text !== 'string'
  )
    return event

  const meta = notification.update._meta
  const piLevel =
    framework === 'pi' &&
    notification.update.messageId === undefined &&
    event.messageId === undefined
      ? piNoticeLevel(meta)
      : undefined
  let level: AcpRuntimeEventLevel
  if (meta && Object.hasOwn(meta, PROVIDER_NOTICE_META_KEY)) {
    const notice = meta[PROVIDER_NOTICE_META_KEY]
    if (
      !isRecord(notice) ||
      notice.version !== 1 ||
      (notice.level !== 'info' && notice.level !== 'warning' && notice.level !== 'error')
    )
      return event
    level = notice.level
  } else if (piLevel !== undefined) {
    level = piLevel
  } else if (
    framework === 'codebuddy' &&
    meta &&
    Object.hasOwn(meta, 'codebuddy.ai/hook') &&
    isRecord(meta['codebuddy.ai/hook']) &&
    (meta['codebuddy.ai/hook'].status === 'success' ||
      meta['codebuddy.ai/hook'].status === 'warning') &&
    !Object.hasOwn(meta['codebuddy.ai/hook'], 'stopped') &&
    !Object.hasOwn(meta['codebuddy.ai/hook'], 'blocking') &&
    typeof notification.update.messageId === 'string' &&
    notification.update.messageId.length > 0 &&
    Object.hasOwn(meta, 'codebuddy.ai/messageId') &&
    meta['codebuddy.ai/messageId'] === notification.update.messageId &&
    ![
      'codebuddy.ai/businessFailed',
      'codebuddy.ai/contentFilterNotice',
      'codebuddy.ai/isCompactInternal',
      'codebuddy.ai/compact-limit-reached',
      'codebuddy.ai/compact-cancelled',
      'codebuddy.ai/cancelReason',
      'codebuddy.ai/terminationReason',
      'codebuddy.ai/errorMessage'
    ].some((key) => Object.hasOwn(meta, key))
  ) {
    // Verified CodeBuddy 2.138.0 hook producer already carries typed provenance.
    // Bridge only non-terminal notices; preserve blocked/error hooks and refusals.
    level = meta['codebuddy.ai/hook'].status === 'warning' ? 'warning' : 'info'
  } else if (
    framework === 'codex' &&
    notification.update.messageId === undefined &&
    event.messageId === undefined &&
    (meta === undefined || meta === null || Object.keys(meta).length === 0) &&
    (event.text === CODEX_WEBSOCKET_FALLBACK_WARNING ||
      event.text === CODEX_CONTEXT_COMPACTED_NOTICE)
  ) {
    level = event.text === CODEX_CONTEXT_COMPACTED_NOTICE ? 'info' : 'warning'
  } else {
    return event
  }

  // A notice has no model-message identity, source payload, image or provider metadata.
  return {
    id: event.id,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    kind: 'system',
    level,
    status: 'provider-notice',
    text: event.text.slice(0, MAX_NOTICE_TEXT_LENGTH)
  }
}
