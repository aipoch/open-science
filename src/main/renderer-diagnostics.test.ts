import { describe, expect, it, vi } from 'vitest'

import type { RendererFailureReport } from '../shared/diagnostics'
import {
  createRendererFailureReporter,
  registerRendererDiagnosticsIpc
} from './renderer-diagnostics'

describe('createRendererFailureReporter', () => {
  it('records a validated renderer failure without retaining extra renderer data', () => {
    const error = vi.fn()
    const reporter = createRendererFailureReporter({
      log: { error, warn: vi.fn() },
      now: () => 100
    })

    expect(
      reporter.report('renderer-a', {
        source: 'window-error',
        surface: 'workspace',
        errorCategory: 'type',
        fingerprint: 'a1b2c3d4'
      })
    ).toBe('recorded')
    expect(error).toHaveBeenCalledWith('renderer javascript failure', {
      source: 'window-error',
      surface: 'workspace',
      errorCategory: 'type',
      fingerprint: 'a1b2c3d4'
    })
  })

  it('records an allowlisted handled-error context', () => {
    const error = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn: vi.fn() } })

    expect(
      reporter.report('renderer-a', {
        source: 'handled-error',
        surface: 'unknown',
        errorCategory: 'error',
        context: 'session-save',
        fingerprint: 'a1b2c3d4'
      })
    ).toBe('recorded')
    expect(error).toHaveBeenCalledWith('renderer javascript failure', {
      source: 'handled-error',
      surface: 'unknown',
      errorCategory: 'error',
      context: 'session-save',
      fingerprint: 'a1b2c3d4'
    })
  })

  it('rejects a free-form handled-error context', () => {
    const error = vi.fn()
    const warn = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn } })

    expect(
      reporter.report('renderer-a', {
        source: 'handled-error',
        surface: 'unknown',
        errorCategory: 'error',
        context: '/Users/private/project/session-save',
        fingerprint: 'a1b2c3d4'
      })
    ).toBe('rejected')
    expect(error).not.toHaveBeenCalled()
  })

  it('rejects renderer payloads that contain fields outside the diagnostics contract', () => {
    const error = vi.fn()
    const warn = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn } })

    expect(
      reporter.report('renderer-a', {
        source: 'window-error',
        surface: 'workspace',
        errorCategory: 'type',
        fingerprint: 'a1b2c3d4',
        message: 'private research path /Users/example/study.csv'
      })
    ).toBe('rejected')
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('renderer failure report rejected', {
      errorCategory: 'invalid-payload'
    })
  })

  it('limits invalid payloads before repeatedly inspecting hostile renderer values', () => {
    const warn = vi.fn()
    let inspections = 0
    const invalidPayload = new Proxy(
      {},
      {
        ownKeys: () => {
          inspections += 1
          return ['message']
        },
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true })
      }
    )
    const reporter = createRendererFailureReporter({
      log: { error: vi.fn(), warn },
      now: () => 100,
      maxReportsPerWindow: 1
    })

    expect(reporter.report('renderer-a', invalidPayload)).toBe('rejected')
    expect(reporter.report('renderer-a', invalidPayload)).toBe('suppressed')
    expect(reporter.report('renderer-a', invalidPayload)).toBe('suppressed')
    expect(inspections).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('suppresses repeated fingerprints and reports the bounded summary in the next window', () => {
    let now = 100
    const error = vi.fn()
    const warn = vi.fn()
    const reporter = createRendererFailureReporter({
      log: { error, warn },
      now: () => now,
      windowMs: 60_000
    })
    const report = {
      source: 'unhandled-rejection' as const,
      surface: 'settings' as const,
      errorCategory: 'error' as const,
      fingerprint: 'deadbeef'
    }

    expect(reporter.report('renderer-a', report)).toBe('recorded')
    expect(reporter.report('renderer-a', report)).toBe('suppressed')
    expect(error).toHaveBeenCalledTimes(1)

    now += 60_001
    expect(reporter.report('renderer-a', report)).toBe('recorded')
    expect(warn).toHaveBeenCalledWith('renderer failure reports suppressed', {
      suppressedCount: 1,
      windowMs: 60_000
    })
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('bounds distinct renderer failures per reporting window', () => {
    const error = vi.fn()
    const reporter = createRendererFailureReporter({
      log: { error, warn: vi.fn() },
      maxReportsPerWindow: 2
    })
    const report = (fingerprint: string): RendererFailureReport => ({
      source: 'window-error' as const,
      surface: 'home' as const,
      errorCategory: 'error' as const,
      fingerprint
    })

    expect(reporter.report('renderer-a', report('00000001'))).toBe('recorded')
    expect(reporter.report('renderer-a', report('00000002'))).toBe('recorded')
    expect(reporter.report('renderer-a', report('00000003'))).toBe('suppressed')
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('does not throw when the clock or logging sink fails', () => {
    const reporter = createRendererFailureReporter({
      log: {
        error: () => {
          throw new Error('sink unavailable')
        },
        warn: () => {
          throw new Error('sink unavailable')
        }
      },
      now: () => {
        throw new Error('clock unavailable')
      }
    })

    expect(
      reporter.report('renderer-a', {
        source: 'window-error',
        surface: 'home',
        errorCategory: 'error',
        fingerprint: '00000001'
      })
    ).toBe('recorded')
    expect(reporter.report('renderer-a', { message: 'private' })).toBe('rejected')
  })

  it('rejects a renderer payload whose properties cannot be inspected without throwing', () => {
    const warn = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error: vi.fn(), warn } })
    const hostilePayload = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('hostile payload')
        }
      }
    )

    expect(reporter.report('renderer-a', hostilePayload)).toBe('rejected')
    expect(warn).toHaveBeenCalledWith('renderer failure report rejected', {
      errorCategory: 'invalid-payload'
    })
  })

  it('records an immutable projection without reading renderer-controlled getters twice', () => {
    const error = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn: vi.fn() } })
    const accessCounts = new Map<string, number>()
    const payload = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries({
          source: 'window-error',
          surface: 'workspace',
          errorCategory: 'type',
          fingerprint: 'a1b2c3d4'
        }).map(([key, value]) => [
          key,
          {
            enumerable: true,
            get: () => {
              const count = (accessCounts.get(key) ?? 0) + 1
              accessCounts.set(key, count)
              if (count > 1) throw new Error('getter read twice')
              return value
            }
          }
        ])
      )
    )

    expect(reporter.report('renderer-a', payload)).toBe('recorded')
    expect(error).toHaveBeenCalledWith('renderer javascript failure', {
      source: 'window-error',
      surface: 'workspace',
      errorCategory: 'type',
      fingerprint: 'a1b2c3d4'
    })
    expect([...accessCounts.values()]).toEqual([1, 1, 1, 1])
  })

  it('adapts the one-way Electron channel and removes its listener on disposal', () => {
    let listener: ((event: { sender: { id: number } }, value: unknown) => void) | undefined
    const target = {
      on: vi.fn((_channel: string, next: typeof listener) => {
        listener = next
      }),
      removeListener: vi.fn()
    }
    const report = vi.fn()
    const dispose = registerRendererDiagnosticsIpc(target, { report })
    const value = {
      source: 'window-error',
      surface: 'home',
      errorCategory: 'error'
    }

    listener?.({ sender: { id: 42 } }, value)
    expect(report).toHaveBeenCalledWith('42', value)

    dispose()
    expect(target.removeListener).toHaveBeenCalledWith(
      'diagnostics:renderer-failure',
      expect.any(Function)
    )
  })

  it('does not throw from the Electron listener when sender access or reporting fails', () => {
    let listener: ((event: { sender: { id: number } }, value: unknown) => void) | undefined
    const target = {
      on: (_channel: string, next: typeof listener) => {
        listener = next
      },
      removeListener: vi.fn()
    }
    const report = vi.fn(() => {
      throw new Error('reporter unavailable')
    })
    registerRendererDiagnosticsIpc(target, { report })

    const inaccessibleSender = {} as { sender: { id: number } }
    Object.defineProperty(inaccessibleSender, 'sender', {
      get: () => {
        throw new Error('sender unavailable')
      }
    })

    expect(() => listener?.(inaccessibleSender, {})).not.toThrow()
    expect(report).not.toHaveBeenCalled()
    expect(() => listener?.({ sender: { id: 42 } }, {})).not.toThrow()
    expect(report).toHaveBeenCalledWith('42', {})
  })

  it('does not affect startup or teardown when Electron listener registration fails', () => {
    const target = {
      on: () => {
        throw new Error('registration unavailable')
      },
      removeListener: () => {
        throw new Error('removal unavailable')
      }
    }
    let dispose: (() => void) | undefined

    expect(() => {
      dispose = registerRendererDiagnosticsIpc(target, { report: vi.fn() })
    }).not.toThrow()
    expect(() => dispose?.()).not.toThrow()
  })
})
