import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousPrintedCaptionReference } = await import(
  pathToFileURL(resolve('test/fixtures/printed-caption-reference.mjs')).href
)
const { findCaptionCandidates, captionKind } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

it('keeps one complete printed caption beside a same-number native body reference', async () => {
  const f = await anonymousPrintedCaptionReference()
  try {
    const captions = findCaptionCandidates([f.page])
    expect(captionKind('Figure 7 aggregates all observations by position')).toBe('figure')
    expect(captions).toHaveLength(1)
    expect(captions[0].lines).toEqual([
      'Figure 7: Regional scores in several trial groups',
      'Every measured condition is printed in this panel;',
      'and independent observations remain visible here.'
    ])
  } finally {
    await f.cleanup()
  }
})

it.each([
  'missing-caption',
  'other-number',
  'unfinished-caption',
  'unfinished-paragraph',
  'no-indent',
  'missing-prior-paragraph',
  'punctuated-title',
  'missing-graphic',
  'body-graphic',
  'following-graphic',
  'continued-caption',
  'duplicate-caption'
])('preserves the candidate without a complete independent reference proof: %s', async (fault) => {
  const f = await anonymousPrintedCaptionReference(fault)
  try {
    const captions = findCaptionCandidates([f.page])
    expect(
      captions.some((c: { lines: string[] }) =>
        /^Figure 7(?::)?\s+(?:aggregates|Continued)/u.test(c.lines[0])
      )
    ).toBe(true)
  } finally {
    await f.cleanup()
  }
})
