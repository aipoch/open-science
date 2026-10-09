import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('preserves appendix letter and decimal ordinals as caption labels', () => {
  for (const ordinal of ['A.1', 'A.2', 'B.1', 'C.1', 'A-1', 'C-2', 'G-3']) {
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
    'Table A.2: These are the observed results.',
    'Fig. G-3 contains the result.',
    'Figure G-3 measures the result.',
    'Figure G-3 also measures the result.',
    'Figure G-3 contrasts the result.',
    'Figure G-3 (a) contrasts the result.',
    'Fig. A.1 further measures the result.',
    'Fig. G-3 is the result.',
    'Table G-1 reports the result.',
    'Table G-1). The result follows.',
    'Fig. G-3 and Fig. G-4 show the result.',
    'Table G-1 in the Appendix contains the result.',
    'Fig. G-3: These are the observed results.'
  ])
    expect(captionKind(text)).toBeUndefined()
})

it('keeps independently numbered hyphenated appendix captions on one source row', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'Fig. G-3: Native descriptor.', x: 50, y: 100, width: 220, height: 10, fontSize: 10 },
      {
        text: 'Fig. G-4: Separate descriptor.',
        x: 276,
        y: 100,
        width: 224,
        height: 10,
        fontSize: 10
      }
    ]
  }
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page]).map((caption: { lines: string[] }) => caption.lines)
  ).toEqual(page.lines.map((line) => [line.text]))
  expect(page).toEqual(before)
})

it.each(['A.1', 'G-1'])(
  'keeps a wrapped bare appendix reference in its source paragraph (%s)',
  (ordinal) => {
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines: [
        {
          text: 'The independent records and conditions are listed in',
          x: 50,
          y: 100,
          width: 480,
          height: 12,
          fontSize: 12
        },
        { text: `Table ${ordinal}.`, x: 50, y: 115, width: 70, height: 12, fontSize: 12 }
      ]
    }
    expect(findCaptionCandidates([page])).toEqual([])
    page.lines.shift()
    expect(findCaptionCandidates([page])[0].lines).toEqual([`Table ${ordinal}.`])
  }
)

it.each([
  'Figure G-3 the measured values are interpreted in the next paragraph.',
  'Fig. G-3 for the same comparison is used in the following paragraph.',
  'Figure G-3 (a) contains the measured result.',
  'Fig. G-3 (a) and (b) also measures the independent result.'
])('applies existing prose guards before admitting an appendix ordinal: %s', (text) => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text, x: 50, y: 100, width: 480, height: 10, fontSize: 10 }]
  }
  expect(captionKind(text)).toBeUndefined()
  expect(findCaptionCandidates([page])).toEqual([])
})

it.each([
  'Figure G-3: The measured values for independent records.',
  'Fig. G-3 (a). Native descriptor for independent records.'
])('retains punctuated appendix noun titles with their literal source text: %s', (text) => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text, x: 50, y: 100, width: 480, height: 10, fontSize: 10 }]
  }
  expect(captionKind(text)).toBe('figure')
  expect(findCaptionCandidates([page])[0].lines).toEqual([text])
})
