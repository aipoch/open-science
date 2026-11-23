import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../../../shared/notebook-network'
import type { NotebookNetworkSettings } from '../../../../shared/notebook-network-settings'
import { trustedDestinationId } from '../../../../shared/notebook-network-settings'
import {
  removeNotebookNetworkRule,
  updateNotebookNetworkRule
} from './notebook-network-rule-operations'

const shared = {
  sharedWithAgent: true as const,
  hostname: 'gateway.example',
  port: 8080,
  protocol: 'http' as const,
  approvedAddresses: []
}

const duplicateSettings = (): NotebookNetworkSettings => ({
  ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  mode: 'strict',
  strictWhitelist: [
    {
      id: 'strict-duplicate',
      hostnamePattern: shared.hostname,
      port: shared.port,
      protocol: shared.protocol,
      origin: 'manual'
    }
  ],
  trustedPrivateDestinations: [shared]
})

describe('NotebookNetworkAccessEditor shared HTTP rules', () => {
  it('deletes both identities when a shared HTTP rule is duplicated in strict mode', () => {
    const settings = duplicateSettings()
    const next = removeNotebookNetworkRule(settings, trustedDestinationId(shared))

    expect(next.trustedPrivateDestinations).toEqual([])
    expect(next.strictWhitelist).toEqual([])
  })

  it('edits the shared identity instead of recreating the strict duplicate', () => {
    const settings = duplicateSettings()
    const next = updateNotebookNetworkRule(settings, trustedDestinationId(shared), {
      hostnamePattern: 'next.example',
      port: 8081,
      protocol: 'http'
    })

    expect(next.strictWhitelist).toEqual([])
    expect(next.trustedPrivateDestinations).toEqual([
      expect.objectContaining({
        sharedWithAgent: true,
        hostname: 'next.example',
        port: 8081,
        protocol: 'http'
      })
    ])
  })
})
