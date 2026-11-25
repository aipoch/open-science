import type { TFunction } from 'i18next'

import {
  configuredModelApiEndpoints,
  type ConfiguredModelCatalogEntry
} from '../../../../shared/configured-model-catalog'
import type { ModelProtocol } from '@aipoch/providers'
import type { AgentFrameworkId, ProviderType, ProviderView } from '../../../../shared/settings'
import {
  ENDPOINT_PATHS,
  providerEndpoints,
  isProviderUsableByFramework,
  subscriptionFrameworks
} from '../../../../shared/settings-runtime'

// Human-readable route for an endpoint, so a reason reads as a route rather than a vendor name. The
// routes are literal API paths, identical in every locale; only the joining word is translated.
const routeList = (endpoints: readonly ModelProtocol[], t: TFunction): string =>
  endpoints.map((endpoint) => ENDPOINT_PATHS[endpoint]).join(t(' or '))

const subscriptionFrameworkNames: Partial<Record<AgentFrameworkId, string>> = {
  'claude-code': 'Claude Code',
  codebuddy: 'CodeBuddy',
  codex: 'Codex',
  'open-science-agent': 'Open-Science Agent'
}

export const requiredSubscriptionFramework = (
  provider: Pick<ProviderView, 'type' | 'codexHarnessAvailable'>,
  frameworkId: AgentFrameworkId,
  t: TFunction
): string | undefined => {
  const owners = subscriptionFrameworks(provider)
  if (!owners || owners.includes(frameworkId)) return undefined
  return owners.map((id) => subscriptionFrameworkNames[id] ?? id).join(t(' or '))
}

export const modelUnavailableReason = (
  option: Pick<ConfiguredModelCatalogEntry, 'model' | 'label' | 'metadata' | 'unavailableReason'>,
  provider: Pick<
    ProviderView,
    'type' | 'apiEndpoints' | 'modelProtocols' | 'codexHarnessAvailable'
  >,
  framework: { id: AgentFrameworkId; displayName: string },
  frameworkEndpoints: readonly ModelProtocol[],
  t: TFunction
): string | undefined => {
  if (!option.unavailableReason) return undefined
  if (option.unavailableReason === 'model-bridge-unsupported') {
    return t(
      'This model is not supported over the Codex Chat Completions bridge. Pick another model for a Codex session.'
    )
  }
  if (option.unavailableReason === 'streaming-unsupported') {
    return t('This model does not support streaming. Pick a streaming-capable model for the Agent.')
  }
  const required = requiredSubscriptionFramework(provider, framework.id, t)
  if (required) {
    return t(
      'Switch the agent framework to {{framework}} to use {{model}} with this subscription.',
      {
        model: option.label,
        framework: required
      }
    )
  }

  return t('{{model}} uses {{modelRoutes}}, but {{framework}} supports {{frameworkRoutes}}.', {
    model: option.label,
    modelRoutes: routeList(configuredModelApiEndpoints(provider, option.metadata, option.model), t),
    framework: framework.displayName,
    frameworkRoutes: routeList(frameworkEndpoints, t)
  })
}

// Explain provider restrictions before comparing the provider and framework's API endpoints.
export const incompatibilityReason = (
  provider: {
    apiEndpoints?: readonly ModelProtocol[]
    type: ProviderType
    name: string
    codexHarnessAvailable?: boolean
  },
  framework: { id: AgentFrameworkId; displayName: string },
  frameworkEndpoints: readonly ModelProtocol[],
  t: TFunction
): string => {
  const required = requiredSubscriptionFramework(provider, framework.id, t)
  if (required) {
    return t('Switch the agent framework to {{framework}} to use this subscription.', {
      framework: required
    })
  }
  const endpoints = providerEndpoints(provider)
  if (
    framework.id === 'codex' &&
    frameworkEndpoints.includes('responses') &&
    endpoints.includes('chat-completions')
  ) {
    return t(
      '{{provider}} speaks /v1/chat/completions. Codex requires /v1/responses; choose an OpenAI Responses provider or switch the agent framework.',
      { provider: provider.name }
    )
  }
  return t('{{framework}} needs {{frameworkRoutes}}, but {{provider}} speaks {{providerRoutes}}.', {
    framework: framework.displayName,
    frameworkRoutes: routeList(frameworkEndpoints, t),
    provider: provider.name,
    providerRoutes: routeList(endpoints, t)
  })
}

export const unavailableGroupReason = (
  options: readonly ConfiguredModelCatalogEntry[],
  provider: ProviderView,
  framework: { id: AgentFrameworkId; displayName: string },
  frameworkEndpoints: readonly ModelProtocol[],
  t: TFunction
): string | undefined => {
  const first = options[0]
  if (!first) return undefined
  if (options.every((option) => option.unavailableReason === first.unavailableReason)) {
    if (first.unavailableReason === 'model-bridge-unsupported') {
      return t('No model from {{provider}} is supported over the Codex Chat Completions bridge.', {
        provider: provider.name
      })
    }
    if (
      first.unavailableReason === 'framework-incompatible' &&
      !isProviderUsableByFramework(provider, {
        id: framework.id,
        supportedApiTypes: frameworkEndpoints
      })
    ) {
      return incompatibilityReason(provider, framework, frameworkEndpoints, t)
    }
    if (first.unavailableReason === 'streaming-unsupported' || options.length === 1) {
      return modelUnavailableReason(first, provider, framework, frameworkEndpoints, t)
    }
  }
  return t('Unavailable for {{framework}}', { framework: framework.displayName })
}
