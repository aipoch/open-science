import type { AgentFrameworkId } from '../../shared/settings'
import type { AgentModelRoute } from '../agent-framework'

type AcpSessionResumePolicyInput = Readonly<{
  appSessionId: string
  providerSessionId?: string
  previousFrameworkId?: AgentFrameworkId
  currentFrameworkId: AgentFrameworkId
  previousBackendId?: string
  currentBackendId?: string
  currentModelRoute?: AgentModelRoute
  previousProviderContinuityToken?: string
  currentProviderContinuityToken?: string
  resumeCapabilityAdvertised: boolean
}>

type AcpSessionResumeFailureContext = Readonly<{
  currentFrameworkId: AgentFrameworkId
  currentModelRoute?: AgentModelRoute
  providerSessionIdPersisted: boolean
}>

type AcpSessionResumeAdoptionReason =
  | 'framework-changed'
  | 'backend-changed'
  | 'codex-provider-session-id-incompatible'
  | 'opencode-provider-session-id-incompatible-with-claude'
  | 'resume-capability-not-advertised'
  | 'provider-continuity-lost'

const isCodexProviderSessionId = (sessionId: string): boolean =>
  /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)

type AcpSessionResumeDecisionIdentity = Readonly<{
  appSessionId: string
  providerSessionId: string
}>

type AcpSessionResumeDecision =
  | (AcpSessionResumeDecisionIdentity &
      Readonly<{
        action: 'resume'
        reason: 'compatible'
        contextReset: false
      }>)
  | (AcpSessionResumeDecisionIdentity &
      Readonly<{
        action: 'adopt'
        reason: AcpSessionResumeAdoptionReason
        contextReset: true
      }>)

type AcpSessionResumeAdoptableFailureReason =
  | 'resource-not-found-code'
  | 'session-not-found-message'
  | 'session-service-failure'
  | 'unresumable-error-kind'
  | 'legacy-unresumable-details'
  | 'legacy-codex-session-unavailable'
  | 'legacy-opencode-session-unavailable'

type AcpSessionResumeAuthoritativeFailureReason =
  | 'unrecognized-error'
  | 'unknown-error-kind'
  | 'non-session-service-failure'
  | 'unrelated-internal-error'
  | 'non-internal-error'
  | 'uninspectable-error'

type AcpSessionResumeFailureClassification =
  | Readonly<{
      disposition: 'adoptable'
      reason: AcpSessionResumeAdoptableFailureReason
    }>
  | Readonly<{
      disposition: 'authoritative'
      reason: AcpSessionResumeAuthoritativeFailureReason
    }>

type SafePropertyRead = Readonly<{ readable: true; value: unknown }> | Readonly<{ readable: false }>

const readProperty = (value: unknown, property: string): SafePropertyRead => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { readable: true, value: undefined }
  }

  try {
    return { readable: true, value: Reflect.get(value, property) }
  } catch {
    return { readable: false }
  }
}

const UNRESUMABLE_ERROR_KINDS = new Set([
  'session_not_found',
  'conversation_not_found',
  'session_missing',
  'conversation_missing',
  'session_resume_failed',
  'conversation_restore_failed'
])

const isUnresumableErrorKind = (value: unknown): boolean =>
  typeof value === 'string' &&
  UNRESUMABLE_ERROR_KINDS.has(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
  )

// Legacy agents may expose only English diagnostics. This fallback stays narrow because a false
// positive silently drops provider context, while a false negative preserves the original error.
const describesUnresumableSession = (details: unknown): boolean => {
  if (typeof details !== 'string') return false
  if (
    /\b(?:auth|authentication|authorization|credential|provider|mcp|model|tool|server)\b/i.test(
      details
    )
  ) {
    return false
  }

  const describesMissingSession =
    /\b(?:session|conversation)(?:\s+(?:id|identifier))?\s+(?:(?:was|is)\s+)?(?:not found|missing|unknown)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)(?:\s+(?:id|identifier))?\s+does not exist\b/i.test(details) ||
    /\b(?:no|missing|unknown)\s+(?:saved\s+|previous\s+)?(?:session|conversation)\b/i.test(details)
  const describesFailedResume =
    /\b(?:failed|unable|cannot|can't|could not)\s+to\s+(?:resume|restore|reopen|reattach)\b.{0,80}\b(?:session|conversation)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)\b.{0,40}\b(?:failed|was unable)\s+to\s+(?:resume|restore|reopen|reattach)\b/i.test(
      details
    ) ||
    /\b(?:session|conversation)\b.{0,40}\b(?:could not|cannot|can't)\s+be\s+(?:resumed|restored|reopened|reattached)\b/i.test(
      details
    )

  return describesMissingSession || describesFailedResume
}

const adoptableFailure = (
  reason: AcpSessionResumeAdoptableFailureReason
): AcpSessionResumeFailureClassification => Object.freeze({ disposition: 'adoptable', reason })

const authoritativeFailure = (
  reason: AcpSessionResumeAuthoritativeFailureReason
): AcpSessionResumeFailureClassification => Object.freeze({ disposition: 'authoritative', reason })

const isCodexResponsesResumeContext = (
  context: AcpSessionResumeFailureContext | undefined
): boolean =>
  context?.currentFrameworkId === 'codex' &&
  (context.currentModelRoute === 'codex-responses' ||
    context.currentModelRoute === 'codex-responses-compatibility')

const hasNoStructuredErrorData = (value: unknown): boolean => {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return (
      (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === 0
    )
  } catch {
    return false
  }
}

