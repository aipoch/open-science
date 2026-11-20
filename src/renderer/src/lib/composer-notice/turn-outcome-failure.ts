import type { ClassifiedFailure } from '../../../../shared/failure/contract'

// Older ACP runs can persist the provider's stream error under a generic RPC wrapper.
// Require both the specific code and message before overriding a generic classification.
const legacyStreamError = (error: string | undefined): boolean => {
  const prefix = 'Internal error: '
  if (!error?.startsWith(prefix) || error.length > 512) return false
  try {
    const detail: unknown = JSON.parse(error.slice(prefix.length))
    return Boolean(
      detail &&
      typeof detail === 'object' &&
      'code' in detail &&
      detail.code === 400008 &&
      'message' in detail &&
      detail.message === '供应商流式响应为空或未完整结束'
    )
  } catch {
    return false
  }
}

export const presentTurnOutcomeFailure = (outcome: {
  failure?: ClassifiedFailure
  error?: string
}): ClassifiedFailure => {
  const failure: ClassifiedFailure = outcome.failure ?? { category: 'internal', diagnostics: {} }
  const raw = failure.diagnostics.raw ?? outcome.error
  const diagnostics = { ...failure.diagnostics, raw }
  if (
    failure.category === 'internal' &&
    !failure.reason &&
    !failure.diagnostics.protocol &&
    legacyStreamError(raw)
  ) {
    return { ...failure, category: 'service', reason: 'service/response-interrupted', diagnostics }
  }
  return { ...failure, diagnostics }
}
