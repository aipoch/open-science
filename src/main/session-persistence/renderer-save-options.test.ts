import { describe, expect, it } from 'vitest'

import { sanitizeRendererSaveSessionOptions } from './renderer-save-options'

describe('sanitizeRendererSaveSessionOptions', () => {
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
