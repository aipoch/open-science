import { describe, expect, it } from 'vitest'
import {
  providerNetworkAuthority,
  providerNetworkDestination,
  providerNetworkDestinationMatches
} from './provider-network-authorization'

describe('provider network authorization', () => {
  it('normalizes an HTTP provider URL to an exact authority', () => {
    expect(providerNetworkDestination('http://Gateway.Example/v1')).toEqual({
      sharedWithAgent: true,
      hostname: 'gateway.example',
      port: 80,
      protocol: 'http',
      approvedAddresses: []
    })
  })

  it('does not authorize HTTPS, credentials, queries, or fragments', () => {
    expect(providerNetworkDestination('https://gateway.example/v1')).toBeUndefined()
    expect(providerNetworkDestination('http://user:pass@gateway.example/v1')).toBeUndefined()
    expect(providerNetworkDestination('http://gateway.example/v1?key=secret')).toBeUndefined()
    expect(providerNetworkAuthority('http://gateway.example/v1#fragment')).toBeUndefined()
  })

  it('matches protocol, host, and port but not path or another port', () => {
    const rule = providerNetworkDestination('http://gateway.example:8080/v1')!
    expect(providerNetworkDestinationMatches('http://gateway.example:8080/other', rule)).toBe(true)
    expect(
      providerNetworkDestinationMatches('http://gateway.example:8080/v1?beta=true', rule)
    ).toBe(true)
    expect(providerNetworkDestinationMatches('http://gateway.example:8081/v1', rule)).toBe(false)
    expect(providerNetworkDestinationMatches('https://gateway.example:8080/v1', rule)).toBe(false)
    expect(providerNetworkDestinationMatches('http://api.gateway.example:8080/v1', rule)).toBe(
      false
    )
  })
})
