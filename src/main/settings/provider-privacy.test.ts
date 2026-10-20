import { describe, expect, it, vi } from 'vitest'

import { getCustomProviderBaseUrlError } from '../../shared/provider-url-policy'
import { fetchProviderRequest } from '@aipoch/providers/transport'
import { resolveProviderDraft } from './provider-draft-projection'
import { createProvider } from '@aipoch/providers/client'
import { validateProvider } from './validate'

describe('provider transport privacy', () => {
  it.each([
    'http://remote-gateway.invalid',
    'http://192.168.1.8:8000',
    'http://[::ffff:127.0.0.1]',
    'http://localhost.example.com',
    'http://127.0.0.1.example.com'
  ])('rejects remote HTTP before validation or catalog credentials leave: %s', async (baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 })
    )
    const target = resolveProviderDraft({
      type: 'custom',
      baseUrl,
      key: 'PRIVACY_KEY_CANARY',
      model: 'test-model',
      apiEndpoints: ['chat-completions']
    })
    const validation = await validateProvider(target, { fetchImpl })
    const catalog = await createProvider({
      id: 'custom',
      discovery: { url: `${baseUrl}/v1/models` },
      key: target.key,
      fetch: fetchImpl
    }).listModels()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(validation.ok).toBe(false)
    expect(catalog.ok).toBe(false)
    expect(getCustomProviderBaseUrlError(baseUrl)).toBeDefined()
  })

  it.each([
    'https://gateway.invalid:8443',
    'http://localhost:8000',
    'http://127.0.0.2:8000',
    'http://[::1]:8000',
    'http://2130706433:8000'
  ])('preserves HTTPS and loopback model validation: %s', async (baseUrl) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'))
    const target = resolveProviderDraft({
      type: 'custom',
      baseUrl,
      key: 'LOCAL_CANARY',
      model: 'test-model',
      apiEndpoints: ['chat-completions']
    })
    expect(getCustomProviderBaseUrlError(baseUrl)).toBeUndefined()
    await validateProvider(target, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('manual')
  })

  it.each(['string', 'URL', 'Request'])(
    'guards the actual request boundary for %s inputs from old configurations',
    async (kind) => {
      const url = 'http://remote-gateway.invalid/v1/chat/completions'
      const input = kind === 'URL' ? new URL(url) : kind === 'Request' ? new Request(url) : url
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'))
      await expect(async () =>
        fetchProviderRequest(fetchImpl, input, {
          method: 'POST',
          headers: { authorization: 'Bearer PRIVACY_KEY_CANARY' },
          body: 'PRIVATE_RESEARCH_CANARY'
        })
      ).rejects.toThrow()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )
})
