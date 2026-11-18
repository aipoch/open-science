import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { authorLabel, versionSummaryLabel } from './pptx-version-labels'

const t = ((key: string) => key) as TFunction

describe('pptx version labels', () => {
  it('names the author when the history records one', () => {
    expect(authorLabel('agent', t)).toBe('Agent')
    expect(authorLabel('user', t)).toBe('You')
    expect(authorLabel(undefined, t)).toBeUndefined()
  })

  it('turns an operation summary into readable change kinds', () => {
    expect(versionSummaryLabel('setText x2, addSlide, moveSlide, replaceImage', t)).toBe(
      'Text, Slides, Image'
    )
    expect(versionSummaryLabel('restore', t)).toBe('Restored an earlier version')
    expect(versionSummaryLabel('somethingNew', t)).toBeUndefined()
    expect(versionSummaryLabel(undefined, t)).toBeUndefined()
  })
})
