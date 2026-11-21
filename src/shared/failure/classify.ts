import { readProviderErrorCode } from './contract'
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
    !facts.protocol &&
    facts.responseMessage &&
    !(
      facts.code === 'invalid_upstream_response' &&
      recognized?.reason === 'service/response-invalid'
    ) &&
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
      ...(facts.code === undefined || (facts.protocol && !readProviderErrorCode(facts.code))
        ? {}
        : { code: String(facts.code) }),
      ...(facts.adapterCode === undefined ? {} : { adapterCode: facts.adapterCode }),
      ...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
      ...(facts.protocol && facts.providerExcerpt
        ? { providerExcerpt: facts.providerExcerpt }
        : {}),
      ...(facts.phase === undefined ? {} : { phase: facts.phase }),
      ...(facts.provider === undefined ? {} : { provider: facts.provider }),
      ...(facts.model === undefined ? {} : { model: facts.model }),
      ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
      ...(facts.protocol || facts.text === undefined ? {} : { raw: facts.text })
    }
  }
}
