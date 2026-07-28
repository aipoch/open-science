import { describe, expect, it } from 'vitest'

import {
  createUploadVersionReference,
  formatUploadSizeLimit,
  parseUploadVersionReference
} from './uploads'

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

describe('upload Version references', () => {
  it('round-trips the Project and Session ownership scope', () => {
    const reference = createUploadVersionReference('version-1', {
      projectId: 'project/with spaces',
      sessionId: 'session-1'
    })

    expect(parseUploadVersionReference(reference)).toEqual({
      projectId: 'project/with spaces',
      sessionId: 'session-1',
      versionId: 'version-1'
    })
  })

  it('keeps pre-scope references readable for migration', () => {
    expect(parseUploadVersionReference('upload-version:version-legacy')).toEqual({
      versionId: 'version-legacy'
    })
  })
})
