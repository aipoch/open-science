import { describe, expect, it } from 'vitest'

import { decodeBoundedBase64 } from './import-limits'

describe('decodeBoundedBase64', () => {
  it('decodes a bundle within the limit', () => {
    const bytes = Buffer.from('hello world')
    const decoded = decodeBoundedBase64(bytes.toString('base64'))
    expect(decoded.equals(bytes)).toBe(true)
  })

  it('accounts for padding exactly at the boundary', () => {
    // "abc" -> "YWJj" (no padding) decodes to exactly 3 bytes: allowed at limit 3, rejected at 2.
    const three = Buffer.from('abc').toString('base64')
    expect(decodeBoundedBase64(three, 3).toString()).toBe('abc')
    expect(() => decodeBoundedBase64(three, 2)).toThrow(/exceeds the .* limit/)

    // "abcd" -> "YWJjZA==" (two pad chars) decodes to 4 bytes; the padding must not be counted as data.
    const four = Buffer.from('abcd').toString('base64')
    expect(decodeBoundedBase64(four, 4).toString()).toBe('abcd')
    expect(() => decodeBoundedBase64(four, 3)).toThrow(/exceeds the .* limit/)
  })

  it('ignores whitespace in line-wrapped base64 when sizing', () => {
    const bytes = Buffer.from('abc')
    const wrapped = `${bytes.toString('base64').slice(0, 2)}\n${bytes.toString('base64').slice(2)}`
    expect(decodeBoundedBase64(wrapped, 3).equals(bytes)).toBe(true)
  })
})
