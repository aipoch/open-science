import { describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations so the handler can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const { registerGithubIpcHandlers } = await import('./github-ipc')

const invoke = (channel: string): unknown => handlers.get(channel)!(undefined, undefined)

const jsonResponse = (body: unknown, ok = true): Response =>
  ({ ok, json: () => Promise.resolve(body) }) as unknown as Response

describe('github IPC handler', () => {
  it('registers the get-stars channel', () => {
    handlers.clear()
    registerGithubIpcHandlers({ fetch: vi.fn() })
    expect(handlers.has('github:get-stars')).toBe(true)
  })

  it('returns the star count on success', async () => {
    handlers.clear()
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ stargazers_count: 1234 }))
    registerGithubIpcHandlers({ fetch })
    await expect(invoke('github:get-stars')).resolves.toBe(1234)
  })

  it('returns null on a non-200 response', async () => {
    handlers.clear()
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}, false))
    registerGithubIpcHandlers({ fetch })
    await expect(invoke('github:get-stars')).resolves.toBeNull()
  })

  it('returns null when fetch throws', async () => {
    handlers.clear()
    const fetch = vi.fn().mockRejectedValue(new Error('offline'))
    registerGithubIpcHandlers({ fetch })
    await expect(invoke('github:get-stars')).resolves.toBeNull()
  })

  it('fetches once and caches for concurrent and repeat calls', async () => {
    handlers.clear()
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ stargazers_count: 42 }))
    registerGithubIpcHandlers({ fetch })

    const [a, b] = await Promise.all([invoke('github:get-stars'), invoke('github:get-stars')])
    const c = await invoke('github:get-stars')

    expect(a).toBe(42)
    expect(b).toBe(42)
    expect(c).toBe(42)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns null on a 200 response with a missing or non-number stargazers_count', async () => {
    handlers.clear()
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ stargazers_count: 'lots' }))
    registerGithubIpcHandlers({ fetch })
    await expect(invoke('github:get-stars')).resolves.toBeNull()
  })

  it('does not cache a failed result and retries on the next call', async () => {
    handlers.clear()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse({ stargazers_count: 7 }))
    registerGithubIpcHandlers({ fetch })

    await expect(invoke('github:get-stars')).resolves.toBeNull()
    await expect(invoke('github:get-stars')).resolves.toBe(7)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
