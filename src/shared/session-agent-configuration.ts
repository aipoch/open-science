import type { ConfiguredModelCatalogEntry } from './configured-model-catalog'
import { resolveProviderEffectiveModel } from './provider-reasoning-effort'
import type { PersistedChatSession } from './session-persistence'
import {
  canonicalSessionProviderId,
  type ProviderView,
  type ReasoningEffort,
  type SessionAgentConfiguration
} from './settings'

type SessionAgentConfigurationSource = Pick<
  PersistedChatSession,
  'agentBackendId' | 'agentModel' | 'agentConfiguration'
>

type SessionAgentConfigurationResolution =
  | Readonly<{
      status: 'ready'
      configuration: SessionAgentConfiguration
      changed: boolean
    }>
  | Readonly<{
      status: 'unavailable'
      configuration?: SessionAgentConfiguration
    }>

const providerIdFromBackendId = (backendId: string | undefined): string | undefined => {
  if (!backendId) return undefined
  const separator = backendId.indexOf(':')
  const providerId = separator < 0 ? backendId : backendId.slice(separator + 1)
  const normalized = providerId.trim()
  return normalized ? canonicalSessionProviderId(normalized) : undefined
}

// Inspect all retained history, including inactive branches, without rewriting legacy identities.
const sessionReferencesProvider = (
  session: PersistedChatSession,
  providerIds: readonly string[]
): boolean => {
  const references = [
    session.agentConfiguration?.providerId,
    providerIdFromBackendId(session.agentBackendId),
    session.sessionDetailsGeneration && 'providerId' in session.sessionDetailsGeneration
      ? session.sessionDetailsGeneration.providerId
      : undefined,
    session.runtimeContext?.sideChat?.providerId,
    providerIdFromBackendId(session.runtimeContext?.sideChat?.backendId),
    ...(session.conversationGraph?.runtimeSegments ?? []).flatMap((segment) => [
      segment.providerId,
      providerIdFromBackendId(segment.backendId)
    ]),
    ...(session.conversationGraph?.messages ?? session.messages).flatMap((message) => [
      message.agentTarget?.providerId,
      providerIdFromBackendId(message.agentTarget?.backendId)
    ]),
    ...(session.runtimeContext?.delegatedWork?.records ?? []).flatMap((record) =>
      record.attempts.map((attempt) => attempt.executionModel?.providerId)
    )
  ]
  return references.some(
    (id) => id !== undefined && providerIds.includes(canonicalSessionProviderId(id))
  )
}

const resolveSelectableConfiguration = (
  catalog: readonly ConfiguredModelCatalogEntry[],
  providerId: string | undefined,
  model: string | undefined,
  reasoningEffort: ReasoningEffort,
  providers: readonly ProviderView[]
): SessionAgentConfiguration | undefined => {
  if (!providerId) return undefined
  const resolvedProviderId = canonicalSessionProviderId(providerId)
  const provider = providers.find((candidate) => candidate.id === resolvedProviderId)
  if (!provider) return undefined
  const effectiveModel = model ?? resolveProviderEffectiveModel(provider, undefined)
  const option = catalog.find(
    (candidate) =>
      candidate.selectable &&
      candidate.providerId === resolvedProviderId &&
      (effectiveModel === undefined || candidate.model === effectiveModel)
  )
  if (!option) return undefined
  // Persist selection intent; only execution resolves an omitted provider-owned default.
  return {
    providerId: option.providerId,
    ...(model !== undefined ? { model } : {}),
    reasoningEffort
  }
}

const isConfigurationSelectable = (
  configuration: SessionAgentConfiguration | undefined,
  catalog: readonly ConfiguredModelCatalogEntry[],
  providers: readonly ProviderView[]
): configuration is SessionAgentConfiguration =>
  Boolean(
    configuration &&
    resolveSelectableConfiguration(
      catalog,
      configuration.providerId,
      configuration.model,
      configuration.reasoningEffort,
      providers
    )
  )

const resolveSessionAgentConfiguration = (input: {
  providers: readonly ProviderView[]
  session: SessionAgentConfigurationSource
  catalog: readonly ConfiguredModelCatalogEntry[]
  activeProviderId?: string
  activeModel?: string
  activeReasoningEffort: ReasoningEffort
}): SessionAgentConfigurationResolution => {
  const legacyProviderId = providerIdFromBackendId(input.session.agentBackendId)
  const preferred =
    input.session.agentConfiguration ??
    (legacyProviderId
      ? {
          providerId: legacyProviderId,
          ...(input.session.agentModel ? { model: input.session.agentModel } : {}),
          reasoningEffort: input.activeReasoningEffort
        }
      : undefined)

  const selectablePreferred = preferred
    ? resolveSelectableConfiguration(
        input.catalog,
        preferred.providerId,
        preferred.model,
        preferred.reasoningEffort,
        input.providers
      )
    : undefined
  if (selectablePreferred) {
    return {
      status: 'ready',
      configuration: selectablePreferred,
      changed:
        !input.session.agentConfiguration ||
        selectablePreferred.providerId !== input.session.agentConfiguration.providerId
    }
  }

  if (preferred) return { status: 'unavailable', configuration: preferred }

  const fallback = resolveSelectableConfiguration(
    input.catalog,
    input.activeProviderId,
    input.activeModel,
    input.activeReasoningEffort,
    input.providers
  )
  if (fallback) {
    return { status: 'ready', configuration: fallback, changed: true }
  }
  return { status: 'unavailable', ...(preferred ? { configuration: preferred } : {}) }
}

export {
  sessionReferencesProvider,
  isConfigurationSelectable,
  resolveSelectableConfiguration,
  resolveSessionAgentConfiguration
}
export type { SessionAgentConfigurationResolution, SessionAgentConfigurationSource }
