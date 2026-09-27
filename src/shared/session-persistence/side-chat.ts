import type {
  PersistedSideChatLifecycle,
  PersistedSideChatRelay,
  PersistedSideChat
} from '../session-runtime-context'
import { type SideChatEntry, SIDE_CHAT_MESSAGE_LIMIT } from '../side-chat'
import {
  isRecord,
  asBoundedString,
  asString,
  hasOnlyKeys,
  asNumber,
  AGENT_FRAMEWORK_IDS
} from './primitives'
import { type AgentFrameworkId, isReasoningEffort } from '../settings'

const SIDE_CHAT_LIFECYCLES = new Set<PersistedSideChatLifecycle>(['open', 'interrupted', 'error'])

const MAX_SIDE_CHAT_ENTRIES = 1_000

export const MAX_SIDE_CHAT_RELAYS = 100

const MAX_SIDE_CHAT_JSON_CHARS = 2_000_000

const MAX_SIDE_CHAT_ID_CHARS = 256

const MAX_SIDE_CHAT_OPAQUE_CHARS = 1_024

const MAX_SIDE_CHAT_TOOL_TITLE_CHARS = 1_024

const MAX_SIDE_CHAT_TOOL_STATUS_CHARS = 128

const sanitizeSideChatEntry = (value: unknown): SideChatEntry | undefined => {
  if (!isRecord(value)) return undefined
  const id = asBoundedString(value.id, MAX_SIDE_CHAT_ID_CHARS)
  const kind = asString(value.kind)
  if (!id) return undefined

  if (kind === 'message') {
    if (!hasOnlyKeys(value, ['id', 'kind', 'role', 'text'])) return undefined
    const role = asString(value.role)
    const text = asBoundedString(value.text, SIDE_CHAT_MESSAGE_LIMIT)
    if ((role !== 'user' && role !== 'assistant') || text === undefined) return undefined
    return { id, kind, role, text }
  }

  if (kind === 'tool') {
    if (!hasOnlyKeys(value, ['id', 'kind', 'title', 'status'])) return undefined
    const title = asBoundedString(value.title, MAX_SIDE_CHAT_TOOL_TITLE_CHARS)
    const status =
      value.status === undefined
        ? undefined
        : asBoundedString(value.status, MAX_SIDE_CHAT_TOOL_STATUS_CHARS)
    if (!title || (value.status !== undefined && status === undefined)) return undefined
    return { id, kind, title, ...(status !== undefined ? { status } : {}) }
  }

  return undefined
}

export const sanitizePersistedSideChatRelay = (
  value: unknown,
  legacySideChatId?: string
): PersistedSideChatRelay | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'sideChatId', 'text', 'createdAt'])) {
    return undefined
  }
  const id = asBoundedString(value.id, MAX_SIDE_CHAT_ID_CHARS)
  const sideChatId =
    value.sideChatId === undefined
      ? legacySideChatId
      : asBoundedString(value.sideChatId, MAX_SIDE_CHAT_ID_CHARS)
  const text = asBoundedString(value.text, SIDE_CHAT_MESSAGE_LIMIT)
  const createdAt = asNumber(value.createdAt)
  if (
    !id ||
    !sideChatId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sideChatId) ||
    (legacySideChatId !== undefined && sideChatId !== legacySideChatId) ||
    !text?.trim() ||
    createdAt === undefined ||
    createdAt < 0
  ) {
    return undefined
  }
  return { id, sideChatId, text, createdAt }
}

export const sanitizePersistedSideChatWithLegacyRelays = (
  value: unknown
):
  | Readonly<{
      sideChat: PersistedSideChat
      legacyRelays: readonly PersistedSideChatRelay[]
    }>
  | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !hasOnlyKeys(value, [
      'version',
      'id',
      'lifecycle',
      'frameworkId',
      'providerId',
      'backendId',
      'providerSessionId',
      'providerContinuityToken',
      'model',
      'reasoningEffort',
      'historyPreamble',
      'entries',
      'pendingRelays',
      'createdAt',
      'updatedAt'
    ]) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_SIDE_CHAT_ENTRIES ||
    (value.pendingRelays !== undefined &&
      (!Array.isArray(value.pendingRelays) || value.pendingRelays.length > MAX_SIDE_CHAT_RELAYS))
  ) {
    return undefined
  }

  const id = asBoundedString(value.id, MAX_SIDE_CHAT_ID_CHARS)
  const lifecycle = asString(value.lifecycle) as PersistedSideChatLifecycle | undefined
  const frameworkId = asString(value.frameworkId) as AgentFrameworkId | undefined
  const providerId =
    value.providerId === undefined
      ? undefined
      : asBoundedString(value.providerId, MAX_SIDE_CHAT_OPAQUE_CHARS)
  const backendId =
    value.backendId === undefined
      ? undefined
      : asBoundedString(value.backendId, MAX_SIDE_CHAT_OPAQUE_CHARS)
  const providerSessionId =
    value.providerSessionId === undefined
      ? undefined
      : asBoundedString(value.providerSessionId, MAX_SIDE_CHAT_OPAQUE_CHARS)
  const providerContinuityToken =
    value.providerContinuityToken === undefined
      ? undefined
      : asBoundedString(value.providerContinuityToken, MAX_SIDE_CHAT_OPAQUE_CHARS)
  const model =
    value.model === undefined ? undefined : asBoundedString(value.model, MAX_SIDE_CHAT_OPAQUE_CHARS)
  const historyPreamble = asBoundedString(value.historyPreamble, SIDE_CHAT_MESSAGE_LIMIT)
  const createdAt = asNumber(value.createdAt)
  const updatedAt = asNumber(value.updatedAt)
  if (
    !id ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id) ||
    !lifecycle ||
    !SIDE_CHAT_LIFECYCLES.has(lifecycle) ||
    !frameworkId ||
    !AGENT_FRAMEWORK_IDS.has(frameworkId) ||
    (value.providerId !== undefined && providerId === undefined) ||
    (value.backendId !== undefined && backendId === undefined) ||
    (value.providerSessionId !== undefined && providerSessionId === undefined) ||
    (value.providerContinuityToken !== undefined && providerContinuityToken === undefined) ||
    (value.model !== undefined && model === undefined) ||
    historyPreamble === undefined ||
    createdAt === undefined ||
    createdAt < 0 ||
    updatedAt === undefined ||
    updatedAt < createdAt
  ) {
    return undefined
  }

  const entries = value.entries.map(sanitizeSideChatEntry)
  const legacyRelays = (Array.isArray(value.pendingRelays) ? value.pendingRelays : []).map(
    (relay) => sanitizePersistedSideChatRelay(relay, id)
  )
  if (entries.some((entry) => entry === undefined) || legacyRelays.some((relay) => !relay)) {
    return undefined
  }

  const result: PersistedSideChat = {
    version: 1,
    id,
    lifecycle,
    frameworkId,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(backendId !== undefined ? { backendId } : {}),
    ...(providerSessionId !== undefined ? { providerSessionId } : {}),
    ...(providerContinuityToken !== undefined ? { providerContinuityToken } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(isReasoningEffort(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
    historyPreamble,
    entries: entries as SideChatEntry[],
    createdAt,
    updatedAt
  }
  return JSON.stringify({ ...result, legacyRelays }).length <= MAX_SIDE_CHAT_JSON_CHARS
    ? {
        sideChat: result,
        legacyRelays: legacyRelays as PersistedSideChatRelay[]
      }
    : undefined
}

export const sanitizePersistedSideChat = (value: unknown): PersistedSideChat | undefined =>
  sanitizePersistedSideChatWithLegacyRelays(value)?.sideChat
