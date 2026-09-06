// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderPairingPage } from './pairing-page'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const executePage = (
  fetch: ReturnType<typeof vi.fn>,
  expiresIn = 600_000
): { events: EventTarget; replace: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> } => {
  const { html } = renderPairingPage({
    code: '123456',
    browser: 'Safari',
    platform: 'iOS/iPadOS',
    expiresAt: Date.now() + expiresIn
  })
  document.documentElement.innerHTML = html
  const script = document.querySelector('script')!.textContent!
  const location = { replace: vi.fn(), reload: vi.fn() }
  const events = new EventTarget()
  const timers = { setTimeout, clearTimeout, setInterval, clearInterval }
  runInNewContext(script, {
    document,
    fetch,
    Date,
    AbortController,
    ...timers,
    window: { ...timers, location, addEventListener: events.addEventListener.bind(events) }
  })
  return { events, replace: location.replace, reload: location.reload }
}

const hangingFetch = (stage: 'fetch' | 'json', honorAbort = true): ReturnType<typeof vi.fn> =>
  vi.fn((_url, options) => {
    const hanging = new Promise((_resolve, reject) => {
      if (honorAbort) {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      }
    })
    return stage === 'fetch' ? hanging : Promise.resolve({ json: () => hanging })
  })

describe('Pairing page recovery', () => {
  it.each(['fetch', 'json'] as const)(
    'expires the page even when %s never completes',
    async (stage) => {
      const fetch = hangingFetch(stage, false)
      executePage(fetch)
      await vi.advanceTimersByTimeAsync(600_001)
      expect(document.querySelector('#status')!.textContent).toContain('expired')
    }
  )

  it.each(['fetch', 'json'] as const)(
    'aborts a stalled %s and retries before pairing expires',
    async (stage) => {
      const fetch = hangingFetch(stage)
      executePage(fetch)
      await vi.advanceTimersByTimeAsync(30_000)
      expect.soft(fetch.mock.calls[0][1].signal?.aborted).toBe(true)
      expect(fetch.mock.calls.length).toBeGreaterThan(1)
    }
  )

  it('expires normally while pending responses continue arriving', async () => {
    executePage(vi.fn().mockResolvedValue({ json: async () => ({ status: 'pending' }) }))
    await vi.advanceTimersByTimeAsync(600_001)
    expect(document.querySelector('#status')!.textContent).toContain('expired')
  })

  it.each(['expired', 'rejected'])(
    'offers a restart after the server reports %s',
    async (status) => {
      executePage(vi.fn().mockResolvedValue({ json: async () => ({ status }) }))
      await vi.advanceTimersByTimeAsync(0)
      expect(document.querySelector('#status')!.textContent).toContain(status)
      const restart = [
        ...document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')
      ].find((element) => /try again|start again|restart/i.test(element.textContent ?? ''))
      expect(restart, 'Terminal pairing states need an actionable restart').toBeDefined()
      expect(restart!.hidden).toBe(false)
      expect(restart!.getAttribute('href')).toBe('/')
      await vi.advanceTimersByTimeAsync(600_001)
      expect(document.querySelector('#status')!.textContent).toContain(status)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not let a late approval replace the expired page', async () => {
    let approve!: (result: unknown) => void
    const fetch = vi.fn().mockResolvedValue({
      json: () =>
        new Promise((resolve) => {
          approve = resolve
        })
    })
    const { replace } = executePage(fetch, 1000)
    await vi.advanceTimersByTimeAsync(1001)
    approve({ status: 'approved' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(document.querySelector('#status')!.textContent).toContain('expired')
    expect(replace).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens the workspace after approval without a later expiry update', async () => {
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ status: 'approved' }) })
    const { replace } = executePage(fetch)
    await vi.advanceTimersByTimeAsync(600_001)
    expect(replace).toHaveBeenCalledExactlyOnceWith('/')
    expect(document.querySelector('#status')!.textContent).toContain('Approved')
    expect(document.querySelector<HTMLAnchorElement>('#restart')!.hidden).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the request and all timers when leaving the page', async () => {
    const fetch = hangingFetch('fetch')
    const { events } = executePage(fetch)
    events.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(600_001)
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes a pairing page restored from the back-forward cache', () => {
    const { events, reload } = executePage(hangingFetch('fetch', false))
    events.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    expect(reload).not.toHaveBeenCalled()
    events.dispatchEvent(new Event('pagehide'))
    events.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    expect(reload).toHaveBeenCalledOnce()
  })
})
