import { describe, expect, it } from 'vitest'

import { decodeBoundedBase64, SKILL_IMPORT_LIMITS } from './import-limits'

describe('decodeBoundedBase64', () => {
  it('decodes a bundle within the limit', () => {
    const bytes = Buffer.from('hello world')
    const decoded = decodeBoundedBase64(bytes.toString('base64'))
    expect(decoded.equals(bytes)).toBe(true)
  })

  it('rejects an oversized upload from its encoded length, before allocating the buffer', () => {
    // A base64 string whose decoded size would exceed the total cap. Built from length alone so the
    // test never actually allocates the decoded payload.
    const encodedLen = Math.ceil((SKILL_IMPORT_LIMITS.maxTotalBytes + 1) / 3) * 4
    const oversized = 'A'.repeat(encodedLen)
    expect(() => decodeBoundedBase64(oversized)).toThrow(/exceeds the .* limit/)
  })
})
