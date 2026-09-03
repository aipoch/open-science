import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CODEX_SUBSCRIPTION_PROVIDER_ID, SETTINGS_FILE_VERSION } from '../../shared/settings'
import { sanitizeSettings } from './document-codec'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'

describe('settings document codec', () => {
  it('exposes one pure document boundary', async () => {
    expect(Object.keys(await import('./document-codec')).sort()).toEqual([
      'sanitizeSessionDetailsModel',
      'sanitizeSettings',
      'sanitizeSubagentModel'
    ])
  })

  it('fails closed for corrupt input', () => {
    expect(sanitizeSettings(null)).toEqual({ version: SETTINGS_FILE_VERSION, providers: [] })
    expect(sanitizeSettings(['not', 'a', 'document'])).toEqual({
      version: SETTINGS_FILE_VERSION,
      providers: []
    })
  })

  it('bounds providers and keeps the first valid record for duplicate IDs', () => {
    const providers = Array.from(
      { length: PROVIDER_RESOURCE_LIMITS.providers + 1 },
      (_, index) => ({ id: `provider-${index}`, type: 'custom', name: `Provider ${index}` })
    )
    providers.splice(1, 0, { id: 'provider-0', type: 'custom', name: 'Duplicate' })

    const settings = sanitizeSettings({ providers })

    expect(settings.providers).toHaveLength(PROVIDER_RESOURCE_LIMITS.providers)
    expect(settings.providers.filter(({ id }) => id === 'provider-0')).toEqual([
      expect.objectContaining({ name: 'Provider 0' })
    ])
    expect(settings.providers.at(-1)?.id).toBe(`provider-${PROVIDER_RESOURCE_LIMITS.providers - 1}`)
  })

  it('preserves current durable settings families and drops retired Runtime selections', () => {
    const dataRoot = resolve('portable-settings-data')
    const settings = sanitizeSettings({
      providers: [
        {
          id: 'builtin-codex-shared',
          type: 'codex-shared',
          name: 'Legacy Codex',
          model: 'codex-model',
          keyRef: 'encrypted:key',
          keyMask: 'sk-…abcd',
          apiKey: 'plaintext-must-not-survive'
        }
      ],
      activeProviderId: 'builtin-codex-shared',
      connectors: {
        enabledIds: ['pubmed'],
        autoAllowIds: [],
        pendingCustomServerDeletionIds: ['rna-reviewer', '', 'rna-reviewer', 42]
      },
      computeGrants: [{ projectId: 'p1', operation: 'download', providerId: 'c1' }],
      notebookRuntimes: { python: { source: 'managed' } },
      agentEnvironmentCreationEnabled: false,
      defaultPermissionProfile: 'ask',
      dataRoot,
      unknown: true
    })

    expect(settings).toMatchObject({
      version: SETTINGS_FILE_VERSION,
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      activeModel: 'codex-model',
      connectors: {
        enabledIds: ['pubmed'],
        autoAllowIds: [],
        pendingCustomServerDeletionIds: ['rna-reviewer']
      },
      computeGrants: [{ projectId: 'p1', operation: 'download', providerId: 'c1' }],
      agentEnvironmentCreationEnabled: false,
      defaultPermissionProfile: 'ask',
      dataRoot
    })
    expect(settings.providers).toEqual([
      expect.objectContaining({
        id: CODEX_SUBSCRIPTION_PROVIDER_ID,
        type: 'codex-isolated',
        keyRef: 'encrypted:key',
        keyMask: 'sk-…abcd'
      })
    ])
    expect(settings.providers[0]).not.toHaveProperty('apiKey')
    expect(settings).not.toHaveProperty('notebookRuntimes')
    expect(settings).not.toHaveProperty('unknown')
  })

  it('drops a malformed Agent environment creation policy', () => {
    expect(
      sanitizeSettings({ providers: [], agentEnvironmentCreationEnabled: 'false' })
    ).not.toHaveProperty('agentEnvironmentCreationEnabled')
  })
})

describe('sanitizeSessionDetailsModel', () => {
  it('defaults missing and malformed values to inherit with Low effort', async () => {
    const { sanitizeSessionDetailsModel } = await import('./document-codec')
    expect(sanitizeSessionDetailsModel(undefined)).toEqual({
      mode: 'inherit',
      reasoningEffort: 'low'
    })
    expect(sanitizeSessionDetailsModel({ mode: 'inherit' })).toEqual({
      mode: 'inherit',
      reasoningEffort: 'low'
    })
  })

  it('round-trips inherit, fixed, and disabled policies', async () => {
    const { sanitizeSessionDetailsModel } = await import('./document-codec')
    expect(sanitizeSessionDetailsModel({ mode: 'inherit', reasoningEffort: 'high' })).toEqual({
      mode: 'inherit',
      reasoningEffort: 'high'
    })
    expect(
      sanitizeSessionDetailsModel({
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'low'
      })
    ).toEqual({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low'
    })
    expect(sanitizeSessionDetailsModel({ mode: 'disabled' })).toEqual({ mode: 'disabled' })
  })
})
