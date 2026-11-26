import { expect, it } from 'vitest'
import { provesIsolatedLink } from './pdf-isolated-link-label'

it.each([
  'valid',
  'wrong rect',
  'changed label',
  'ambiguous draw',
  'wrong occurrence',
  'changed font',
  'unknown context'
] as const)('checks source paint and translated occurrence independently: %s', (mode) => {
  const item = (str: string): Parameters<typeof provesIsolatedLink>[0]['targetGlyph'] => ({
      str,
      dir: 'ltr',
      width: 80,
      height: 10,
      transform: [10, 0, 0, 10, 10, 30],
      fontName: 'F',
      hasEOL: false
    }),
    glyph = item('S2A'),
    source = 'Compare Figure S2A first. See Figure S2A again.',
    translation = '先比较图 S2A。再次见图 S2A。',
    draw = {
      label: mode === 'changed label' ? 'S2B' : 'S2A',
      x: 40,
      y: 30,
      width: 15,
      size: 10,
      font: mode === 'changed font' ? 'G' : 'F'
    }
  expect(
    provesIsolatedLink({
      source,
      translation,
      draws: mode === 'ambiguous draw' ? [draw, draw] : [draw],
      rect: [mode === 'wrong rect' ? 41 : 40, 27, 55, 38],
      sourceLine: item('See Figure S2A again.'),
      targetGlyph: glyph,
      targetRow:
        mode === 'unknown context'
          ? [glyph]
          : [item(mode === 'wrong occurrence' ? '先比较图' : '再次见图'), glyph, item('。')]
    })
  ).toBe(mode === 'valid')
})
