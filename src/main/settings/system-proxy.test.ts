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

    await expect(
      resolveSystemProxyEnvironment(resolveProxy, {
        NO_PROXY: 'metadata.example.test',
        no_proxy: 'existing.internal'
      })
    ).resolves.toMatchObject({
      HTTPS_PROXY: 'https://secure-proxy.example.test:8443',
      NO_PROXY: expect.stringContaining('metadata.example.test'),
      no_proxy: expect.stringContaining('existing.internal')
    })
    expect(resolveProxy).toHaveBeenCalledWith('https://chatgpt.com/')
  })

  it('bypasses the resolved proxy for every supported loopback route form', async () => {
    const resolved = await resolveSystemProxyEnvironment(
      vi.fn().mockResolvedValue('PROXY proxy.example.test:3128'),
      {}
    )
    expect(resolved).toBeDefined()

    for (const host of ['localhost', '127.0.0.1', '127.0.0.0/8', '::1', '[::1]']) {
      expect(resolved?.NO_PROXY?.split(',')).toContain(host)
      expect(resolved?.no_proxy?.split(',')).toContain(host)
    }
  })

  it.each(['NO_PROXY', 'no_proxy'] as const)(
    'preserves inherited bypasses in both aliases when only %s is defined',
    async (key) => {
      const inheritedBypass = 'metadata.example.test'
      const resolved = await resolveSystemProxyEnvironment(
        vi.fn().mockResolvedValue('PROXY proxy.example.test:3128'),
        { [key]: inheritedBypass }
      )

      expect(resolved?.NO_PROXY?.split(',')).toContain(inheritedBypass)
      expect(resolved?.no_proxy?.split(',')).toContain(inheritedBypass)
    }
  )

  it('falls back to the inherited or direct network when resolution fails', async () => {
    const resolveProxy = vi.fn().mockRejectedValue(new Error('proxy resolver unavailable'))

    await expect(resolveSystemProxyEnvironment(resolveProxy)).resolves.toBeUndefined()
  })

  it('does not add bypass variables when the system selects direct access', async () => {
    await expect(
      resolveSystemProxyEnvironment(vi.fn().mockResolvedValue('DIRECT'), {
        NO_PROXY: 'existing.internal'
      })
    ).resolves.toEqual({})
  })
})
