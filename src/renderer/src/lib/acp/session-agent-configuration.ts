import type { ConfiguredModelCatalogEntry } from '../../../../shared/configured-model-catalog'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import type { ReasoningEffort, SessionAgentConfiguration } from '../../../../shared/settings'

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
  return providerId.trim() || undefined
}

const isConfigurationSelectable = (
  configuration: SessionAgentConfiguration | undefined,
  catalog: readonly ConfiguredModelCatalogEntry[]
): configuration is SessionAgentConfiguration =>
  Boolean(
    configuration &&
    catalog.some(
      (option) =>
        option.selectable &&
        option.providerId === configuration.providerId &&
        (configuration.model === undefined || option.model === configuration.model)
    )
  )

const resolveSelectableConfiguration = (
  catalog: readonly ConfiguredModelCatalogEntry[],
  providerId: string | undefined,
  model: string | undefined,
  reasoningEffort: ReasoningEffort
): SessionAgentConfiguration | undefined => {
  if (!providerId) return undefined
  const option = catalog.find(
    (candidate) =>
      candidate.selectable &&
      candidate.providerId === providerId &&
      (model === undefined || candidate.model === model)
  )
  return option
    ? {
        providerId,
        ...(option.model ? { model: option.model } : {}),
        reasoningEffort
      }
    : undefined
}

const resolveSessionAgentConfiguration = (input: {
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
        preferred.reasoningEffort
      )
    : undefined
  if (selectablePreferred) {
    return {
      status: 'ready',
      configuration: selectablePreferred,
      changed: !input.session.agentConfiguration
    }
  }

  const fallback = resolveSelectableConfiguration(
    input.catalog,
    input.activeProviderId,
    input.activeModel,
    input.activeReasoningEffort
  )
  if (fallback) {
    return { status: 'ready', configuration: fallback, changed: true }
  }
  return { status: 'unavailable', ...(preferred ? { configuration: preferred } : {}) }
}

export {
  isConfigurationSelectable,
  resolveSelectableConfiguration,
  resolveSessionAgentConfiguration
}
export type { SessionAgentConfigurationResolution }
