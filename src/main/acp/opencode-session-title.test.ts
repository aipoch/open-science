import { describe, expect, it, vi } from 'vitest'

import { fetchOpenCodeSessionTitle } from './opencode-session-title'

describe('OpenCode Session title API', () => {
  it('reads the native Session title from the generation-pinned loopback API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'provider-1', title: '  Native OpenCode Title  ' }), {
        status: 200
      })
    )

    await expect(
      fetchOpenCodeSessionTitle(
        { baseUrl: 'https://opencode.example/v1', authorization: 'Bearer generation-1' },
        'provider/1',
        '/workspace with spaces',
        fetchImpl
      )
    ).resolves.toBe('Native OpenCode Title')

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe(
      'https://opencode.example/session/provider%2F1?directory=%2Fworkspace+with+spaces'
    )
    expect(init?.headers).toEqual({ authorization: 'Bearer generation-1' })
  })

  it.each([
    ['empty title', new Response(JSON.stringify({ title: '   ' }), { status: 200 })],
    ['invalid payload', new Response(JSON.stringify([]), { status: 200 })],
    ['HTTP failure', new Response('unavailable', { status: 503 })]
  ])('returns no title for %s', async (_case, response) => {
    await expect(
      fetchOpenCodeSessionTitle(
        { baseUrl: 'https://opencode.example', authorization: 'Bearer generation-1' },
        'provider-1',
        '/workspace',
        vi.fn<typeof fetch>().mockResolvedValueOnce(response)
      )
    ).resolves.toBeUndefined()
  })

  it('treats a rejected request as best-effort absence', async () => {
    await expect(
      fetchOpenCodeSessionTitle(
        { baseUrl: 'https://opencode.example', authorization: 'Bearer generation-1' },
        'provider-1',
        '/workspace',
        vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('loopback unavailable'))
      )
    ).resolves.toBeUndefined()
  })
})
