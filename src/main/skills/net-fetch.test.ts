import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const fetchMock = vi.fn()
const requestMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: fetchMock, request: requestMock } }))

const { netFetch, netFetchWithManualRedirect } = await import('./net-fetch')

function outgoing(): EventEmitter & {
  end: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
} {
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    abort: vi.fn(),
    setHeader: vi.fn()
  })
  request.abort.mockImplementation(() => request.emit('close'))
  requestMock.mockReturnValueOnce(request)
  return request
}

describe('netFetch', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns manual redirects without following them or sending cookies', async () => {
    const request = outgoing()
    const response = netFetchWithManualRedirect('https://github.com/example', {
      redirect: 'manual'
    })
    request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/example')
    expect((await response).headers.get('location')).toBe(
      'https://release-assets.githubusercontent.com/example'
    )
    expect(request.abort).toHaveBeenCalledOnce()
    expect(requestMock).toHaveBeenLastCalledWith({
      url: 'https://github.com/example',
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit'
    })
  })

  it('streams direct responses and propagates cancellation while awaiting headers', async () => {
    const request = outgoing()
    const response = netFetchWithManualRedirect('https://github.com/example', {
      redirect: 'manual'
    })
    const incoming = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: { 'content-type': ['application/zip'] }
    })
    request.emit('response', incoming)
    incoming.end('package')
    expect(await (await response).text()).toBe('package')
    const aborted = outgoing()
    const controller = new AbortController()
    const pending = netFetchWithManualRedirect('https://github.com/example', {
      redirect: 'manual',
      signal: controller.signal
    })
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(aborted.abort).toHaveBeenCalledOnce()
  })

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
