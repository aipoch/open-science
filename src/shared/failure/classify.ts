import type { ClassifiedFailure, FailureFacts } from './contract'
import { recognizeProvider } from './recognizers/provider'
import { recognizeInput } from './recognizers/input'
import { recognizeAgentRuntime } from './recognizers/agent-runtime'
import { recognizeEnvironment } from './recognizers/environment'
import { recognizeSession } from './recognizers/session'

export const classifyFailure = (facts: FailureFacts): ClassifiedFailure => {
  let recognized: ClassifiedFailure | undefined
  for (const recognize of [
    recognizeSession,
    recognizeProvider,
    recognizeInput,
    recognizeAgentRuntime,
    recognizeEnvironment
  ]) {
    // Explicit session ownership wins; textual session rules follow the more specific domains.
    if (recognize === recognizeSession && facts.origin !== 'session') continue
    recognized = recognize(facts)
    if (recognized) break
  }
  recognized ??= recognizeSession(facts)
  const category = recognized?.category ?? (facts.origin === 'provider' ? 'service' : 'internal')
  return {
    category,
    ...(facts.origin === 'provider' &&
    facts.responseMessage &&
    (category === 'service' || category === 'configuration')
      ? { responseMessage: facts.responseMessage }
      : {}),
    ...(recognized?.reason
      ? { reason: recognized.reason }
      : facts.origin === 'provider'
        ? { reason: 'service/provider-error' as const }
        : {}),
    diagnostics: {
      ...(facts.status === undefined ? {} : { status: facts.status }),
      ...(facts.code === undefined ? {} : { code: String(facts.code) }),
      ...(facts.protocol && facts.responseMessage ? { safeMessage: facts.responseMessage } : {}),
      ...(facts.adapterCode === undefined ? {} : { adapterCode: facts.adapterCode }),
      ...(facts.upstreamCode === undefined ? {} : { upstreamCode: facts.upstreamCode }),
      ...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
      ...(facts.phase === undefined ? {} : { phase: facts.phase }),
      ...(facts.provider === undefined ? {} : { provider: facts.provider }),
      ...(facts.model === undefined ? {} : { model: facts.model }),
      ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
      ...(facts.text === undefined ? {} : { raw: facts.text })
    }
  }
}
