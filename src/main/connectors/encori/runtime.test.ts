import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../types'
import { encoriCall, readBytes, receive } from './runtime'
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../skills/net-fetch', () => ({ netFetchStandard: fetchMock }))
const ctx = { credentials: {} } as ToolContext
const url = 'https://rnasysu.com/encori/api/RNARNA/'
beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})
const read = async (): Promise<Uint8Array> => receive(url, ctx, {}, readBytes)

describe('ENCORI network lifecycle', () => {
  it('retries a connection error at most twice and returns the original error shape', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    const result = encoriCall(ctx, async () => {
      await read()
      return {}
    })
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await result).toMatchObject({
      ok: false,
      database: 'ENCORI',
      source_url: url,
      error: { code: 'network_error', retryable: true, status_code: null }
    })
  })
  it('honors Retry-After and retains HTTP status after exhausting retries', async () => {
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 503, headers: { 'retry-after': '1' } })
    )
    const result = encoriCall(ctx, async () => {
      await read()
      return {}
    })
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'upstream_http_error', status_code: 503, retryable: true }
    })
  })
  it('does not retry permanent upstream errors', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    const result = encoriCall(ctx, async () => {
      await read()
      return {}
    })
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await result).toMatchObject({ ok: false, error: { status_code: 404, retryable: false } })
  })
  it('times out stalled headers and cancels a late response body', async () => {
    let resolveReply!: (reply: Response) => void
    const cancel = vi.fn()
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReply = resolve
        })
    )
    const result = encoriCall(ctx, async () => {
      await receive(url, ctx, {}, readBytes, { idleTimeoutMs: 10, retries: 0 })
      return {}
    })
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'network_error', retryable: true }
    })
    resolveReply(new Response(new ReadableStream({ cancel })))
    await vi.runAllTimersAsync()
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('cancels a stalled body before retrying, and then reads the successful reply', async () => {
    const cancel = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockResolvedValueOnce(new Response('official data'))
    const result = receive(url, ctx, {}, readBytes, { idleTimeoutMs: 10 })
    await vi.runAllTimersAsync()
    expect(new TextDecoder().decode(await result)).toBe('official data')
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('preserves caller cancellation and never retries it', async () => {
    const controller = new AbortController()
    const scoped = { ...ctx, signal: controller.signal }
    const cancel = vi.fn()
    fetchMock.mockImplementation(async () => {
      queueMicrotask(() => controller.abort(new Error('user cancelled')))
      return new Response(new ReadableStream({ cancel }))
    })
    const result = encoriCall(scoped, async () => {
      await receive(url, scoped, {}, readBytes)
      return {}
    })
    const rejected = expect(result).rejects.toThrow('user cancelled')
    await vi.runAllTimersAsync()
    await rejected
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
