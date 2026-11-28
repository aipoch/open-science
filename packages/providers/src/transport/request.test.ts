import { describe, expect, it, vi } from 'vitest'
import { fetchProviderRequest } from './request'

describe('fetchProviderRequest', () => {
  it('allows a granted remote HTTP request and still disables redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
    await fetchProviderRequest(fetchImpl, 'http://gateway.example/v1/chat/completions', {
      allowInsecureHttp: true
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://gateway.example/v1/chat/completions',
      expect.objectContaining({ redirect: 'manual' })
    )
  })
})
