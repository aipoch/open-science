import { describe, expect, it, vi } from 'vitest'

import { RendererFailureGate } from '../e2e/fixtures/renderer-failure-gate'

type Listener = (...args: never[]) => void

const observablePage = (): {
  page: {
    consoleMessages: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    pageErrors: ReturnType<typeof vi.fn>
  }
  emit: (event: string, value: unknown) => void
} => {
  const listeners = new Map<string, Listener>()
  return {
    page: {
      consoleMessages: vi.fn(async () => []),
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener)
      }),
      pageErrors: vi.fn(async () => [])
    },
    emit: (event: string, value: unknown) => listeners.get(event)?.(value as never)
  }
}

describe('RendererFailureGate', () => {
  it('fails on renderer console errors and page errors', async () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    await gate.observe(observed.page as never)

    observed.emit('console', {
      type: () => 'error',
      text: () => 'broken renderer',
      location: () => ({ url: '', lineNumber: 0, columnNumber: 0 })
    })
    observed.emit('pageerror', new Error('uncaught renderer failure'))

    expect(() => gate.assertNoFailures()).toThrow(/Renderer emitted errors/)
  })

  it('includes the failing resource location without allowing the error', async () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    await gate.observe(observed.page as never)
    observed.emit('console', {
      type: () => 'error',
      text: () => 'Failed to load resource: net::ERR_FAILED',
      location: () => ({
        url: 'open-science-preview://resource-id',
        lineNumber: 2,
        columnNumber: 4
      })
    })

    let failure: AggregateError | undefined
    try {
      gate.assertNoFailures()
    } catch (error) {
      failure = error as AggregateError
    }
    expect(failure?.errors[0].message).toBe(
      '[renderer console] Failed to load resource: net::ERR_FAILED (open-science-preview://resource-id:3:5)'
    )
  })

  it('ignores non-error console messages', async () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    await gate.observe(observed.page as never)

    observed.emit('console', { type: () => 'warning', text: () => 'diagnostic' })

    expect(() => gate.assertNoFailures()).not.toThrow()
  })

  it('allows one exact expected console error without hiding other failures', async () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    await gate.observe(observed.page as never)
    gate.allowConsoleError('expected failed resource')

    observed.emit('console', { type: () => 'error', text: () => 'expected failed resource' })
    expect(() => gate.assertNoFailures()).not.toThrow()

    observed.emit('console', {
      type: () => 'error',
      text: () => 'unexpected renderer failure',
      location: () => ({ url: '', lineNumber: 0, columnNumber: 0 })
    })
    expect(() => gate.assertNoFailures()).toThrow(/Renderer emitted errors/)
  })

  it('backfills renderer errors emitted before observation begins', async () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    observed.page.consoleMessages.mockResolvedValue([
      {
        type: () => 'error',
        text: () => 'early console failure',
        location: () => ({ url: '', lineNumber: 0, columnNumber: 0 })
      }
    ])
    observed.page.pageErrors.mockResolvedValue([new Error('early page failure')])

    await gate.observe(observed.page as never)

    expect(() => gate.assertNoFailures()).toThrow(/Renderer emitted errors/)
  })
})
