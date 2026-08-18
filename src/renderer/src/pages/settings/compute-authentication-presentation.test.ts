import { describe, expect, it } from 'vitest'

import { isComputeAuthenticationErrorCode } from './compute-authentication-presentation'

describe('isComputeAuthenticationErrorCode', () => {
  it('rejects properties inherited from Object.prototype', () => {
    expect(isComputeAuthenticationErrorCode('toString')).toBe(false)
    expect(isComputeAuthenticationErrorCode('authentication_failed')).toBe(true)
  })
})
