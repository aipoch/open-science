import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
type SourceLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { nativeCaptionLiteralFragments } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-caption-script-order.mjs'))
    .href
)
const line = (
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
  height = fontSize
): SourceLine => ({ text, x, y, width, fontSize, height })
const page = {
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    line('Figure 9: Complete native description ending with T', 50, 250, 200),
    line('3', 250, 256, 4, 6),
    line('→ T', 260, 250, 18),
    line('4', 278, 256, 4, 6),
    line(' follows the original transition.', 290, 250, 190),
    line('The separate following sentence retains its own source wording.', 50, 264, 430),
    line('Native terminal description.', 50, 278, 170)
  ]
}
it('retains both independently owned literal scripts in an existing complete caption', () => {
  const c = findCaptionCandidates([page])[0]
  expect(c.lines[0]).toBe(
    'Figure 9: Complete native description ending with T 3 → T 4 follows the original transition.'
  )
  expect(c.lines.slice(1)).toEqual(page.lines.slice(-2).map((l) => l.text))
})

it('rejects nonfinite, conflicting source edges, foreign typography and crossed ownership', () => {
  const c = findCaptionCandidates([page])[0]
  for (const metric of [NaN, Infinity])
    expect(
      nativeCaptionLiteralFragments(
        { ...page, lines: page.lines.map((l, i) => (i === 1 ? { ...l, y: metric } : l)) },
        c
      )
    ).toBeUndefined()
  expect(
    nativeCaptionLiteralFragments({ ...page, lines: [...page.lines, line('R', 240, 250, 10)] }, c)
  ).toBeUndefined()
  expect(
    nativeCaptionLiteralFragments(
      { ...page, lines: [...page.lines, line('Crossing foreign ink', 45, 264, 25)] },
      c
    )
  ).toBeUndefined()
  expect(
    nativeCaptionLiteralFragments(
      { ...page, lines: [...page.lines, line('Foreign ink', 55, 271, 180, 14)] },
      c
    )
  ).toBeUndefined()
  expect(
    nativeCaptionLiteralFragments(
      { ...page, lines: page.lines.map((l, i) => (i === 1 ? { ...l, y: 270 } : l)) },
      c
    )
  ).toBeUndefined()
})

it('retains offset operator fragments through their unique native lower-index edges', () => {
  const source = {
    ...page,
    lines: [
      line('Figure 9: Native expression follows below.', 50, 250, 430),
      line('Literal expression =', 50, 264, 100),
      line('P', 160, 257, 10),
      line('j,k', 170, 270, 12, 6),
      line('A /', 190, 264, 30),
      line('P', 230, 257, 10),
      line('j,k', 240, 270, 12, 6),
      line('B remains literal.', 260, 264, 150),
      line('The last native sentence closes the description.', 50, 280, 280)
    ]
  }
  const caption = {
    page: 1,
    lines: source.lines.filter((l) => l.x === 50).map((l) => l.text),
    rect: [50, 250, 480, 290]
  }
  expect(nativeCaptionLiteralFragments(source, caption)?.lines[1]).toBe(
    'Literal expression = P j,k A / P j,k B remains literal.'
  )
})

const numericSource = (): typeof page => ({
  ...page,
  lines: [
    line('Figure 9: Complete native description ending with B', 50, 250, 200),
    line('u', 250, 256, 4, 6),
    line('Native field reaches 12', 50, 264, 190),
    line('3', 240, 263, 4, 6),
    line('Complete terminal explanation.', 50, 278, 200),
    line('4', 250, 278, 4)
  ]
})

it('preserves a proven numeric superscript while retaining literal letters and baseline digits', () => {
  const source = numericSource()
  const caption = findCaptionCandidates([source])[0]
  expect(caption.lines).toEqual([
    'Figure 9: Complete native description ending with B u',
    'Native field reaches 12³',
    'Complete terminal explanation. 4'
  ])
})

it.each(['baseline digit', 'small baseline digit', 'ambiguous owner', 'far gap'])(
  'does not infer a numeric superscript with %s',
  (variant) => {
    const source = numericSource()
    if (variant === 'baseline digit') source.lines[3] = line('3', 240, 264, 4)
    if (variant === 'small baseline digit') source.lines[3] = line('3', 240, 268, 4, 6)
    if (variant === 'ambiguous owner')
      source.lines.push(line('Competing native edge', 190, 264, 50))
    if (variant === 'far gap') source.lines[3].x += 3.5
    const caption = {
      page: 1,
      lines: source.lines.filter((l) => l.x === 50).map((l) => l.text),
      rect: [50, 250, 260, 290]
    }
    expect(nativeCaptionLiteralFragments(source, caption)).toBeUndefined()
    if (variant !== 'ambiguous owner')
      expect(findCaptionCandidates([source])[0].lines.join(' ')).not.toContain('12³')
  }
)
