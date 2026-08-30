import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { buildStartupDiagnostics } from './startup-diagnostics'

describe('buildStartupDiagnostics', () => {
  it('includes the error name, message, and stack frames', () => {
    const error = new Error('database is locked')
    error.stack = 'Error: database is locked\n    at open (/app/dist/main.js:10:5)'

    const result = buildStartupDiagnostics(error)

    expect(result).toContain('Error: database is locked')
    expect(result).toContain('at open (<absolute-path>/main.js:10:5)')
  })

  it('redacts the home directory from messages and stack frames', () => {
    const home = homedir()
    const error = new Error(`cannot open ${home}/data/app.db`)
    error.stack = `Error: cannot open ${home}/data/app.db\n    at open (${home}/data/app.db:1:1)`

    const result = buildStartupDiagnostics(error)

    expect(result).toContain('~/data/app.db')
    expect(result).not.toContain(home)
  })

  it('redacts configured roots and remaining cross-platform absolute paths', () => {
    const error = new Error(
      [
        'config=/Volumes/Config Space/.open-science/open-science.db',
        'data=/mnt/research/OpenScience/notebook/run.json',
        'other=/srv/customer/private.db',
        'file=file:///Volumes/External/private.db',
        String.raw`windows=D:\Clients\Acme\private.db`,
        String.raw`network=\\fileserver\research-share\private.db`
      ].join(' ')
    )

    const result = buildStartupDiagnostics(error, {
      home: '/Users/alice',
      configRoot: '/Volumes/Config Space/.open-science/',
      dataRoot: '/mnt/research/OpenScience/'
    })

    expect(result).toContain('<config-root>/open-science.db')
    expect(result).toContain('<data-root>/notebook/run.json')
    expect(result).toContain('other=<absolute-path>')
    expect(result).not.toContain('<absolute-path><absolute-path>')
    expect(result).not.toContain('/Volumes/Config Space')
    expect(result).not.toContain('/mnt/research')
    expect(result).not.toContain('/srv/customer')
    expect(result).not.toContain('/Volumes/External')
    expect(result).not.toContain('D:\\Clients')
    expect(result).not.toContain('fileserver')
    expect(result).not.toContain('research-share')
  })

  it('does not apply a configured-root marker to a sibling path prefix', () => {
    const error = new Error('cannot open /data/project-old/secret.db')

    const result = buildStartupDiagnostics(error, {
      home: '/Users/alice',
      dataRoot: '/data/project/'
    })

    expect(result).toContain('<absolute-path>')
    expect(result).not.toContain('<data-root>-old')
    expect(result).not.toContain('project-old')
    expect(result).not.toContain('secret.db')
  })

  it.each([
    ['POSIX', 'endpoint:https://example.test/public path:/srv/private.db', '/srv/private.db'],
    [
      'drive-letter',
      String.raw`endpoint:https://example.test/public path:D:\Clients\private.db`,
      String.raw`D:\Clients\private.db`
    ]
  ])(
    'redacts a colon-prefixed %s path without treating a URL as a path',
    (_kind, message, path) => {
      const result = buildStartupDiagnostics(new Error(message), { home: '/Users/alice' })

      expect(result).toContain('endpoint:https://example.test/public')
      expect(result).toContain('path:<absolute-path>')
      expect(result).not.toContain(path)
    }
  )

  it.each([
    ['POSIX', '[/srv/customer/secret.db]', '/srv/customer/secret.db'],
    ['drive-letter', String.raw`[D:\Clients\Acme\secret.db]`, String.raw`D:\Clients\Acme\secret.db`]
  ])('redacts a bracket-delimited %s path', (_kind, message, path) => {
    const result = buildStartupDiagnostics(new Error(`cannot open ${message}`), {
      home: '/Users/alice'
    })

    expect(result).toContain('cannot open [<absolute-path>]')
    expect(result).not.toContain(path)
  })

  it.each([
    '/srv/customer/Private Study/patient.db',
    String.raw`D:\Clients\Private Study\patient.db`,
    String.raw`\\fileserver\Private Study\patient.db`,
    'file://fileserver/Private%20Study/patient.db'
  ])('fully redacts an unquoted path containing spaces: %s', (path) => {
    const error = new Error(`cannot open ${path} because the file is locked`)

    const result = buildStartupDiagnostics(error, { home: '/Users/alice' })

    expect(result).toContain('<absolute-path>')
    expect(result).not.toContain('Private Study')
    expect(result).not.toContain('Private%20Study')
    expect(result).not.toContain('patient.db')
    expect(result).not.toContain('fileserver')
  })

  it('keeps a useful file suffix for a delimited stack path containing spaces', () => {
    const error = new Error('failed')
    error.stack = 'Error: failed\n    at open (/srv/customer/Private Study/patient.db:10:5)'

    const result = buildStartupDiagnostics(error, { home: '/Users/alice' })

    expect(result).toContain('at open (<absolute-path>/patient.db:10:5)')
    expect(result).not.toContain('Private Study')
  })

  it('reuses the diagnostic credential policy before diagnostics cross IPC', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFydHVwIn0.signaturevalue123'
    const signedUrlSecret = 'signed-url-opaque-7319'
    const error = new Error(
      `request failed: Bearer bearer-opaque-7319; apiKey=key-opaque-7319; jwt=${jwt}; ` +
        'https://alice:password-opaque-7319@example.test/v1?token=query-opaque-7319&ok=1; ' +
        `https://bucket.example.test/private?X-Amz-Signature=${signedUrlSecret}&version=7`
    )

    const result = buildStartupDiagnostics(error, { home: '/Users/alice' })

    for (const secret of [
      'bearer-opaque-7319',
      'key-opaque-7319',
      jwt,
      'alice',
      'password-opaque-7319',
      'query-opaque-7319',
      signedUrlSecret
    ]) {
      expect(result).not.toContain(secret)
    }
    expect(result).toContain('[redacted]')
    expect(result).toContain('version=7')
  })

  it('walks the cause chain with Caused by separators', () => {
    const root = new Error('disk I/O error')
    root.stack = 'Error: disk I/O error\n    at write (/x.js:1:1)'
    const outer = new Error('migration failed', { cause: root })
    outer.stack = 'Error: migration failed\n    at migrate (/y.js:2:2)'

    const result = buildStartupDiagnostics(outer)

    expect(result).toContain('Error: migration failed')
    expect(result).toContain('Caused by: Error: disk I/O error')
    expect(result).toContain('at write (<absolute-path>/x.js:1:1)')
  })

  it('returns undefined when nothing describable was thrown', () => {
    expect(buildStartupDiagnostics(undefined)).toBeUndefined()
    expect(buildStartupDiagnostics(42)).toBeUndefined()
  })

  it('marks a non-error cause instead of dropping it silently', () => {
    const outer = new Error('migration failed', { cause: 42 })
    outer.stack = 'Error: migration failed\n    at migrate (/y.js:2:2)'

    const result = buildStartupDiagnostics(outer)

    expect(result).toContain('… (a non-error cause was omitted)')
  })

  it('keeps deep cause chains and stacks up to the raised budgets', () => {
    const frames = Array.from({ length: 20 }, (_, i) => `    at f${i} (/f.js:${i}:1)`)
    const root = new Error('root cause')
    root.stack = `Error: root cause\n${frames.join('\n')}`
    const outer = new Error('wrapper', { cause: root })
    outer.stack = 'Error: wrapper\n    at wrap (/w.js:1:1)'

    const result = buildStartupDiagnostics(outer)

    expect(result).toContain('Caused by: Error: root cause')
    expect(result).toContain('at f19 (<absolute-path>/f.js:19:1)')
  })

  it('marks frames dropped by the frame budget instead of hiding them', () => {
    const frames = Array.from({ length: 40 }, (_, i) => `    at f${i} (/f.js:${i}:1)`)
    const error = new Error('deep stack')
    error.stack = `Error: deep stack\n${frames.join('\n')}`

    const result = buildStartupDiagnostics(error)

    expect(result).toContain('at f31 (<absolute-path>/f.js:31:1)')
    expect(result).not.toContain('at f32 (<absolute-path>/f.js:32:1)')
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

    const result = buildStartupDiagnostics(current)

    expect(result).toContain('Error: cause 7')
    expect(result).not.toContain('Error: cause 8')
    expect(result).toContain('… (further causes omitted)')
  })

  it('caps the diagnostics length with a truncation marker', () => {
    const error = new Error('x'.repeat(20000))
    error.stack = `Error: ${'x'.repeat(20000)}\n    at f (/f.js:1:1)`

    const result = buildStartupDiagnostics(error)

    expect(result?.length).toBeLessThanOrEqual(16000)
    expect(result).toContain('… (truncated)')
  })

  it('never splits a surrogate pair when capping the length', () => {
    const error = new Error('🚀'.repeat(12000))
    error.stack = `Error: ${'🚀'.repeat(12000)}\n    at f (/f.js:1:1)`

    const result = buildStartupDiagnostics(error)

    expect(result).toContain('… (truncated)')
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})
