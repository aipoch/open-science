import { describe, expect, it } from 'vitest'

import {
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS,
  getOfficePreviewTimeoutMs
} from './office-preview'

describe('getOfficePreviewTimeoutMs', () => {
  it.each([
    { size: 1024, attempt: 0, expected: 30_000 },
    { size: 1024, attempt: 1, expected: 60_000 },
    { size: 1024, attempt: 4, expected: 60_000 },
    { size: 20 * 1024 * 1024 + 1, attempt: 0, expected: 120_000 },
    { size: 20 * 1024 * 1024 + 1, attempt: 1, expected: 240_000 },
    { size: 20 * 1024 * 1024 + 1, attempt: 4, expected: 240_000 }
  ])('returns $expected ms for size=$size attempt=$attempt', ({ size, attempt, expected }) => {
    expect(getOfficePreviewTimeoutMs(size, attempt)).toBe(expected)
  })
})

describe('Office preview process limits', () => {
  it('uses the approved 1,536 MiB high-water mark and one-second poll interval', () => {
    expect(OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES).toBe(1_536 * 1024 * 1024)
    expect(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS).toBe(1_000)
  })
})
