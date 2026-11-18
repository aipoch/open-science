import { describe, expect, it } from 'vitest'

import { LabApiError } from './lab-api'
import type { ProtocolForwardingBridgeTarget } from './protocol-forwarding-bridge'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import { ProviderTransportOwner } from './provider-transport-owner'
import type { StoredProvider } from './types'

const labProvider = (): StoredProvider => ({
  id: 'builtin-lab',
  type: 'lab',
  name: 'Lab',
  baseUrl: 'https://lab.example.com/v1',
  apiEndpoints: ['chat-completions'],
  fetchedModels: ['lab:research-default'],
  modelProtocols: { 'lab:research-default': ['chat-completions'] },
  labServerUrl: 'https://lab.example.com'
})

describe('Lab harness forwarding', () => {
  it('refuses a model endpoint outside the configured deployment', async () => {
    const projection = new ProviderRuntimeProjectionOwner()
    const target = projection.resolveRuntimeTarget(
      { ...labProvider(), baseUrl: 'https://evil.example/v1' },
      { kind: 'required', model: 'lab:research-default' },
      { id: 'open-science-agent', supportedApiTypes: ['responses', 'messages', 'chat-completions'] }
    )
    const owner = new ProviderTransportOwner({
      getLabAccessToken: async () => 'at_live'
    })
    await expect(owner.acquireHarness(target, new AbortController().signal)).rejects.toThrow(
      'left the configured deployment'
    )
  })

  it('sends the gateway model id and the credential bound to the captured server', async () => {
    const projection = new ProviderRuntimeProjectionOwner()
    const target = projection.resolveRuntimeTarget(
      labProvider(),
      { kind: 'required', model: 'lab:research-default' },
      { id: 'open-science-agent', supportedApiTypes: ['responses', 'messages', 'chat-completions'] }
    )
    expect(target.effectiveModel).toBe('lab:research-default')

    const captured: ProtocolForwardingBridgeTarget[] = []
    const credentialServers: Array<string | undefined> = []
    const owner = new ProviderTransportOwner({
      getLabAccessToken: async (_forceRefresh, expectedServerUrl) => {
        credentialServers.push(expectedServerUrl)
        return 'at_live'
      },
      createProtocolForwardingBridge: (targets) => {
        captured.push(...targets)
        return {
          start: async () => ({ baseUrl: 'http://127.0.0.1:49152', token: 'loop-token' }),
          close: async () => undefined,
          setTarget: () => true,
          clearErrorReplay: () => undefined
        }
      }
    })

    const lease = await owner.acquireHarness(target, new AbortController().signal)
    try {
      expect(captured).toHaveLength(1)
      expect(captured[0]?.model).toBe('research-default')
      const connection = await captured[0]?.resolveConnection?.(new AbortController().signal)
      expect(connection).toEqual({
        endpoint: 'https://lab.example.com/v1/chat/completions',
        key: 'at_live'
      })
      expect(credentialServers).toEqual(['https://lab.example.com'])
      expect(
        captured[0]?.mapConnectionError?.(new LabApiError('unauthorized', 'Credentials expired'))
      ).toMatchObject({ status: 401, code: 'unauthorized' })
      expect(
        captured[0]?.mapConnectionError?.(new LabApiError('network', 'The server is offline'))
      ).toBeUndefined()
    } finally {
      await lease.release()
    }
  })
})
