import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('preserves appendix letter and decimal ordinals as caption labels', () => {
  for (const ordinal of ['A.1', 'A.2', 'B.1', 'C.1']) {
    expect(captionKind(`Fig. ${ordinal}. Native descriptor.`)).toBe('figure')
    expect(captionKind(`Table ${ordinal}: Native descriptor.`)).toBe('table')
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'Table A.2. Native descriptor.', x: 50, y: 100, width: 230, height: 10, fontSize: 10 }
    ]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual(['Table A.2. Native descriptor.'])
})

it('keeps appendix-number prose and parenthesized references out of caption ownership', () => {
  for (const text of [
    'Fig. A.1 shows the result.',
    'Figure B.1 illustrated the result.',
    'Table A.2 reports the result.',
    'Table A.2). The result follows.',
    'Table C.1 in the Appendix contains the result.',
    'Fig. A.1 and Fig. A.2 show the result.',
    'Table A.2: These are the observed results.'
  ])
    expect(captionKind(text)).toBeUndefined()
})
