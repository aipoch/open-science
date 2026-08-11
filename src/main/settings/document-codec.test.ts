import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CODEX_SUBSCRIPTION_PROVIDER_ID, SETTINGS_FILE_VERSION } from '../../shared/settings'
import { sanitizeSettings } from './document-codec'

describe('settings document codec', () => {
  it('exposes one pure document boundary', async () => {
    expect(Object.keys(await import('./document-codec')).sort()).toEqual([
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

  it('preserves cross-field migrations and durable settings families', () => {
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
      connectors: { enabledIds: ['pubmed'], autoAllowIds: [] },
      computeGrants: [{ projectId: 'p1', operation: 'download', providerId: 'c1' }],
      notebookRuntimes: { python: { source: 'managed' } },
      defaultPermissionProfile: 'ask',
      dataRoot,
      unknown: true
    })

    expect(settings).toMatchObject({
      version: SETTINGS_FILE_VERSION,
      activeProviderId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      activeModel: 'codex-model',
      connectors: { enabledIds: ['pubmed'], autoAllowIds: [] },
      computeGrants: [{ projectId: 'p1', operation: 'download', providerId: 'c1' }],
      notebookRuntimes: { python: { source: 'managed' } },
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
    expect(settings).not.toHaveProperty('unknown')
  })
})
