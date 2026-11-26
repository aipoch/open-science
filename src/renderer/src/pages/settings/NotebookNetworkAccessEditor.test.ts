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

  it('rejects a duplicate destination before normalization can discard the list', () => {
    const rules = ['a.example', 'b.example', 'c.example'].map((hostname) => ({
      ...shared,
      hostname
    }))
    const settings = { ...duplicateSettings(), trustedPrivateDestinations: rules }
    expect(
      updateNotebookNetworkRule(settings, trustedDestinationId(rules[0]), {
        hostnamePattern: rules[1].hostname,
        port: shared.port,
        protocol: shared.protocol
      })
    ).toBe('duplicate')
    expect(settings.trustedPrivateDestinations).toEqual(rules)
  })

  it('edits the shared identity instead of recreating the strict duplicate', () => {
    const settings = duplicateSettings()
    const next = updateNotebookNetworkRule(settings, trustedDestinationId(shared), {
      hostnamePattern: 'next.example',
      port: 8081,
      protocol: 'http'
    })

    if (typeof next === 'string') throw new Error(next)
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
