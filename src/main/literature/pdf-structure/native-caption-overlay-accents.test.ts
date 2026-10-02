import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

type NativeToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
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
const { recoverNativeCaptionOverlayAccentLines } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-caption-overlay-accents.mjs')
  ).href
)
const line = (text: string, x: number, y: number, width: number): SourceLine => ({
  text,
  x,
  y,
  width,
  height: 10,
  fontSize: 10
})
const native = (text: string, x: number, y: number, width: number): NativeToken => ({
  text,
  rect: [x * 1.5, y * 1.5, (x + width) * 1.5, (y + 10) * 1.5],
  height: 15,
  baseline: (y + 10) * 1.5,
  horizontal: true
})
function input(
  accent = 'ˆ',
  kind = 'Figure'
): {
  page: { pageNumber: number; width: number; height: number; lines: SourceLine[] }
  tokens: NativeToken[]
  caption: { page: number; lines: string[]; rect: number[] }
} {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line(`${kind} 4: Native reference frame.`, 50, 100, 200),
      line('Direction', 50, 114, 45),
      line(accent, 101, 111.4, 4),
      line('B remains literal.', 100, 114, 150),
      line('Terminal native description.', 50, 128, 200)
    ]
  }
  const tokens = [
    native(page.lines[0].text, 50, 100, 200),
    native('Direction', 50, 114, 45),
    native(accent, 101, 111.4, 4),
    native('B', 100, 114, 6),
    native('remains literal.', 110, 114, 140),
    native(page.lines[4].text, 50, 128, 200)
  ]
  return { page, tokens, caption: findCaptionCandidates([page])[0] }
}
it.each(['ˆ', '¯'])(
  'preserves the original %s above its unique native letter in a fused caption',
  (accent) => {
    const { page, tokens, caption } = input(accent)
    const before = structuredClone({ page, tokens, caption })
    expect(caption.lines[1]).toBe('Direction B remains literal.')
    const after = recoverNativeCaptionOverlayAccentLines(page, caption, tokens)
    expect(after).toEqual([
      'Figure 4: Native reference frame.',
      `Direction ${accent}B remains literal.`,
      'Terminal native description.'
    ])
    expect({ page, tokens, caption }).toEqual(before)
    expect(
      recoverNativeCaptionOverlayAccentLines(page, { ...caption, lines: after }, tokens)
    ).toBeUndefined()
  }
)

it('keeps an already retained accent and every separate same-letter occurrence unchanged', () => {
  const { page, tokens, caption } = input()
  page.lines[4].text = 'B remains a separate terminal letter.'
  tokens[5].text = page.lines[4].text
  caption.lines[2] = page.lines[4].text
  const after = recoverNativeCaptionOverlayAccentLines(page, caption, tokens)
  expect(after?.[1]).toBe('Direction ˆB remains literal.')
  expect(after?.[2]).toBe('B remains a separate terminal letter.')
  expect(
    recoverNativeCaptionOverlayAccentLines(page, { ...caption, lines: after }, tokens)
  ).toBeUndefined()
})

it('accepts a formal table caption and explicit native viewport scale without changing its frame', () => {
  const { page, tokens, caption } = input('¯', 'Table')
  const scaled = tokens.map((t) => ({
    ...t,
    rect: t.rect.map((n) => (n * 2) / 1.5),
    height: 20,
    baseline: (t.baseline * 2) / 1.5
  }))
  expect(recoverNativeCaptionOverlayAccentLines(page, caption, scaled, 2)?.[1]).toBe(
    'Direction ¯B remains literal.'
  )
  expect(caption.rect).toEqual([50, 100, 250, 138])
})

it.each([
  'foreign source',
  'foreign crossing source',
  'competing single owner',
  'missing native owner',
  'owner is not single',
  'nonfinite source',
  'nonfinite geometry',
  'zero width',
  'wrong rise',
  'different font',
  'different column',
  'different row',
  'ordinary baseline accent',
  'unmatched fused fragment',
  'ambiguous caption row',
  'body reference'
])('declines %s without changing literal caption text', (variant) => {
  const { page, tokens, caption } = input()
  if (variant === 'foreign source') tokens.push(native('Foreign', 115, 115, 20))
  if (variant === 'foreign crossing source') tokens.push(native('Foreign', 40, 114, 20))
  if (variant === 'competing single owner') {
    tokens.push({ ...tokens[3], rect: [...tokens[3].rect] })
    page.lines.push(line('B', 100, 114, 6))
  }
  if (variant === 'missing native owner') tokens.splice(3, 1)
  if (variant === 'owner is not single') {
    tokens[3].text = 'BB'
    page.lines[3].text = 'BB remains literal.'
    caption.lines[1] = 'Direction BB remains literal.'
  }
  if (variant === 'nonfinite source') tokens[2].baseline = NaN
  if (variant === 'nonfinite geometry') page.lines[2].height = Infinity
  if (variant === 'zero width') tokens[2].rect[2] = tokens[2].rect[0]
  if (variant === 'wrong rise') {
    tokens[2] = native('ˆ', 101, 106, 4)
    page.lines[2].y = 106
  }
  if (variant === 'different font') tokens[2].height = 12
  if (variant === 'different column') {
    tokens[2] = native('ˆ', 160, 111.4, 4)
    page.lines[2].x = 160
  }
  if (variant === 'different row') {
    tokens[2] = native('ˆ', 101, 125.4, 4)
    page.lines[2].y = 125.4
  }
  if (variant === 'ordinary baseline accent') {
    tokens[2] = native('ˆ', 101, 114, 4)
    page.lines[2].y = 114
  }
  if (variant === 'unmatched fused fragment') page.lines[3].x += 0.05
  if (variant === 'ambiguous caption row') caption.lines.push(caption.lines[1])
  if (variant === 'body reference')
    caption.lines[0] = 'Figure 4 summarizes the native reference frame.'
  const before = structuredClone(caption)
  expect(recoverNativeCaptionOverlayAccentLines(page, caption, tokens)).toBeUndefined()
  expect(caption).toEqual(before)
})
