import { describe, expect, it, vi } from 'vitest'

import { RendererFailureGate } from '../e2e/fixtures/renderer-failure-gate'

type Listener = (...args: never[]) => void

const observablePage = (): {
  page: { on: ReturnType<typeof vi.fn> }
  emit: (event: string, value: unknown) => void
} => {
  const listeners = new Map<string, Listener>()
  return {
    page: {
      on: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener)
      })
    },
    emit: (event: string, value: unknown) => listeners.get(event)?.(value as never)
  }
}

describe('RendererFailureGate', () => {
  it('fails on renderer console errors and page errors', () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    gate.observe(observed.page as never)

    observed.emit('console', { type: () => 'error', text: () => 'broken renderer' })
    observed.emit('pageerror', new Error('uncaught renderer failure'))

    expect(() => gate.assertNoFailures()).toThrow(/Renderer emitted errors/)
  })

  it('ignores non-error console messages', () => {
    const gate = new RendererFailureGate()
    const observed = observablePage()
    gate.observe(observed.page as never)

    observed.emit('console', { type: () => 'warning', text: () => 'diagnostic' })

    expect(() => gate.assertNoFailures()).not.toThrow()
  })
})
