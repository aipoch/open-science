import { describe, expect, it } from 'vitest'

import { describeValidation } from './validation-message'

describe('describeValidation', () => {
  it('uses the controlled Local Claude auth message when the subprocess probe supplies one', () => {
    expect(
      describeValidation({
        ok: false,
        category: 'auth',
        message: 'Local Claude could not authenticate. Run `claude` in a terminal and log in.'
      })
    ).toBe('Local Claude could not authenticate. Run `claude` in a terminal and log in.')
  })

  it('keeps the generic API-key guidance for HTTP auth failures', () => {
    expect(describeValidation({ ok: false, category: 'auth', status: 401 })).toBe(
      'Authentication failed. Check the API key. (HTTP 401)'
    )
  })

  it('surfaces the gateway message for an unknown failure instead of the generic copy', () => {
    expect(
      describeValidation({
        ok: false,
        category: 'unknown',
        status: 402,
        message: 'Insufficient Balance'
      })
    ).toBe('Insufficient Balance (HTTP 402)')
  })

  it('falls back to the generic unknown copy when no message is present', () => {
    expect(describeValidation({ ok: false, category: 'unknown', status: 402 })).toBe(
      'Validation failed for an unknown reason. (HTTP 402)'
    )
  })

  it('surfaces the specific route-mismatch reason for an incompatible pairing', () => {
    expect(
      describeValidation({
        ok: false,
        category: 'incompatible',
        message:
          'Not compatible with Claude Code: it needs /v1/messages, but this provider speaks /v1/chat/completions. Change the API format or switch the agent framework.'
      })
    ).toBe(
      'Not compatible with Claude Code: it needs /v1/messages, but this provider speaks /v1/chat/completions. Change the API format or switch the agent framework.'
    )
  })

  it('falls back to the generic incompatible copy when no reason is supplied', () => {
    expect(describeValidation({ ok: false, category: 'incompatible' })).toBe(
      "This provider isn't compatible with the active agent framework."
    )
  })
})
