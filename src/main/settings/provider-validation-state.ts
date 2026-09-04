import {
  preferredEndpoint,
  providerValidationTargetMatches,
  type AgentFrameworkId,
  type ChatApiEndpoint,
  type ProviderType,
  type ProviderValidationTarget,
  type ValidateProviderResult
} from '../../shared/settings'
import type { StoredProvider } from './types'

type ProviderValidationPatch = Pick<
  StoredProvider,
  'lastValidatedAt' | 'lastValidatedTarget' | 'lastValidationFailure'
>

export const providerRuntimeValidationTarget = (
  target: {
    providerType: ProviderType
    effectiveModel?: string
    apiEndpoints: readonly ChatApiEndpoint[]
    needsChatResponsesBridge: boolean
  },
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
): ProviderValidationTarget => ({
  model: target.effectiveModel,
  endpoint: preferredEndpoint(
    target.apiEndpoints,
    target.providerType === 'xai-subscription'
      ? ['responses']
      : framework.id === 'codex' || target.needsChatResponsesBridge
        ? target.apiEndpoints
        : framework.supportedApiTypes
  )
})

export const targetForValidationResult = (
  result: ValidateProviderResult,
  target: ProviderValidationTarget
): ProviderValidationTarget | undefined =>
  !result.ok && ['auth', 'bad-url', 'network', 'timeout', 'server-error'].includes(result.category)
    ? undefined
    : target

export const buildProviderValidationPatch = (
  provider: StoredProvider,
  result: ValidateProviderResult,
  target: ProviderValidationTarget | undefined,
  at = Date.now()
): ProviderValidationPatch => {
  const sameFailureTarget =
    provider.lastValidationFailure?.target === undefined ||
    target === undefined ||
    providerValidationTargetMatches(provider.lastValidationFailure.target, target)
  const sameSuccessTarget =
    provider.lastValidatedTarget === undefined ||
    target === undefined ||
    providerValidationTargetMatches(provider.lastValidatedTarget, target)

  return result.ok
    ? {
        lastValidatedAt: at,
        lastValidatedTarget: target,
        ...(sameFailureTarget ? { lastValidationFailure: undefined } : {})
      }
    : {
        ...(sameSuccessTarget
          ? { lastValidatedAt: undefined, lastValidatedTarget: undefined }
          : {}),
        lastValidationFailure: {
          at,
          category: result.category,
          status: result.status,
          message: result.message,
          target
        }
      }
}
