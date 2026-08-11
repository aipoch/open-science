import { describe, expect, it } from 'vitest'

import { installRendererFailureDiagnostics, projectRendererFailure } from './renderer-diagnostics'

describe('projectRendererFailure', () => {
  it('projects a renderer error to fixed vocabulary without retaining its message or stack', () => {
    const failure = new TypeError('private study /Users/example/patient.csv')
    failure.stack = 'TypeError: private study\n at /Users/example/private.ts:10:2'

    const report = projectRendererFailure('window-error', failure, 'workspace')

    expect(report).toEqual({
      source: 'window-error',
      surface: 'workspace',
      errorCategory: 'type',
      fingerprint: expect.stringMatching(/^[a-f0-9]{8}$/)
    })
    expect(JSON.stringify(report)).not.toContain('private study')
    expect(JSON.stringify(report)).not.toContain('/Users/example')
  })

  it('projects an allowlisted handled-error context without the raw error', () => {
    const report = projectRendererFailure(
      'handled-error',
      new Error('private /Users/example/session.json'),
      'unknown',
      'session-save'
    )

    expect(report).toMatchObject({
      source: 'handled-error',
      surface: 'unknown',
      context: 'session-save',
      errorCategory: 'error'
    })
    expect(JSON.stringify(report)).not.toContain('/Users/example')
  })

  it('reports top-level errors through the supplied diagnostics sink and can be uninstalled', () => {
    const listeners = new Map<string, EventListener>()
    const target = {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      }
    }
    const reports: unknown[] = []
    const uninstall = installRendererFailureDiagnostics({
      target,
      getSurface: () => 'settings',
      report: (value) => reports.push(value)
    })

    const event = Object.assign(new Event('error'), { error: new ReferenceError('secret') })
    listeners.get('error')?.(event)
    expect(reports).toEqual([
      expect.objectContaining({
        source: 'window-error',
        surface: 'settings',
        errorCategory: 'reference'
      })
    ])

    uninstall()
    expect(listeners.size).toBe(0)
  })

  it('does not throw from a renderer listener when event access, surface detection, or reporting fails', () => {
    const listeners = new Map<string, EventListener>()
    const target = {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: () => undefined
    }
    const reports: unknown[] = []
    installRendererFailureDiagnostics({
      target,
      getSurface: () => {
        throw new Error('surface unavailable')
      },
      report: (value) => {
        reports.push(value)
        throw new Error('bridge unavailable')
      }
    })
    const inaccessibleEvent = new Event('error')
    Object.defineProperty(inaccessibleEvent, 'error', {
      get: () => {
        throw new Error('event unavailable')
      }
    })

    expect(() => listeners.get('error')?.(inaccessibleEvent)).not.toThrow()
    expect(reports).toEqual([
      expect.objectContaining({
        source: 'window-error',
        surface: 'unknown',
        errorCategory: 'unknown'
      })
    ])
  })

  it('remains safe when event listener registration or removal fails', () => {
    let registrationCount = 0
    let uninstall: (() => void) | undefined
    const target = {
      addEventListener: () => {
        registrationCount += 1
        if (registrationCount === 2) throw new Error('registration unavailable')
      },
      removeEventListener: () => {
        throw new Error('removal unavailable')
      }
    }

    expect(() => {
      uninstall = installRendererFailureDiagnostics({
        target,
        getSurface: () => 'home',
        report: () => undefined
      })
    }).not.toThrow()
    expect(registrationCount).toBe(2)
    expect(() => uninstall?.()).not.toThrow()
  })

  it('does not recursively report an error raised by the diagnostics bridge', () => {
    const listeners = new Map<string, EventListener>()
    const target = {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: () => undefined
    }
    let reportCount = 0
    installRendererFailureDiagnostics({
      target,
      getSurface: () => 'home',
      report: () => {
        reportCount += 1
        listeners.get('error')?.(new Event('error'))
        throw new Error('bridge unavailable')
      }
    })

    expect(() => listeners.get('error')?.(new Event('error'))).not.toThrow()
    expect(reportCount).toBe(1)
  })
})
