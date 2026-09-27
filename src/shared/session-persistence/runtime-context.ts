import {
  type SessionRuntimeContext,
  type SessionPlanRuntimeContext,
  type SessionDelegatedWorkRuntimeContext,
  type SessionPermissionRuntimeContext,
  type SessionPdfContext,
  type PersistedSideChat,
  type PersistedSideChatRelay,
  getPersistedSideChats
} from '../session-runtime-context'
import { isRecord, asNumber, sanitizeRuntimeContextValue } from './primitives'
import { MAX_PLAN_RUNTIME_CONTEXT_NODES } from '../session-plan/contract'
import { sanitizeSessionPdfContext } from './pdf-context'
import { sanitizeSessionPlanRuntimeContext } from './plan'
import { sanitizeSessionPermissionRuntimeContext } from './permissions'
import { sanitizeSessionDelegatedWorkRuntimeContext } from './delegated-work'
import {
  sanitizePersistedSideChatWithLegacyRelays,
  sanitizePersistedSideChat,
  MAX_SIDE_CHAT_RELAYS,
  sanitizePersistedSideChatRelay
} from './side-chat'

export const sanitizeSessionRuntimeContext = (
  value: unknown
): SessionRuntimeContext | undefined => {
  if (!isRecord(value) || value.version !== 1) return undefined
  const revision = asNumber(value.revision)
  if (revision === undefined || !Number.isSafeInteger(revision) || revision < 0) return undefined

  const result: {
    version: 1
    revision: number
    plan?: SessionPlanRuntimeContext
    delegatedWork?: SessionDelegatedWorkRuntimeContext
    permission?: SessionPermissionRuntimeContext
    pdfContext?: SessionPdfContext
    sideChat?: PersistedSideChat
    sideChats?: readonly PersistedSideChat[]
    sideChatRelays?: readonly PersistedSideChatRelay[]
  } = {
    version: 1,
    revision
  }
  let legacyRelays: readonly PersistedSideChatRelay[] = []
  let directRelays: readonly PersistedSideChatRelay[] = []
  const budget = { remaining: 2_000 }
  for (const [owner, ownerValue] of Object.entries(value)) {
    if (owner === 'version' || owner === 'revision') continue
    if (
      owner === 'plan' ||
      owner === 'delegatedWork' ||
      owner === 'permission' ||
      owner === 'pdfContext'
    ) {
      const sanitizedJson = sanitizeRuntimeContextValue(
        ownerValue,
        owner === 'plan' ? { remaining: MAX_PLAN_RUNTIME_CONTEXT_NODES } : budget
      )
      if (sanitizedJson === undefined) return undefined
      if (owner === 'pdfContext') {
        const pdfContext = sanitizeSessionPdfContext(sanitizedJson)
        if (!pdfContext) return undefined
        result.pdfContext = pdfContext
      } else if (owner === 'plan') {
        const plan = sanitizeSessionPlanRuntimeContext(sanitizedJson)
        if (!plan) return undefined
        result.plan = plan
      } else if (owner === 'permission') {
        const permission = sanitizeSessionPermissionRuntimeContext(sanitizedJson)
        if (!permission) return undefined
        result.permission = permission
      } else {
        const delegatedWork = sanitizeSessionDelegatedWorkRuntimeContext(sanitizedJson)
        if (!delegatedWork) return undefined
        result.delegatedWork = delegatedWork
      }
      continue
    }
    if (owner === 'sideChat') {
      const sanitized = sanitizePersistedSideChatWithLegacyRelays(ownerValue)
      if (sanitized) {
        result.sideChat = sanitized.sideChat
        legacyRelays = sanitized.legacyRelays
      }
      continue
    }
    if (owner === 'sideChats') {
      if (ownerValue === undefined) continue
      if (!Array.isArray(ownerValue) || ownerValue.length > 100) return undefined
      const chats = ownerValue.map(sanitizePersistedSideChat)
      if (chats.some((chat) => !chat)) return undefined
      result.sideChats = chats as PersistedSideChat[]
      continue
    }
    if (owner === 'sideChatRelays') {
      if (!Array.isArray(ownerValue) || ownerValue.length > MAX_SIDE_CHAT_RELAYS) continue
      const relays = ownerValue.map((relay) => sanitizePersistedSideChatRelay(relay))
      if (relays.some((relay) => relay === undefined)) continue
      directRelays = relays as PersistedSideChatRelay[]
      continue
    }
    return undefined
  }
  const chatIds = getPersistedSideChats(result).map((chat) => chat.id)
  if (new Set(chatIds).size !== chatIds.length) return undefined
  const sideChatRelays = [...directRelays, ...legacyRelays]
  if (sideChatRelays.length > MAX_SIDE_CHAT_RELAYS) return undefined
  const relayIds = new Set<string>()
  for (const relay of sideChatRelays) {
    if (relayIds.has(relay.id)) return undefined
    relayIds.add(relay.id)
  }
  if (sideChatRelays.length > 0) result.sideChatRelays = sideChatRelays
  return result
}
