import { describe, expect, it } from 'vitest'

import { isMediaOverflowError } from './media-overflow'

describe('isMediaOverflowError', () => {
  it('matches the backend compaction failure', () => {
    expect(isMediaOverflowError('Compacting failed: media_unstrippable')).toBe(true)
    expect(isMediaOverflowError('media unstrippable')).toBe(true)
  })

  it('matches the provider request-size rejection', () => {
    expect(
      isMediaOverflowError(
        'Internal error: Request too large (max 32MB). Accumulated images and attachments pushed the request over the limit.'
      )
    ).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isMediaOverflowError('The requested resource was not found')).toBe(false)
    expect(isMediaOverflowError('Upload rejected: file is too large (limit 10MB)')).toBe(false)
    expect(isMediaOverflowError('rate limit exceeded')).toBe(false)
  })

  it('is safe on empty input', () => {
    expect(isMediaOverflowError(undefined)).toBe(false)
    expect(isMediaOverflowError(null)).toBe(false)
    expect(isMediaOverflowError('')).toBe(false)
  })
})
