import { describe, expect, it } from 'vitest'
import type { PdfLayoutPage, PdfLayoutTextItem } from '../../src/reader/layout.js'
import type { PdfTranslationSource } from '../../src/reader/source.js'
import { unreliablyDecodedDisplayOwners } from '../../src/reader/native-unreliably-decoded-displays.js'

type Unit = PdfTranslationSource['units'][number]
type Fixture = { page: PdfLayoutPage; units: Unit[]; unreliable: Set<string> }

function packet(): Fixture {
  const native = (str: string, x: number, y = 600, size = 10): PdfLayoutTextItem => ({
    str,
    width: str.length * 4,
    height: size,
    dir: 'ltr',
    transform: [size, 0, 0, size, x, y],
    fontName: 'embedded',
    fontVertical: false
  })
  const items = [
    native('The example uses the following relation:', 300, 619),
    native('𝑥', 345),
    native('𝑖', 355, 598, 7),
    native('\x1c', 370),
    native('𝑦', 384),
    native('𝑖', 394, 598, 7),
    native('=', 406),
    native('𝑧', 418),
    native('𝑘', 428, 598, 7),
    native('(1)', 552),
    native('(2)', 552, 576),
    native('Body text resumes below.', 305, 553)
  ]
  const unit = (id: string, indices: number[], keep?: 'formula'): Unit => ({
    id,
    source: indices.map((index) => items[index].str).join(' '),
    ...(keep ? { sourceOnly: true, preserve: keep } : {}),
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0.5, y: 0.24, width: 0.3, height: 0.02 },
        items: indices.map((index) => ({ index, text: items[index].str }))
      }
    ]
  })
  return {
    page: { page: 1, width: 600, height: 800, rotation: 0, items },
    units: [
      unit('intro', [0]),
      unit('left', [1, 2]),
      unit('unmapped', [3], 'formula'),
      unit('right', [4, 5, 6, 7, 8]),
      unit('number', [9], 'formula'),
      unit('following-number', [10], 'formula'),
      unit('next-paragraph', [11])
    ],
    unreliable: new Set(['1:3'])
  }
}

function run({ page, units, unreliable }: Fixture): Set<string> {
  return unreliablyDecodedDisplayOwners([page], units, unreliable)
}

describe('numbered displays with an unmapped operator', () => {
  it('protects both complete native owners without changing geometry or text', () => {
    const fixture = packet()
    const copy = structuredClone(fixture)
    expect(run(fixture)).toEqual(new Set(['left', 'right']))
    expect(fixture).toEqual(copy)
  })

  for (const [label, change] of [
    ['unconfirmed Unicode failure', (f: Fixture) => f.unreliable.clear()],
    ['mismatched next number', (f: Fixture) => (f.page.items[10].str = '(4)')],
    ['shifted next number', (f: Fixture) => (f.page.items[10].transform[4] += 10)],
    ['rotated operator', (f: Fixture) => (f.page.items[3].transform[1] = 1)],
    [
      'unaccounted text within the display',
      (f: Fixture) => {
        f.page.items[11].transform[4] = 400
        f.page.items[11].transform[5] = 600
      }
    ],
    ['overlapping owners', (f: Fixture) => f.units.push({ ...f.units[1], id: 'shadow' })],
    [
      'part of an owner outside the display',
      (f: Fixture) => {
        f.units[1] = {
          ...f.units[1],
          fragments: [...f.units[1].fragments, ...f.units[0].fragments]
        }
        f.units.shift()
      }
    ],
    [
      'ordinary text in the native interval',
      (f: Fixture) => {
        f.page.items[4].str = 'note'
        const right = f.units[3]
        const first = right.fragments[0]
        f.units[3] = {
          ...right,
          fragments: [{ ...first, items: [{ index: 4, text: 'note' }, ...first.items.slice(1)] }]
        }
      }
    ]
  ] as const)
    it(`keeps eligibility with ${label}`, () => {
      const fixture = packet()
      change(fixture)
      expect(run(fixture).size).toBe(0)
    })
})

it.each([false, true])(
  'retains paired derivative displays only with attached inset labels (%s)',
  (detached) => {
    const items: PdfLayoutTextItem[] = []
    const units: Unit[] = []
    const unreliable = new Set<string>()
    for (const [number, y] of [
      [1, 600],
      [2, 570]
    ]) {
      const display: [string, number, number?, number?][] = [
        ['z', 46],
        ['q', 50, -2.5, 5],
        ['=', 60],
        ['sgn', 69],
        ['\x12', 86, 14],
        ['q', 91],
        ['∂q', 101, 7],
        ['∂s', 101, -7],
        ['\x13', 115, 14],
        ['in', 121, 12, 7],
        ['AB', 121, -10, 7],
        ['≡', 137],
        ['sgn', 146],
        ['\x12', 163, 14],
        ['q', 168],
        ['∂q', 178, 7],
        ['∂s', 178, -7],
        ['\x13', 192, 14],
        ['out', 198, 12, 7],
        ['AB', detached && number === 2 ? 201 : 198, -10, 7],
        [',', 214],
        [`(${number})`, 232]
      ]
      for (const [str, x, dy = 0, size = 10] of display) {
        const index = items.length
        const sourceOnly = !/^(?:sgn|in|out|AB)$/u.test(str)
        items.push({
          str,
          width: str.length * 4,
          height: size,
          dir: 'ltr',
          transform: [size, 0, 0, size, x, y + dy],
          fontName: 'embedded',
          fontVertical: false
        })
        if (str === '\x12' || str === '\x13') unreliable.add(`1:${index}`)
        units.push({
          id: String(index),
          source: str,
          ...(sourceOnly ? { sourceOnly, preserve: 'formula' } : {}),
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.08, y: 0.25, width: 0.4, height: 0.04 },
              items: [{ index, text: str }]
            }
          ]
        })
      }
    }
    const page = { page: 1, width: 600, height: 800, rotation: 0, items }
    expect(run({ page, units, unreliable })).toEqual(
      new Set(detached ? [] : units.filter((unit) => !unit.sourceOnly).map((unit) => unit.id))
    )
  }
)
