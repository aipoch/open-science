import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

const { netFetch } = await import('./net-fetch')

describe('netFetch', () => {
  beforeEach(() => fetchMock.mockReset())

  it('delegates to Electron net.fetch with the given url and init', async () => {
    const response = { ok: true, status: 200 }
    fetchMock.mockResolvedValue(response)

    const init = { headers: { 'User-Agent': 'open-science' } }
    const result = await netFetch('https://api.github.com/repos/o/r', init)

    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/o/r', init)
    expect(result).toBe(response)
  })

  it('propagates the Chromium network stack status (e.g. proxy-routed success)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    const result = await netFetch('https://api.github.com/repos/o/r/git/trees/main?recursive=1')

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })
})
