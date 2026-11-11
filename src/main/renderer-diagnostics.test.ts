import { describe, expect, it, vi } from 'vitest'

import { projectRendererFailure } from '../renderer/src/renderer-diagnostics'

import type { RendererFailureReport } from '../shared/diagnostics'
import {
  createRendererFailureReporter,
  registerRendererDiagnosticsIpc
} from './renderer-diagnostics'

describe('createRendererFailureReporter', () => {
  it('records repeated save recovery cycles independently from failure-report deduplication', () => {
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const reporter = createRendererFailureReporter({ log, maxReportsPerWindow: 1 })
    const report = (event: 'retained' | 'resolved', attempt: number): unknown => ({
      source: 'handled-error',
      surface: 'workspace',
      context: 'session-save',
      errorCategory: 'unknown',
      sessionWrite: {
        target: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        code: 'desktop-runtime-disconnected',
        epoch: 4,
        phase: 'result-unknown',
        recovery: { event, attempt, runtimePhase: 'connected' }
      }
    })

    for (const attempt of [1, 2]) {
      expect(reporter.report('renderer', report('retained', attempt))).toBe('recorded')
      expect(reporter.report('renderer', report('resolved', attempt))).toBe('recorded')
    }
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenCalledWith(
      'session storage recovery',
      expect.objectContaining({
        sessionWrite: expect.objectContaining({
          recovery: expect.objectContaining({ event: 'resolved', attempt: 2 })
        })
      })
    )
    expect(log.error).not.toHaveBeenCalled()
    expect(
      reporter.report('renderer', {
        source: 'window-error',
        surface: 'workspace',
        errorCategory: 'type'
      })
    ).toBe('recorded')
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('keeps distinct Session targets and classified outcomes in diagnostics', () => {
    const error = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn: vi.fn() } })
    const report = (
      sessionId: string,
      code: 'session-size-limit' | 'desktop-runtime-disconnected'
    ): RendererFailureReport => ({
      source: 'handled-error',
      surface: 'workspace',
      context: 'session-save',
      errorCategory: 'unknown',
      fingerprint: '811c9dc5',
      sessionWrite: {
        target: 'session',
        sessionId,
        projectId: 'project-1',
        code,
        epoch: 4,
        phase: code === 'desktop-runtime-disconnected' ? 'result-unknown' : 'rejected'
      }
    })
    expect(reporter.report('renderer', report('session-1', 'session-size-limit'))).toBe('recorded')
    expect(reporter.report('renderer', report('session-2', 'session-size-limit'))).toBe('recorded')
    expect(reporter.report('renderer', report('session-1', 'desktop-runtime-disconnected'))).toBe(
      'recorded'
    )
    expect(reporter.report('renderer', report('session-1', 'session-size-limit'))).toBe(
      'suppressed'
    )
    expect(error).toHaveBeenCalledTimes(3)
  })

  it.each([
    { sessionId: 'D:\\private\\session.json' },
    { projectId: 'private research title' },
    { code: 'secret message' },
    { epoch: -1 },
    { phase: 'raw stack' },
    { content: 'patient record' },
    { cause: new Error('secret') },
    { recovery: { event: 'retained', title: 'private title' } },
    { recovery: { event: 'retained', reason: 'private failure detail' } },
    { recovery: { event: 'retained', elapsedMs: -1 } },
    { recovery: { event: 'retained', attempt: Number.POSITIVE_INFINITY } },
    { recovery: { event: 'retained', runtimePhase: 'private runtime detail' } }
  ])('rejects unreviewed Session write metadata: %j', (extra) => {
    const error = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn: vi.fn() } })
    expect(
      reporter.report('renderer', {
        source: 'handled-error',
        surface: 'workspace',
        context: 'session-save',
        errorCategory: 'unknown',
        sessionWrite: {
          target: 'session',
          sessionId: 'session-1',
          projectId: 'project-1',
          code: 'unknown',
          epoch: 1,
          phase: 'rejected',
          ...extra
        }
      })
    ).toBe('rejected')
    expect(error).not.toHaveBeenCalled()
  })

  it('bounds recovery records separately and reports suppression after the window expires', () => {
    let now = 0
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const reporter = createRendererFailureReporter({
      log,
      now: () => now,
      maxRecoveryReportsPerWindow: 2
    })
    const report = {
      source: 'handled-error',
      surface: 'workspace',
      context: 'session-save',
      errorCategory: 'unknown',
      sessionWrite: {
        target: 'session',
        sessionId: 'session-1',
        code: 'desktop-runtime-disconnected',
        epoch: 4,
        phase: 'result-unknown',
        recovery: { event: 'retry-started', attempt: 1 }
      }
    }
    expect(reporter.report('renderer', report)).toBe('recorded')
    expect(reporter.report('renderer', report)).toBe('recorded')
    expect(reporter.report('renderer', report)).toBe('suppressed')
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith('session storage recovery rate limit reached', {
      windowMs: 60_000,
      maxReportsPerWindow: 2
    })
    now = 60_001
    expect(reporter.report('renderer', report)).toBe('recorded')
    expect(log.warn).toHaveBeenCalledWith('session storage recovery reports suppressed', {
      suppressedCount: 1,
      windowMs: 60_000
    })
  })

  it.each(['workspace', 'marketplace'])(
    'records a validated %s failure without retaining extra renderer data',
    (surface) => {
      const error = vi.fn()
      const reporter = createRendererFailureReporter({
        log: { error, warn: vi.fn() },
        now: () => 100
      })

      expect(
        reporter.report('renderer-a', {
          source: 'window-error',
          surface,
          errorCategory: 'type',
          fingerprint: 'a1b2c3d4'
        })
      ).toBe('recorded')
      expect(error).toHaveBeenCalledWith('renderer javascript failure', {
        source: 'window-error',
        surface,
        errorCategory: 'type',
        fingerprint: 'a1b2c3d4'
      })
    }
  )

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

describe('renderer source-location deduplication', () => {
  it.each([
    [
      'development',
      'http://localhost:5173/src/pages/first.tsx:10:5',
      'http://localhost:5173/src/pages/second.tsx:90:7'
    ],
    [
      'packaged',
      'file:///app/out/renderer/assets/index.js:13:510',
      'file:///app/out/renderer/assets/index.js:13:902'
    ],
    [
      'Windows',
      'file:///C:/Program%20Files/OpenScience/out/renderer/assets/index.js:13:510',
      'file:///C:/Program%20Files/OpenScience/out/renderer/assets/index.js:14:510'
    ],
    [
      'async',
      'async render (http://localhost:5173/src/page.tsx:10:5)',
      'async render (http://localhost:5173/src/page.tsx:11:5)'
    ],
    ['native', 'renderStudy (native)', 'updateWorkspace (native)'],
    ['webpack', 'webpack:///src/first.tsx:10:2', 'webpack:///src/second.tsx:10:2']
  ])('records distinct %s locations and suppresses a repeat', (_mode, first, second) => {
    const report = (location: string): RendererFailureReport => {
      const error = new TypeError('private error message')
      error.stack = `TypeError: private error message\n    at ${location}`
      return projectRendererFailure('window-error', error, 'workspace')
    }
    const error = vi.fn()
    const reporter = createRendererFailureReporter({ log: { error, warn: vi.fn() }, now: () => 0 })
    expect(reporter.report('renderer', report(first))).toBe('recorded')
    expect(reporter.report('renderer', report(second))).toBe('recorded')
    expect(reporter.report('renderer', report(first))).toBe('suppressed')
    expect(error).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/private|localhost|Program|page|index.js/)
  })
})
