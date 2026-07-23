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

  it('matches the provider HTTP 413 forms (message and error-type slug)', () => {
    expect(isMediaOverflowError('request_too_large')).toBe(true)
    expect(isMediaOverflowError('Request entity too large')).toBe(true)
  })

  it('matches third-party endpoint context-overflow wording', () => {
    expect(
      isMediaOverflowError(
        "This model's maximum context length is 65536 tokens. However, your request has 89012 input tokens."
      )
    ).toBe(true)
    expect(isMediaOverflowError('context_length_exceeded')).toBe(true)
    expect(isMediaOverflowError('prompt is too long: 213450 tokens > 200000 maximum')).toBe(true)
  })

  it('does not match unrelated failures', () => {
    expect(isMediaOverflowError('The requested resource was not found')).toBe(false)
    expect(isMediaOverflowError('Upload rejected: file is too large (limit 10MB)')).toBe(false)
    expect(isMediaOverflowError('rate limit exceeded')).toBe(false)
    // A generic invalid_request (e.g. a malformed field) is NOT an overflow: tagging it recoverable
    // would reset the agent context for an error a retry cannot fix.
    expect(isMediaOverflowError('invalid_request: messages.0.content is required')).toBe(false)
  })

  it('is safe on empty input', () => {
    expect(isMediaOverflowError(undefined)).toBe(false)
    expect(isMediaOverflowError(null)).toBe(false)
    expect(isMediaOverflowError('')).toBe(false)
  })
})
