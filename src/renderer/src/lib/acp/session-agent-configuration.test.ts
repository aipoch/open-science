import { describe, expect, it } from 'vitest'

import type { ConfiguredModelCatalogEntry } from '../../../../shared/configured-model-catalog'
import {
  isConfigurationSelectable,
  resolveSelectableConfiguration,
  resolveSessionAgentConfiguration
} from './session-agent-configuration'

const option = (
  providerId: string,
  model: string,
  selectable = true,
  providerType: ConfiguredModelCatalogEntry['providerType'] = 'custom'
): ConfiguredModelCatalogEntry => ({
  key: JSON.stringify([providerId, model]),
  providerId,
  providerName: providerId,
  providerType,
  model,
  label: model || providerId,
  selectable,
  supportsImageInput: false
})

describe('Session agent configuration', () => {
  it('keeps a selectable Session configuration', () => {
    const configuration = { providerId: 'session', model: 'old', reasoningEffort: 'high' as const }
    expect(
      resolveSessionAgentConfiguration({
        session: { agentConfiguration: configuration },
        catalog: [option('session', 'old'), option('active', 'new')],
        activeProviderId: 'active',
        activeModel: 'new',
        activeReasoningEffort: 'low'
      })
    ).toEqual({ status: 'ready', configuration, changed: false })
  })

  it('lazily resolves a provider-default Session model without switching providers', () => {
    const configuration = { providerId: 'session', reasoningEffort: 'high' as const }
    const catalog = [option('session', 'provider-default'), option('active', 'new')]

    expect(isConfigurationSelectable(configuration, catalog)).toBe(true)
    expect(
      resolveSessionAgentConfiguration({
        session: { agentConfiguration: configuration },
        catalog,
        activeProviderId: 'active',
        activeModel: 'new',
        activeReasoningEffort: 'low'
      })
    ).toEqual({
      status: 'ready',
      configuration: {
        providerId: 'session',
        model: 'provider-default',
        reasoningEffort: 'high'
      },
      changed: false
    })
  })

  it('keeps an omitted Codex subscription model as the account-owned default', () => {
    const configuration = { providerId: 'codex', reasoningEffort: 'high' as const }
    const catalog = [
      option('codex', 'gpt-5.4', true, 'codex-shared'),
      option('codex', 'gpt-5', true, 'codex-shared'),
      option('active', 'new')
    ]

    expect(isConfigurationSelectable(configuration, catalog)).toBe(true)
    expect(resolveSelectableConfiguration(catalog, 'codex', undefined, 'default')).toEqual({
      providerId: 'codex',
      reasoningEffort: 'default'
    })
    expect(
      resolveSessionAgentConfiguration({
        session: { agentConfiguration: configuration },
        catalog,
        activeProviderId: 'active',
        activeModel: 'new',
        activeReasoningEffort: 'low'
      })
    ).toEqual({ status: 'ready', configuration, changed: false })
  })

  it('keeps an omitted Claude subscription model as the account-owned default', () => {
    const configuration = { providerId: 'claude', reasoningEffort: 'default' as const }
    const catalog = [
      option('claude', 'claude-opus-4-6', true, 'claude-shared'),
      option('claude', 'claude-sonnet-4-6', true, 'claude-shared')
    ]

    expect(
      resolveSessionAgentConfiguration({
        session: { agentConfiguration: configuration },
        catalog,
        activeProviderId: 'claude',
        activeModel: 'claude-sonnet-4-6',
        activeReasoningEffort: 'low'
      })
    ).toEqual({ status: 'ready', configuration, changed: false })
  })

  it('materializes a Codex historical Session without pinning the first catalog model', () => {
    expect(
      resolveSessionAgentConfiguration({
        session: { agentBackendId: 'codex:codex' },
        catalog: [
          option('codex', 'gpt-5.4', true, 'codex-shared'),
          option('codex', 'gpt-5', true, 'codex-shared')
        ],
        activeReasoningEffort: 'xhigh'
      })
    ).toEqual({
      status: 'ready',
      configuration: { providerId: 'codex', reasoningEffort: 'xhigh' },
      changed: true
    })
  })

  it('lazily replaces an unavailable Session model with a valid active default', () => {
    expect(
      resolveSessionAgentConfiguration({
        session: {
          agentConfiguration: {
            providerId: 'deleted',
            model: 'gone',
            reasoningEffort: 'high'
          }
        },
        catalog: [option('active', 'new')],
        activeProviderId: 'active',
        activeModel: 'new',
        activeReasoningEffort: 'medium'
      })
    ).toEqual({
      status: 'ready',
      configuration: { providerId: 'active', model: 'new', reasoningEffort: 'medium' },
      changed: true
    })
  })

  it('resolves a custom Provider singular model when the active model is implicit', () => {
    expect(
      resolveSessionAgentConfiguration({
        session: {},
        catalog: [option('custom', 'custom-model')],
        activeProviderId: 'custom',
        activeReasoningEffort: 'default'
      })
    ).toEqual({
      status: 'ready',
      configuration: {
        providerId: 'custom',
        model: 'custom-model',
        reasoningEffort: 'default'
      },
      changed: true
    })
  })

  it('preserves the Session preference when the active default is also unavailable', () => {
    const configuration = {
      providerId: 'deleted',
      model: 'gone',
      reasoningEffort: 'high' as const
    }
    expect(
      resolveSessionAgentConfiguration({
        session: { agentConfiguration: configuration },
        catalog: [option('active', 'new', false)],
        activeProviderId: 'active',
        activeModel: 'new',
        activeReasoningEffort: 'medium'
      })
    ).toEqual({ status: 'unavailable', configuration })
  })

  it('materializes a historical Session from its backend/model and current effort', () => {
    expect(
      resolveSessionAgentConfiguration({
        session: { agentBackendId: 'codex:legacy', agentModel: 'saved' },
        catalog: [option('legacy', 'saved')],
        activeReasoningEffort: 'xhigh'
      })
    ).toEqual({
      status: 'ready',
      configuration: { providerId: 'legacy', model: 'saved', reasoningEffort: 'xhigh' },
      changed: true
    })
  })
})
