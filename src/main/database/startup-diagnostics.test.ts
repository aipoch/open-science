import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { buildStartupDiagnostics } from './startup-diagnostics'

const env = {
  appVersion: '0.9.2',
  platform: 'darwin',
  arch: 'arm64',
  electron: '37.2.0',
  node: '22.17.0'
}

describe('buildStartupDiagnostics', () => {
  it('includes the environment header and the error name and message', () => {
    const error = new Error('database is locked')
    error.stack = 'Error: database is locked\n    at open (/app/dist/main.js:10:5)'

    const result = buildStartupDiagnostics(error, env)

    expect(result).toContain('App version: 0.9.2 (darwin-arm64)')
    expect(result).toContain('Electron: 37.2.0 · Node: 22.17.0')
    expect(result).toContain('Error: database is locked')
    expect(result).toContain('at open (/app/dist/main.js:10:5)')
  })

  it('redacts the home directory from messages and stack frames', () => {
    const home = homedir()
    const error = new Error(`cannot open ${home}/data/app.db`)
    error.stack = `Error: cannot open ${home}/data/app.db\n    at open (${home}/data/app.db:1:1)`

    const result = buildStartupDiagnostics(error, env)

    expect(result).toContain('~/data/app.db')
    expect(result).not.toContain(home)
  })

  it('walks the cause chain with Caused by separators', () => {
    const root = new Error('disk I/O error')
    root.stack = 'Error: disk I/O error\n    at write (/x.js:1:1)'
    const outer = new Error('migration failed', { cause: root })
    outer.stack = 'Error: migration failed\n    at migrate (/y.js:2:2)'

    const result = buildStartupDiagnostics(outer, env)

    expect(result).toContain('Error: migration failed')
    expect(result).toContain('Caused by: Error: disk I/O error')
    expect(result).toContain('at write (/x.js:1:1)')
  })

  it('returns undefined when nothing describable was thrown', () => {
    expect(buildStartupDiagnostics(undefined, env)).toBeUndefined()
    expect(buildStartupDiagnostics(42, env)).toBeUndefined()
  })

  it('keeps deep cause chains and stacks up to the raised budgets', () => {
    const frames = Array.from({ length: 20 }, (_, i) => `    at f${i} (/f.js:${i}:1)`)
    const root = new Error('root cause')
    root.stack = `Error: root cause\n${frames.join('\n')}`
    const outer = new Error('wrapper', { cause: root })
    outer.stack = 'Error: wrapper\n    at wrap (/w.js:1:1)'

    const result = buildStartupDiagnostics(outer, env)

    expect(result).toContain('Caused by: Error: root cause')
    expect(result).toContain('at f19 (/f.js:19:1)')
  })

  it('marks frames dropped by the frame budget instead of hiding them', () => {
    const frames = Array.from({ length: 40 }, (_, i) => `    at f${i} (/f.js:${i}:1)`)
    const error = new Error('deep stack')
    error.stack = `Error: deep stack\n${frames.join('\n')}`

    const result = buildStartupDiagnostics(error, env)

    expect(result).toContain('at f31 (/f.js:31:1)')
    expect(result).not.toContain('at f32 (/f.js:32:1)')
    expect(result).toContain('… 8 more frames')
  })

  it('marks causes dropped by the depth budget instead of hiding them', () => {
    let current = new Error('cause 8')
    current.stack = 'Error: cause 8\n    at f (/f.js:1:1)'
    for (let i = 7; i >= 0; i -= 1) {
      const next = new Error(`cause ${i}`, { cause: current })
      next.stack = `Error: cause ${i}\n    at f (/f.js:1:1)`
      current = next
    }

    const result = buildStartupDiagnostics(current, env)

    expect(result).toContain('Error: cause 7')
    expect(result).not.toContain('Error: cause 8')
    expect(result).toContain('… (further causes omitted)')
  })

  it('caps the diagnostics length with a truncation marker', () => {
    const error = new Error('x'.repeat(20000))
    error.stack = `Error: ${'x'.repeat(20000)}\n    at f (/f.js:1:1)`

    const result = buildStartupDiagnostics(error, env)

    expect(result?.length).toBeLessThanOrEqual(16000)
    expect(result).toContain('… (truncated)')
  })
})
