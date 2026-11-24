import { isDeepStrictEqual } from 'node:util'
import {
  isCatalogModelAvailable,
  resolveOfficialModelCatalog
} from '../../shared/provider-model-catalog'
import type { CatalogModel, ModelProtocol, OfficialVendorId } from '@aipoch/providers'
import type {
  AgentFrameworkId,
  ProviderType,
  ProviderValidationTarget,
  ValidateProviderResult
} from '../../shared/settings'
import {
  DEFAULT_ENDPOINT_ORDER,
  preferredEndpoint,
  providerValidationRoute,
  providerValidationTargetMatches
} from '../../shared/settings-runtime'
import type { StoredProvider } from './types'

type ProviderValidationPatch = Pick<
  StoredProvider,
  'lastValidatedAt' | 'lastValidatedTarget' | 'lastValidationFailure'
>

export const providerRuntimeValidationTarget = (
  target: {
    provider?: {
      type: ProviderType
      vendorId?: OfficialVendorId
      baseUrl?: string
      chatCompletionsBaseUrl?: string
    }
    providerType: ProviderType
    effectiveModel?: string
    apiEndpoints: readonly ModelProtocol[]
    needsChatResponsesToChatCompletionsBridge: boolean
    needsNativeResponsesCompatibility?: boolean
  },
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
): ProviderValidationTarget => ({
  ...providerValidationRoute(
    {
      ...target.provider,
      type: target.providerType,
      apiEndpoints: target.apiEndpoints,
      needsChatResponsesToChatCompletionsBridge: target.needsChatResponsesToChatCompletionsBridge,
      needsNativeResponsesCompatibility: target.needsNativeResponsesCompatibility
    },
    framework.id
  ),
  model: target.effectiveModel,
  endpoint: preferredEndpoint(
    target.apiEndpoints,
    target.providerType === 'xai-subscription'
      ? ['responses']
      : framework.id === 'codex' || target.needsChatResponsesToChatCompletionsBridge
        ? DEFAULT_ENDPOINT_ORDER
        : framework.supportedApiTypes
  )
})

export const targetForValidationResult = (
  result: ValidateProviderResult,
  target: ProviderValidationTarget
): ProviderValidationTarget | undefined =>
  result.testedTarget?.frameworkId
    ? result.testedTarget
    : !result.ok &&
        ['auth', 'bad-url', 'network', 'timeout', 'server-error'].includes(result.category)
      ? undefined
      : target

// A catalog can rule out a model before any endpoint is known. A later successful probe for
// that model recovers this failure on any route; HTTP and native failures retain their own scope.
const missingTargetMatchesProbe = (
  missing: ProviderValidationTarget,
  probe: ProviderValidationTarget
): boolean =>
  providerValidationTargetMatches(missing, probe) ||
  (missing.model !== undefined &&
    missing.model === probe.model &&
    missing.endpoint === undefined &&
    missing.frameworkId === undefined)

function retainFailureTargets(
  failure: NonNullable<StoredProvider['lastValidationFailure']>,
  targets: ProviderValidationTarget[]
): StoredProvider['lastValidationFailure'] {
  if (!targets.length) return undefined
  const retained = { ...failure, target: targets[0] }
  delete retained.targets
  if (!failure.target || !providerValidationTargetMatches(failure.target, retained.target)) {
    // HTTP details belong to the original primary target.
    delete retained.status
    delete retained.message
  }
  if (targets.length > 1) retained.targets = targets
  return retained
}

// A model/protocol verdict belongs to the catalog address that was tested.
export function reconcileCatalogHealth(
  previous: StoredProvider,
  next: StoredProvider
): StoredProvider {
  const failure = next.lastValidationFailure
  if (
    next.type !== 'official' ||
    (!next.lastValidatedTarget && !failure?.target) ||
    isDeepStrictEqual(previous.modelCatalog, next.modelCatalog)
  )
    return next
  const routes = (provider: StoredProvider): Map<string, CatalogModel['routes']> =>
    new Map(
      resolveOfficialModelCatalog(provider)
        .filter(isCatalogModelAvailable)
        .map((model) => [model.id, model.routes])
    )
  const before = routes(previous)
  const after = routes(next)
  const stillMatches = ({ model, endpoint }: ProviderValidationTarget): boolean =>
    !model ||
    (endpoint
      ? before.get(model)?.[endpoint] === after.get(model)?.[endpoint]
      : isDeepStrictEqual(before.get(model), after.get(model)))

  if (next.lastValidatedTarget && !stillMatches(next.lastValidatedTarget))
    next = { ...next, lastValidatedAt: undefined, lastValidatedTarget: undefined }
  if (failure?.target) {
    const targets = failure.targets ?? [failure.target]
    const remaining = targets.filter(stillMatches)
    if (remaining.length !== targets.length)
      next = { ...next, lastValidationFailure: retainFailureTargets(failure, remaining) }
  }
  return next
}

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
    (result.category === 'model-not-found'
      ? missingTargetMatchesProbe(target, provider.lastValidatedTarget)
      : providerValidationTargetMatches(provider.lastValidatedTarget, target))

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
      ? previousMissingTargets.filter((failed) => !missingTargetMatchesProbe(failed, target))
      : []
    return {
      lastValidatedAt: at,
      lastValidatedTarget: target,
      lastValidationFailure: retainFailureTargets(priorFailure, remaining)
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
