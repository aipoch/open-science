import { describe, expect, it, vi } from 'vitest'

import {
  networkProxyValidationMessage,
  normalizeNetworkProxySettings
} from '../../shared/network-proxy'
import { NetworkProxyRuntime } from './network-proxy-runtime'

describe('NetworkProxyRuntime', () => {
  it('applies a manual proxy to Electron and future child-process environment values', async () => {
    const environment: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://old.example:8080',
      NO_PROXY: 'old.internal'
    }
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const runtime = new NetworkProxyRuntime({ environment, setProxy })

    await runtime.apply({
      mode: 'manual',
      server: 'socks5://127.0.0.1:1086',
      bypassRules: 'example.internal'
    })

    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1086',
      proxyBypassRules: expect.stringContaining('example.internal')
    })
    expect(environment.HTTP_PROXY).toBe('socks5://127.0.0.1:1086')
    expect(environment.HTTPS_PROXY).toBe('socks5://127.0.0.1:1086')
    expect(environment.ALL_PROXY).toBe('socks5://127.0.0.1:1086')
    expect(environment.NO_PROXY).toContain('127.0.0.1')
    expect(environment.NO_PROXY).toContain('example.internal')
    expect(environment.NO_PROXY).not.toContain('old.internal')
  })

  it('clears inherited proxy variables in Direct mode', async () => {
    const environment: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://old.example:8080',
      NO_PROXY: 'old.internal'
    }
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const runtime = new NetworkProxyRuntime({ environment, setProxy })

    await runtime.apply({ mode: 'direct' })

    expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' })
    expect(environment.HTTP_PROXY).toBeUndefined()
    expect(environment.NO_PROXY).toBeUndefined()
  })

  it('uses the system Session proxy and projects the resolved endpoint', async () => {
    const environment: NodeJS.ProcessEnv = {}
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const runtime = new NetworkProxyRuntime({
      environment,
      setProxy,
      resolveProxy: vi.fn().mockResolvedValue('PROXY system.example:3128')
    })

    await runtime.apply(undefined)

    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(environment.HTTP_PROXY).toBe('http://system.example:3128')
    expect(environment.NO_PROXY).toContain('localhost')
  })

  it('restores the launcher proxy if system proxy resolution fails', async () => {
    const environment: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://launcher.example:8080' }
    const runtime = new NetworkProxyRuntime({
      environment,
      setProxy: vi.fn().mockResolvedValue(undefined),
      resolveProxy: vi.fn().mockRejectedValue(new Error('resolver unavailable'))
    })

    await runtime.apply({
      mode: 'manual',
      server: 'http://manual.example:3128',
      bypassRules: 'manual.internal'
    })
    await runtime.apply({ mode: 'system' })

    expect(environment.HTTPS_PROXY).toBe('http://launcher.example:8080')
    expect(environment.NO_PROXY).toContain('127.0.0.1')
    expect(environment.NO_PROXY).not.toContain('manual.internal')
  })
})

describe('network proxy settings', () => {
  it('normalizes manual URLs and bypass rules', () => {
    expect(
      normalizeNetworkProxySettings({
        mode: 'manual',
        server: ' http://proxy.example:8080/ ',
        bypassRules: ' example.internal;localhost\nexample.internal '
      })
    ).toEqual({
      mode: 'manual',
      server: 'http://proxy.example:8080',
      bypassRules: 'example.internal,localhost'
    })
  })

  it('rejects embedded proxy credentials', () => {
    expect(
      networkProxyValidationMessage({
        mode: 'manual',
        server: 'http://user:secret@proxy.example:8080'
      })
    ).toBe('Proxy URLs with embedded usernames or passwords are not supported.')
  })
})
