import { describe, expect, it } from 'vitest'

import { formatUploadSizeLimit } from './uploads'

describe('formatUploadSizeLimit', () => {
  it('formats exact binary-unit boundaries for the user-facing upload limit', () => {
    expect(formatUploadSizeLimit(1023)).toBe('1023 B')
    expect(formatUploadSizeLimit(1024)).toBe('1 KB')
    expect(formatUploadSizeLimit(1024 * 1024)).toBe('1 MB')
    expect(formatUploadSizeLimit(1024 * 1024 * 1024)).toBe('1 GB')
  })

  it('retains one decimal place for fractional gigabyte limits', () => {
    expect(formatUploadSizeLimit(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})
