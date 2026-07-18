import { describe, expect, it } from 'vitest'

import { decodeBoundedBase64, SKILL_IMPORT_LIMITS } from './import-limits'

describe('decodeBoundedBase64', () => {
  it('decodes a bundle within the limit', () => {
    const bytes = Buffer.from('hello world')
    const decoded = decodeBoundedBase64(bytes.toString('base64'))
    expect(decoded.equals(bytes)).toBe(true)
  })

  it('accepts an upload exactly at the documented total-byte limit', () => {
    // A payload whose decoded size equals maxTotalBytes exactly must be allowed (padding-aware sizing).
    const bytes = Buffer.alloc(SKILL_IMPORT_LIMITS.maxTotalBytes)
    expect(() => decodeBoundedBase64(bytes.toString('base64'))).not.toThrow()
    // One byte over the limit is rejected.
    const over = Buffer.alloc(SKILL_IMPORT_LIMITS.maxTotalBytes + 1)
    expect(() => decodeBoundedBase64(over.toString('base64'))).toThrow(/exceeds the .* limit/)
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

  it('does not let an unpadded payload under-count past the limit', () => {
    // 11 bytes with the base64 padding stripped is 15 chars; a floor(len/4)*3 estimate would call it
    // 9 bytes and wrongly pass a 10-byte cap. The exact size (11) must be rejected.
    const eleven = Buffer.alloc(11, 0x61)
    const unpadded = eleven.toString('base64').replace(/=+$/, '')
    expect(unpadded.length % 4).not.toBe(0) // genuinely unpadded
    expect(() => decodeBoundedBase64(unpadded, 10)).toThrow(/exceeds the .* limit/)
    // The same payload is fine under a cap that actually fits it.
    expect(decodeBoundedBase64(unpadded, 11).length).toBe(11)
  })

  it('rejects a structurally invalid base64 length', () => {
    // A trailing group of a single base64 char encodes no bytes and is malformed.
    expect(() => decodeBoundedBase64('YWJjZ')).toThrow(/not valid base64/)
  })
})
