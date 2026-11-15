import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

const line = (
  text: string,
  y: number
): {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
} => ({
  text,
  x: 60,
  y,
  width: 400,
  height: 10,
  fontSize: 10
})

const figurePage = (
  reference: string,
  wrapped = false
): {
  pageNumber: number
  width: number
  height: number
  rotation: number
  renderRotation: number
  invalidGraphicsBounds: number
  lines: ReturnType<typeof line>[]
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
} => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  rotation: 0,
  renderRotation: 0,
  invalidGraphicsBounds: 0,
  lines: [
    line('Figure 2: Three independent measurements.', 400),
    ...(wrapped ? [line('The construction has independent states and transitions; see', 436)] : []),
    line(reference, 450),
    line('the independent construction described in the preceding paragraph.', 464)
  ],
  graphicsBounds: [{ kind: 'image', normalizedRect: [0.1, 0.1, 0.9, 0.48] }]
})

it.each([
  ['Figure 2. By Theorem 4.1, the construction is connected and maps onto', true],
  ['Figure 2 combines both independently measured parameters in the plane.', false]
] as const)(
  'does not associate a second figure from the body reference %s',
  (reference, wrapped) => {
    const page = figurePage(reference, wrapped)
    const captions = findCaptionCandidates([page])
    const figures = associateFigures(page, captions)
    expect(captions.map((c: { lines: string[] }) => c.lines[0])).toEqual([
      'Figure 2: Three independent measurements.'
    ])
    expect(figures).toHaveLength(1)
    expect(figures[0].caption.lines).toEqual(['Figure 2: Three independent measurements.'])
  }
)

it.each(['missing cue', 'different font', 'detached row', 'separator'])(
  'preserves a theorem-based title without a complete wrapped body cue: %s',
  (fault) => {
    const text = 'Figure 2. By Theorem 4.1, the construction is connected and maps onto'
    const page = figurePage(text, true)
    const cue = page.lines[1]
    if (fault === 'missing cue')
      cue.text = 'The construction has independent states and transitions.'
    if (fault === 'different font') cue.fontSize = 8
    if (fault === 'detached row') cue.y -= 20
    const rules = fault === 'separator' ? new Map([[1, [[50, 448, 470, 448]]]]) : new Map()
    const captions = findCaptionCandidates([page], rules)
    expect(captionKind(text)).toBe('figure')
    expect(captions.some((c: { lines: string[] }) => c.lines[0] === text)).toBe(true)
  }
)

it.each([
  'Figure 2: Combines both measured parameters.',
  'Figure 2. Combines both measured parameters.',
  'Figure 2 Combined parameter distributions.',
  'Figure 2 Combinations of measured parameters.',
  'Figure 2 combines in the illustrated domain.'
])('preserves delimited and descriptive figure titles: %s', (text) => {
  expect(captionKind(text)).toBe('figure')
})
