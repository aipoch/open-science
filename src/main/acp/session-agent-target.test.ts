import { describe, expect, it } from 'vitest'

import {
  CODEX_ISOLATED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  type ProviderView,
  type SettingsSnapshot
} from '../../shared/settings'
import {
  materializeSessionAgentConfiguration,
  resolveValidatedSessionAgentTarget,
  toAcpSessionAgentTarget
} from './session-agent-target'

const provider = (
  id: string,
  model: string,
  apiEndpoints: ProviderView['apiEndpoints'] = ['openai']
): ProviderView => ({
  id,
  type: 'custom',
  name: id,
  apiEndpoints,
  baseUrl: 'https://example.test/v1',
  model,
  models: [model],
  supportsImageInput: false,
  hasKey: true,
  needsKey: false
})

const settings = (overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot =>
  ({
    claude: {},
    opencode: {},
    codex: {},
    claudeManaged: false,
    opencodeManaged: false,
    codexManaged: false,
    appIconVariant: 'light',
    reasoningEffort: 'high',
    agentFrameworkId: 'opencode',
    agentFrameworks: [
      {
        id: 'opencode',
        displayName: 'OpenCode',
        supportsSkills: true,
        supportedApiTypes: ['openai']
      }
    ],
    providers: [provider('ready', 'ready-model')],
    activeProviderId: 'ready',
    activeModel: 'ready-model',
    ...overrides
  }) as SettingsSnapshot

describe('Session agent target', () => {
  it('combines the active framework with a durable Session configuration', () => {
    expect(
      toAcpSessionAgentTarget('opencode', {
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high'
      })
    ).toEqual({
      frameworkId: 'opencode',
      providerId: 'provider-1',
      model: 'model-1',
      reasoningEffort: 'high'
    })
    expect(toAcpSessionAgentTarget('codex')).toBeUndefined()
  })

  it('normalizes legacy Codex provider aliases when materializing a Session target', () => {
    expect(
      materializeSessionAgentConfiguration(
        { agentBackendId: `codex:${CODEX_ISOLATED_PROVIDER_ID}`, agentModel: 'gpt-5.4' },
        'high'
      )
    ).toEqual({
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'gpt-5.4',
      reasoningEffort: 'high'
    })
  })

  it('keeps a selectable persisted Session target', () => {
    expect(
      resolveValidatedSessionAgentTarget(
        {
          agentConfiguration: {
            providerId: 'ready',
            model: 'ready-model',
            reasoningEffort: 'low'
          }
        },
        settings()
      )
    ).toEqual({
      frameworkId: 'opencode',
      providerId: 'ready',
      model: 'ready-model',
      reasoningEffort: 'low'
    })
  })

  it('rejects an unavailable Session target despite an available Settings Active Model', () => {
    expect(() =>
      resolveValidatedSessionAgentTarget(
        {
          agentConfiguration: {
            providerId: 'deleted',
            model: 'gone',
            reasoningEffort: 'low'
          }
        },
        settings({
          providers: [provider('ready', 'settings-model')],
          activeModel: 'settings-model'
        })
      )
    ).toThrow('Session agent target is unavailable')
  })

  it('validates the actual provider default without pinning it or accepting another available model', () => {
    const configuration = { providerId: 'ready', reasoningEffort: 'high' as const }
    const source = { agentConfiguration: configuration }
    const originalProvider = {
      ...provider('ready', 'default-model'),
      models: ['other-model', 'default-model']
    }
    const snapshot = settings({ providers: [originalProvider] })
    expect(resolveValidatedSessionAgentTarget(source, snapshot)).toEqual({
      frameworkId: 'opencode',
      ...configuration
    })
    const failed = settings({
      providers: [
        {
          ...originalProvider,
          lastValidationFailure: {
            at: 1,
            category: 'network',
            target: { model: 'default-model', endpoint: 'openai' }
          }
        }
      ]
    })
    expect(() => resolveValidatedSessionAgentTarget(source, failed)).toThrow(
      'Session agent target is unavailable'
    )
    expect(resolveValidatedSessionAgentTarget(source, snapshot)).toEqual({
      frameworkId: 'opencode',
      ...configuration
    })
    expect(
      resolveValidatedSessionAgentTarget(
        source,
        settings({
          providers: [
            {
              ...failed.providers[0],
              model: 'other-model'
            }
          ]
        })
      )
    ).toEqual({ frameworkId: 'opencode', ...configuration })
    expect(source.agentConfiguration).toEqual(configuration)
  })

  it('fails closed when neither the Session target nor Settings is selectable', () => {
    expect(() =>
      resolveValidatedSessionAgentTarget(
        {
          agentConfiguration: {
            providerId: 'deleted',
            model: 'gone',
            reasoningEffort: 'low'
          }
        },
        settings({
          providers: [provider('incompatible', 'other', ['anthropic'])],
          activeProviderId: 'incompatible',
          activeModel: 'other'
        })
      )
    ).toThrow('Session agent target is unavailable')
  })
})
