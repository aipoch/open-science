import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanToolWaitObserver, requestPlanReviewProviderStop } from './plan-review-provider-stop'

afterEach(() => vi.useRealTimers())

describe('Plan review Provider stop', () => {
  it('requires terminal observation, not just cancellation notification acceptance', async () => {
    vi.useFakeTimers()
    const fail = vi.fn()
    const notify = vi.fn(async () => undefined)
    requestPlanReviewProviderStop({ notify, isCurrent: () => true, onUnconfirmed: fail })
    await Promise.resolve()
    expect(notify).toHaveBeenCalledOnce()
    expect(fail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fail).toHaveBeenCalledExactlyOnceWith('stop-unconfirmed')
  })

  it('does not tear down a stopped or superseded Provider after a late notification failure', async () => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    const notify = (): Promise<void> =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
    const fail = vi.fn()
    const dispose = requestPlanReviewProviderStop({
      notify,
      isCurrent: () => true,
      onUnconfirmed: fail
    })
    dispose()
    reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fail).not.toHaveBeenCalled()
    requestPlanReviewProviderStop({
      notify: async () => undefined,
      isCurrent: () => false,
      onUnconfirmed: fail
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fail).not.toHaveBeenCalled()
  })

  it('reports bounded failure facts without exposing upstream diagnostics', async () => {
    vi.useFakeTimers()
    const fail = vi.fn()
    requestPlanReviewProviderStop({
      notify: async () => {
        throw new Error('secret-token-' + 'x'.repeat(10000))
      },
      isCurrent: () => true,
      onUnconfirmed: fail
    })
    await Promise.resolve()
    expect(fail).toHaveBeenCalledExactlyOnceWith('notification-failed')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fail).toHaveBeenCalledOnce()
  })
})

describe('Plan tool failure observation', () => {
  it.each([
    'mcp__open-science-plan__generate_plan',
    'open_science_plan_generate_plan',
    'mcp.open-science-plan.generate_plan',
    'generate_plan'
  ])('correlates a terminal-only update for %s without matching unrelated failures', (title) => {
    const observer = new PlanToolWaitObserver()
    const event = (
      toolCallId: string,
      status: 'in_progress' | 'failed' | 'completed',
      name?: string
    ): import('@agentclientprotocol/sdk').SessionNotification => ({
      sessionId: 'provider-1',
      update: {
        sessionUpdate: 'tool_call_update' as const,
        toolCallId,
        status,
        ...(name ? { title: name } : {})
      }
    })
    expect(observer.failed(event('plan', 'in_progress', title))).toBe(false)
    expect(observer.failed(event('shell', 'failed', 'Shell'))).toBe(false)
    expect(observer.failed(event('plan', 'failed'))).toBe(true)
    expect(observer.failed(event('plan', 'failed'))).toBe(false)
  })
})
