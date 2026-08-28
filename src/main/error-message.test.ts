import { describe, expect, it } from 'vitest'

import { toErrorMessage } from './error-message'

describe('toErrorMessage', () => {
  it('uses Error messages and stringifies other thrown values', () => {
    expect(toErrorMessage(new Error('failed'))).toBe('failed')
    expect(toErrorMessage('failed')).toBe('failed')
    expect(toErrorMessage({ code: 7 })).toBe('[object Object]')
  })
})