// ARD-04 intentionally adds this pure policy without a production caller. ARD-20 exclusively owns
// the Runtime cutover once its transaction seams exist; integrating here would violate the serialized
// hot-file boundary. Session ownership, protocol calls, and replay stay with those transactions.
class AcpSessionResumePolicy {
  decide(input: AcpSessionResumePolicyInput): AcpSessionResumeDecision {
    const providerSessionId = input.providerSessionId ?? input.appSessionId

    if (
      input.previousFrameworkId !== undefined &&
      input.previousFrameworkId !== input.currentFrameworkId
    ) {
      return Object.freeze({
        action: 'adopt',
        reason: 'framework-changed',
        appSessionId: input.appSessionId,
        providerSessionId,
        contextReset: true
      })
    }

    if (
      input.previousBackendId !== undefined &&
      input.currentBackendId !== undefined &&
      input.previousBackendId !== input.currentBackendId
    ) {
      return Object.freeze({
        action: 'adopt',
        reason: 'backend-changed',
        appSessionId: input.appSessionId,
        providerSessionId,
        contextReset: true
      })
    }

    if (
      input.currentModelRoute === 'codex-bridge' &&
      (!input.previousProviderContinuityToken ||
        !input.currentProviderContinuityToken ||
        input.previousProviderContinuityToken !== input.currentProviderContinuityToken)
    ) {
      return Object.freeze({
        action: 'adopt',
        reason: 'provider-continuity-lost',
        appSessionId: input.appSessionId,
        providerSessionId,
        contextReset: true
      })
    }

    if (input.currentFrameworkId === 'codex' && !isCodexProviderSessionId(providerSessionId)) {
      return Object.freeze({
        action: 'adopt',
        reason: 'codex-provider-session-id-incompatible',
        appSessionId: input.appSessionId,
        providerSessionId,
        contextReset: true
      })
    }

    if (input.currentFrameworkId === 'claude-code' && providerSessionId.startsWith('ses_')) {
      return Object.freeze({
        action: 'adopt',
        reason: 'opencode-provider-session-id-incompatible-with-claude',
        appSessionId: input.appSessionId,
        providerSessionId,
        contextReset: true
      })
    }

    if (!input.resumeCapabilityAdvertised) {
      return Object.freeze({
        action: 'adopt',
        reason: 'resume-capability-not-advertised',
        appSessionId: input.appSessionId,
        providerSessionId,
        contextReset: true
      })
    }

    return Object.freeze({
      action: 'resume',
      reason: 'compatible',
      appSessionId: input.appSessionId,
      providerSessionId,
      contextReset: false
    })
  }

  classifyFailure(
    error: unknown,
    context?: AcpSessionResumeFailureContext
  ): AcpSessionResumeFailureClassification {
    const code = readProperty(error, 'code')
    if (!code.readable) return authoritativeFailure('uninspectable-error')
    if (code.value === -32002) return adoptableFailure('resource-not-found-code')

    const message = readProperty(error, 'message')
    if (!message.readable) return authoritativeFailure('uninspectable-error')
    if (
      typeof message.value === 'string' &&
      /resource not found|session not found|no rollout found for thread id/i.test(message.value)
    ) {
      return adoptableFailure('session-not-found-message')
    }

    if (code.value !== -32603) {
      return code.value !== undefined || message.value !== undefined
        ? authoritativeFailure('non-internal-error')
        : authoritativeFailure('unrecognized-error')
    }

    const data = readProperty(error, 'data')
    if (!data.readable) return authoritativeFailure('uninspectable-error')

    const service = readProperty(data.value, 'service')
    if (!service.readable) return authoritativeFailure('uninspectable-error')
    if (service.value === 'session') return adoptableFailure('session-service-failure')
    if (service.value !== undefined) return authoritativeFailure('non-session-service-failure')

    if (typeof message.value === 'string' && /^unknown error\.?$/i.test(message.value.trim())) {
      if (isCodexResponsesResumeContext(context)) {
        return adoptableFailure('legacy-codex-session-unavailable')
      }
      if (
        context?.providerSessionIdPersisted === false &&
        context.currentFrameworkId === 'opencode' &&
        (context.currentModelRoute === 'opencode-anthropic' ||
          context.currentModelRoute === 'opencode-openai')
      ) {
        return adoptableFailure('legacy-opencode-session-unavailable')
      }
    }

    if (typeof message.value !== 'string' || !/^internal error\.?$/i.test(message.value.trim())) {
      return authoritativeFailure('non-internal-error')
    }

    const errorKind = readProperty(data.value, 'errorKind')
    if (!errorKind.readable) return authoritativeFailure('uninspectable-error')
    if (isUnresumableErrorKind(errorKind.value)) {
      return adoptableFailure('unresumable-error-kind')
    }
    if (errorKind.value !== undefined) return authoritativeFailure('unknown-error-kind')

    const details = readProperty(data.value, 'details')
    if (!details.readable) return authoritativeFailure('uninspectable-error')
    if (describesUnresumableSession(details.value)) {
      return adoptableFailure('legacy-unresumable-details')
    }
    if (hasNoStructuredErrorData(data.value) && isCodexResponsesResumeContext(context)) {
      return adoptableFailure('legacy-codex-session-unavailable')
    }
    return authoritativeFailure('unrelated-internal-error')
  }
}

export { AcpSessionResumePolicy }
export type {
  AcpSessionResumeFailureContext,
  AcpSessionResumeAdoptionReason,
  AcpSessionResumeAdoptableFailureReason,
  AcpSessionResumeAuthoritativeFailureReason,
  AcpSessionResumeDecision,
  AcpSessionResumeFailureClassification,
  AcpSessionResumePolicyInput
}
