import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('recognizes a punctuated full figure keyword while preserving source text', () => {
  const text = 'Figure. 9. Native descriptor for independent panels.'
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text, x: 50, y: 250, width: 480, height: 10, fontSize: 10 }]
  }
  expect(captionKind(text)).toBe('figure')
  expect(findCaptionCandidates([page])).toEqual([
    { page: 1, lines: [text], rect: [50, 250, 530, 260] }
  ])
})

it('does not promote finite comparisons or inline punctuation into captions', () => {
  for (const text of [
    'Figure 9 compares the separate measurements in the following paragraph.',
    'Figure. 9 compares the separate measurements in the following paragraph.',
    'Figure 9 compared the separate measurements in the preceding paragraph.',
    'Figure 9 shows the values described in the paragraph.',
    'The preceding Figure. 9. has the same values.',
    'figure. this continuation describes the remaining panels.'
  ])
    expect(captionKind(text)).toBeUndefined()
})

it('retains descriptive comparison titles and existing numbered labels', () => {
  for (const text of [
    'Figure 9: Comparison of separate native measurements.',
    'Fig. 9. Native descriptor.',
    'Figure 9: Independent native panel description.',
    'Table A.2: Comparison of separate native measurements.',
    'Table 1 Compared sets',
    'Figure 9 Compared measurements'
  ])
    expect(captionKind(text)).toBe(text.startsWith('Table') ? 'table' : 'figure')
})
