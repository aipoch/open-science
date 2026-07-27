import { describe, expect, it, vi } from 'vitest'

import { parseSystemProxyRules, resolveSystemProxyEnvironment } from './system-proxy'

describe('parseSystemProxyRules', () => {
  it('maps the first generic HTTP proxy to the standard child-process variables', () => {
    expect(parseSystemProxyRules('PROXY proxy.example.test:3128; DIRECT')).toEqual({
      HTTP_PROXY: 'http://proxy.example.test:3128',
      HTTPS_PROXY: 'http://proxy.example.test:3128',
      http_proxy: 'http://proxy.example.test:3128',
      https_proxy: 'http://proxy.example.test:3128'
    })
  })

  it('maps a SOCKS fallback to the protocol-neutral proxy variables', () => {
    expect(parseSystemProxyRules('SOCKS5 localhost:9050')).toEqual({
      ALL_PROXY: 'socks5://localhost:9050',
      all_proxy: 'socks5://localhost:9050'
    })
  })

  it('keeps a direct system decision direct', () => {
    expect(parseSystemProxyRules('DIRECT')).toEqual({})
  })
})

describe('resolveSystemProxyEnvironment', () => {
  it('asks Electron to resolve the subscription origin', async () => {
    const resolveProxy = vi.fn().mockResolvedValue('HTTPS secure-proxy.example.test:8443')

    await expect(resolveSystemProxyEnvironment(resolveProxy)).resolves.toMatchObject({
      HTTPS_PROXY: 'https://secure-proxy.example.test:8443'
    })
    expect(resolveProxy).toHaveBeenCalledWith('https://chatgpt.com/')
  })

  it('falls back to the inherited or direct network when resolution fails', async () => {
    const resolveProxy = vi.fn().mockRejectedValue(new Error('proxy resolver unavailable'))

    await expect(resolveSystemProxyEnvironment(resolveProxy)).resolves.toEqual({})
  })
})
