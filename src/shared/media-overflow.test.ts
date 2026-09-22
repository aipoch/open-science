import { describe, expect, it } from 'vitest'

import { classifyContextOverflowError, isMediaOverflowError } from './media-overflow'

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

describe('classifyContextOverflowError', () => {
  it('recognizes exhausted compaction without retrying ordinary compaction', () => {
    expect(
      classifyContextOverflowError(
        'Session too large to compact - context exceeds model limit even after stripping media'
      )
    ).toBe('compaction-exhausted')
    expect(
      classifyContextOverflowError(
        'Conversation history too large to compact - exceeds model context limit'
      )
    ).toBe('compaction-exhausted')
    expect(classifyContextOverflowError({ error: { code: 'media_unstrippable' } })).toBe(
      'compaction-exhausted'
    )
  })
  it('prefers structured provider facts over wrapper text', () => {
    expect(
      classifyContextOverflowError({
        message: 'Internal error',
        data: { errorKind: 'compaction-exhausted' }
      })
    ).toBe('compaction-exhausted')
    expect(
      classifyContextOverflowError({
        message: 'Request too large',
        error: { code: 'context_length_exceeded' }
      })
    ).toBe('context-overflow')
    expect(classifyContextOverflowError({ status: 413 })).toBe('payload-overflow')
    expect(
      classifyContextOverflowError({ code: 'invalid_request', message: 'file is too large' })
    ).toBeUndefined()
  })
  it('prefers nested structured exhaustion over transport status and string wrappers', () => {
    expect(
      classifyContextOverflowError({
        status: 413,
        error: 'Request too large',
        data: { errorKind: 'compaction-exhausted' }
      })
    ).toBe('compaction-exhausted')
  })
  it('ignores arbitrary payloads and handles cyclic envelopes', () => {
    expect(
      classifyContextOverflowError({ request: { message: 'context_length_exceeded' } })
    ).toBeUndefined()
    const error: { cause?: unknown } = {}
    error.cause = error
    expect(classifyContextOverflowError(error)).toBeUndefined()
  })
})
