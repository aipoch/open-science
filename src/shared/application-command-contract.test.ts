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

// Error parameters must survive transport without becoming arbitrary diagnostic payloads.
it('round-trips a CSL macro name through the public error envelope', () => {
  const error = new ApplicationCommandError('csl-undefined-macro', 'Undefined macro', {
    macro: 'author-原名'
  })
  const envelope = toApplicationCommandErrorEnvelope(error)
  expect(envelope).toEqual({
    code: 'csl-undefined-macro',
    message: 'Undefined macro',
    parameters: { macro: 'author-原名' }
  })
  expect(() =>
    unwrapApplicationCommandOutcome(JSON.parse(JSON.stringify({ ok: false, error: envelope })))
  ).toThrow(expect.objectContaining({ code: error.code, parameters: error.parameters }))
})

it.each([undefined, null, {}, { macro: 42 }, { macro: 'name', privatePath: '/private' }])(
  'rejects malformed CSL parameters: %j',
  (parameters) => {
    expect(() =>
      unwrapApplicationCommandOutcome({
        ok: false,
        error: { code: 'csl-undefined-macro', message: 'Undefined macro', parameters }
      })
    ).toThrow(expect.objectContaining({ code: 'invalid-command-result' }))
  }
)

it('does not forward parameters on unrelated command failures', () => {
  expect(
    toApplicationCommandErrorEnvelope(
      new ApplicationCommandError('command-failed', 'Failed', { macro: 'private' })
    )
  ).toEqual({ code: 'command-failed', message: 'Failed' })
  expect(() =>
    unwrapApplicationCommandOutcome({
      ok: false,
      error: { code: 'command-failed', message: 'Failed', parameters: { macro: 'private' } }
    })
  ).toThrow(expect.objectContaining({ code: 'invalid-command-result' }))
})
