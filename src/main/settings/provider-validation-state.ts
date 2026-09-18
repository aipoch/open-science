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

  const priorFailure = provider.lastValidationFailure
  const previousMissingTargets =
    priorFailure?.category === 'model-not-found' && priorFailure.target
      ? (priorFailure.targets ?? [priorFailure.target])
      : []
  const missingTargets =
    !result.ok && result.category === 'model-not-found' && target
      ? [target, ...previousMissingTargets].filter(
          (candidate, index, all) =>
            all.findIndex((other) => providerValidationTargetMatches(candidate, other)) === index
        )
      : []

  if (result.ok && priorFailure?.category === 'model-not-found' && priorFailure.target) {
    const remaining = target
      ? previousMissingTargets.filter((failed) => !providerValidationTargetMatches(failed, target))
      : []
    const retainedFailure =
      remaining.length > 0 ? { ...priorFailure, target: remaining[0] } : undefined
    if (retainedFailure) {
      delete retainedFailure.targets
      if (!providerValidationTargetMatches(priorFailure.target, retainedFailure.target)) {
        // Only the primary target owns the stored HTTP details; don't reuse them for another model.
        delete retainedFailure.status
        delete retainedFailure.message
      }
      if (remaining.length > 1) retainedFailure.targets = remaining
    }
    return {
      lastValidatedAt: at,
      lastValidatedTarget: target,
      lastValidationFailure: retainedFailure
    }
  }

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
          target,
          ...(missingTargets.length > 1 ? { targets: missingTargets } : {})
        }
      }
}
