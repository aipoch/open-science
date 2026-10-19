import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { captionKind, startsDetachedTableCaption, startsDetachedTextColumn } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

it.each([
  'Figure 8 directly overlays the simulated and measured responses.',
  'Figure 2 overlays the estimated response on the observations.',
  'Fig. 3 directly compares the two conditions.'
])('keeps the unpunctuated finite figure subject in prose: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

function detached(scale = 1): ReturnType<typeof JSON.parse> {
  const item = (
    str: string,
    x: number,
    baseline: number,
    height: number,
    font: string
  ): ReturnType<typeof JSON.parse> => ({
    str,
    width: 245 * scale,
    height: height * scale,
    transform: [height * scale, 0, 0, height * scale, x * scale, baseline * scale],
    fontName: font,
    hasEOL: false
  })
  return {
    pending: [
      item('A sentence continuing in the separate body column-', 54, 120.3, 10, 'body'),
      { ...item(' ', 299, 120.3, 0, 'body'), width: 18 * scale }
    ],
    caption: {
      ...item('FIG. 3. Comparison of three numerical models.', 317, 118.8, 9, 'caption'),
      hasEOL: true
    }
  }
}
const splits = (f: ReturnType<typeof detached>): boolean =>
  startsDetachedTableCaption(f.pending, f.caption) || startsDetachedTextColumn(f.pending, f.caption)

it.each([1, 1.5])(
  'keeps a complete native caption separate across a narrow physical gutter at scale %f',
  (scale) => {
    expect(splits(detached(scale))).toBe(true)
  }
)

it.each([
  'inline-reference',
  'same-font',
  'missing-font',
  'same-size',
  'small-gutter',
  'rotated',
  'invalid-width',
  'short-fragment',
  'prior-caption',
  'missing-eol',
  'raised-baseline'
])('does not split source text with %s evidence', (kind) => {
  const f = detached()
  if (kind === 'inline-reference') f.caption.str = 'Figure 3 shows the response in this condition.'
  if (kind === 'same-font') f.caption.fontName = 'body'
  if (kind === 'missing-font') delete f.caption.fontName
  if (kind === 'same-size') f.caption.height = 10
  if (kind === 'small-gutter') f.caption.transform[4] = 304
  if (kind === 'rotated') f.caption.transform[1] = 1
  if (kind === 'invalid-width') f.caption.width = -1
  if (kind === 'short-fragment') f.pending[0].str = 'see'
  if (kind === 'prior-caption') f.pending[0].str = 'Figure 2: A separate long description.'
  if (kind === 'missing-eol') f.caption.hasEOL = false
  if (kind === 'raised-baseline') f.caption.transform[5] = 121
  expect(splits(f)).toBe(false)
})

it('preserves a detached complete caption when the native stream visits the right column first', () => {
  const f = detached()
  f.pending[0].transform[4] = 317
  f.caption.transform[4] = 54
  expect(splits(f)).toBe(true)
})

it.each([
  'Figure 8: Directly overlays the simulated and measured responses.',
  'Figure 2. Overlays of simulated and measured responses.',
  'Figure 3 Overlay of simulated and measured responses.',
  'Figure 5 Overlays of simulated and measured responses.',
  'Figure 4 Directly measured responses under different conditions.'
])('retains a punctuated caption or noun title: %s', (text) => {
  expect(captionKind(text)).toBe('figure')
})
