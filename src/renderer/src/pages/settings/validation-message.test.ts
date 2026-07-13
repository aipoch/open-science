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
})
