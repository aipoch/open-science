import { describe, expect, it } from 'vitest'

import { diagnosticText, projectDiagnosticError } from './detail'

describe('diagnostic text', () => {
  it('redacts credentials and personal paths while retaining stack file and line', () => {
    const text = diagnosticText(
      'Authorization: Bearer canary-secret\n    at run (/Users/alice/private/action.ts:42:9)'
    )
    expect(text).toContain('<absolute-path>/action.ts:42:9')
    expect(text).not.toContain('canary-secret')
    expect(text).not.toContain('/Users/alice')
  })

  it('preserves relative context below known roots and enforces a text limit', () => {
    expect(
      diagnosticText('at /var/app/config/sessions/a.json', { configRoot: '/var/app/config' })
    ).toBe('at <config-root>/sessions/a.json')
    expect(diagnosticText('x'.repeat(100), {}, 30).length).toBeLessThanOrEqual(30)
  })
})

describe('diagnostic error projection', () => {
  it('retains nested cause and diagnostic request data without arbitrary payload', () => {
    const projected = projectDiagnosticError({
      name: 'RequestError',
      message: 'request failed',
      code: -32603,
      data: { details: 'worker exited', payload: 'private content' },
      cause: { message: 'spawn failed', code: 'ENOENT', path: '/Users/alice/private' }
    })
    expect(projected).toMatchObject({
      name: 'RequestError',
      message: 'request failed',
      code: -32603,
      data: { details: 'worker exited' },
      cause: { message: 'spawn failed', code: 'ENOENT' }
    })
    expect(JSON.stringify(projected)).not.toContain('private content')
    expect(JSON.stringify(projected)).not.toContain('/Users/alice')
  })

  it('marks cycles and bounded depth instead of silently dropping the remainder', () => {
    const error: { message: string; cause?: unknown } = { message: 'outer' }
    error.cause = error
    expect(projectDiagnosticError(error)).toMatchObject({ cause: { message: '[circular]' } })
    const deep = {
      message: '0',
      cause: {
        message: '1',
        cause: {
          message: '2',
          cause: { message: '3', cause: { message: '4', cause: { message: '5' } } }
        }
      }
    }
    expect(JSON.stringify(projectDiagnosticError(deep))).toContain('[further causes omitted]')
  })

  it('keeps primitive provider data but ignores unknown fields and throwing getters', () => {
    expect(
      projectDiagnosticError({ error: 'request failed', data: 'provider unavailable' })
    ).toMatchObject({ message: 'request failed', data: { message: 'provider unavailable' } })
    expect(projectDiagnosticError({ payload: 'private content' })).toBeUndefined()
    const hostile = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('bad getter')
      }
    })
    expect(() => projectDiagnosticError(hostile)).not.toThrow()
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(projectDiagnosticError(revoked.proxy)).toEqual({ message: '[unreadable error]' })
  })

  it('bounds a large stack without copying the whole source', () => {
    const projected = projectDiagnosticError({
      message: 'failure',
      stack: `Error: failure\n${'x'.repeat(100_000)}`
    })
    const serialized = JSON.stringify(projected)
    expect(serialized.length).toBeLessThan(17_000)
    expect(serialized).toContain('[truncated]')
  })
})
