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
  return {
    category: recognized?.category ?? (facts.origin === 'provider' ? 'service' : 'internal'),
    ...(recognized?.reason ? { reason: recognized.reason } : {}),
    diagnostics: {
      ...(facts.status === undefined ? {} : { status: facts.status }),
      ...(facts.code === undefined ? {} : { code: String(facts.code) }),
      ...(facts.provider === undefined ? {} : { provider: facts.provider }),
      ...(facts.model === undefined ? {} : { model: facts.model }),
      ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
      ...(facts.text === undefined ? {} : { raw: facts.text })
    }
  }
}
