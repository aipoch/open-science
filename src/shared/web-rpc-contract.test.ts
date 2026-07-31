import { describe, expect, it } from 'vitest'

import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'
import {
  isWebRpcChannel,
  isWebRpcEventChannel,
  WEB_RPC_ALLOWED_CHANNELS,
  WEB_RPC_PROTOCOL_VERSION,
  WEB_RPC_UNAVAILABLE_CHANNELS,
  webRpcRequestSchema,
  webRpcResponseSchema
} from './web-rpc-contract'

describe('Web RPC contract', () => {
  it('classifies every preload invoke channel into the positive allowlist or explicit exclusions', () => {
    const preloadChannels = [...new Set(Object.values(WEB_INVOKE_CHANNELS))].sort()
    const classifiedChannels = [
      ...new Set([...WEB_RPC_ALLOWED_CHANNELS, ...WEB_RPC_UNAVAILABLE_CHANNELS])
    ].sort()

    expect(classifiedChannels).toEqual(preloadChannels)
    expect(WEB_RPC_ALLOWED_CHANNELS).toContain('projects:list')
    expect(WEB_RPC_ALLOWED_CHANNELS).not.toContain('window:close')
    expect(WEB_RPC_UNAVAILABLE_CHANNELS.every((channel) => !isWebRpcChannel(channel))).toBe(true)
  })

  it('uses the generated event interface as its positive event allowlist', () => {
    const preloadEvents = [...new Set(Object.values(WEB_EVENT_CHANNELS))].sort()
    expect(preloadEvents.every(isWebRpcEventChannel)).toBe(true)
    expect(isWebRpcEventChannel('test:internal')).toBe(false)
  })

  it('validates versioned request and response envelopes at runtime', () => {
    expect(
      webRpcRequestSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args: [{ projectId: 'project-1' }, Uint8Array.from([1, 2, 3])]
      }).success
    ).toBe(true)
    expect(webRpcRequestSchema.safeParse({ protocolVersion: 2, args: [] }).success).toBe(false)
    expect(
      webRpcRequestSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args: 'not-an-array'
      }).success
    ).toBe(false)
    expect(
      webRpcResponseSchema.safeParse({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid request.' }
      }).success
    ).toBe(true)
  })
})
