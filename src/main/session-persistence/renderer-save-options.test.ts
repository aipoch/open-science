import { describe, expect, it } from 'vitest'

import { sanitizeRendererSaveSessionOptions } from './renderer-save-options'

describe('sanitizeRendererSaveSessionOptions', () => {
  it.each([0, 2, Number.MAX_SAFE_INTEGER])(
    'preserves an explicit recovery revision of %s',
    (expectedRevision) => {
      expect(sanitizeRendererSaveSessionOptions({ expectedRevision })).toEqual({ expectedRevision })
    }
  )

  it.each([-1, 0.5, NaN, Infinity, '2', null, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid recovery revision of %s',
    (expectedRevision) => {
      expect(() => sanitizeRendererSaveSessionOptions({ expectedRevision })).toThrow(
        'Invalid expected Session revision.'
      )
    }
  )
  it('keeps supported renderer fields and drops unknown fields', () => {
    expect(
      sanitizeRendererSaveSessionOptions({
        conflictRebaseFields: ['title', 'unknown', 'title', 'pinned']
      })
    ).toEqual({ conflictRebaseFields: ['title', 'pinned'] })
  })

  it.each(['enabledComputeHosts', 'selectedComputeHosts'])(
    'rejects the command-owned %s field',
    (field) => {
      expect(() => sanitizeRendererSaveSessionOptions({ conflictRebaseFields: [field] })).toThrow(
        'Compute Host settings cannot be replayed through Session saves.'
      )
    }
  )
})
