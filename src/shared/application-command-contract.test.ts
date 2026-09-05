import { describe, expect, it } from 'vitest'

import {
  ApplicationCommandError,
  toApplicationCommandErrorEnvelope,
  unwrapApplicationCommandOutcome
} from './application-command-contract'

describe('application command contract', () => {
  it('preserves only public application command error codes', () => {
    expect(
      toApplicationCommandErrorEnvelope(
        new ApplicationCommandError('invalid-command-arguments', 'Invalid project request.')
      )
    ).toEqual({
      code: 'invalid-command-arguments',
      message: 'Invalid project request.'
    })
    expect(
      toApplicationCommandErrorEnvelope(
        Object.assign(new Error('Database unavailable.'), { code: 'SQLITE_BUSY' })
      )
    ).toEqual({ code: 'command-failed', message: 'Database unavailable.' })
  })

  it('unwraps results and reconstructs typed failures', () => {
    const result = { id: 'project-1' }

    expect(unwrapApplicationCommandOutcome({ ok: true, result })).toBe(result)
    expect(() =>
      unwrapApplicationCommandOutcome({
        ok: false,
        error: { code: 'command-unavailable', message: 'Projects are unavailable.' }
      })
    ).toThrow(
      expect.objectContaining({
        name: 'ApplicationCommandError',
        code: 'command-unavailable',
        message: 'Projects are unavailable.'
      })
    )
    expect(() =>
      unwrapApplicationCommandOutcome({
        ok: false,
        error: { code: 'session-size-limit', message: 'Session is too large.' }
      })
    ).toThrow(expect.objectContaining({ code: 'session-size-limit' }))
  })

  it('fails closed on malformed outcomes', () => {
    expect(() => unwrapApplicationCommandOutcome({ ok: true })).toThrow(
      expect.objectContaining({ code: 'invalid-command-result' })
    )
    expect(() =>
      unwrapApplicationCommandOutcome({
        ok: false,
        error: { code: 'SQLITE_BUSY', message: 'private detail' }
      })
    ).toThrow(expect.objectContaining({ code: 'invalid-command-result' }))
  })
})
