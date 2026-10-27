import { expect, it, vi } from 'vitest'
import { captureNativeLinkOrigins, nativeLinkOriginSpan } from '../resources/native-link-origin.mjs'
import { mapReflowLinks } from '../resources/reflow-links.mjs'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Retain inferred mock signatures for refusal controls.
function fixture(source = 'Alpha 1. Beta 1.') {
  const chars = [...source].map((text, index) => ({
      text,
      angle: 0,
      rect: { x: 0.11 + index * 0.012, y: 0.12, width: 0.009, height: 0.02 }
    })),
    last = chars.findLastIndex((c) => c.text === '1'),
    rect = { x: chars[last].rect.x - 0.001, y: 0.119, width: 0.023, height: 0.022 },
    unit = {
      kind: 'text',
      source,
      translation: source,
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          items: [{ index: 0, text: source }]
        }
      ]
    },
    input = { units: [unit] },
    link = {
      pageNumber: 1,
      index: 0,
      labels: ['1.'],
      regions: [rect],
      destination: { pageNumber: 2, mode: 1, params: [0, 100, null] }
    },
    geometry = [{ left: 0, top: 100, width: 100, height: 100 }],
    memory = new Float64Array(16),
    native = {
      alloc: vi.fn(() => 8),
      free: vi.fn(),
      m: { HEAPF64: memory },
      p: {
        FPDF_LoadPage: vi.fn(() => 1),
        FPDF_ClosePage: vi.fn(),
        FPDFPage_GetRotation: vi.fn(() => 0),
        FPDFText_LoadPage: vi.fn(() => 2),
        FPDFText_ClosePage: vi.fn(),
        FPDFText_CountChars: vi.fn(() => chars.length),
        FPDFText_GetUnicode: vi.fn((_page: number, index: number) =>
          chars[index].text.codePointAt(0)
        ),
        FPDFText_GetCharAngle: vi.fn((_page: number, index: number) => chars[index].angle),
        FPDFText_GetCharBox: vi.fn((_page: number, index: number, at: number) => {
          const r = chars[index].rect
          memory.set(
            [r.x * 100, (r.x + r.width) * 100, (1 - r.y - r.height) * 100, (1 - r.y) * 100],
            at / 8
          )
          return 1
        })
      }
    }
  const capture = (): void => captureNativeLinkOrigins(native, { doc: 1 }, input, [link], geometry)
  const map = (): ReturnType<typeof mapReflowLinks> =>
    mapReflowLinks(
      { links: [link], geometry, outlines: [], outlineCount: 0 },
      input,
      {
        originals: new Map([[2, 2]]),
        crops: [],
        placements: new Map(),
        sourcePages: [],
        firstContent: new Map(),
        lines: new Map([
          [0, [{ text: unit.translation, start: 0, pageNumber: 1, rect: unit.fragments[0].rect }]]
        ])
      },
      (text: string): number => text.length
    )
  return { chars, unit, input, link, native, geometry, capture, map }
}

it('uses complete native character provenance to map the correct repeated unchanged origin', () => {
  const f = fixture()
  expect(f.map().mapped).toHaveLength(0)
  f.capture()
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toEqual({ start: 14, text: '1.' })
  const result = f.map()
  expect([...result.failed]).toEqual([])
  expect(result.mapped).toHaveLength(1)
  expect(result.mapped[0].regions).toEqual([
    { pageNumber: 1, rect: { x: 0.1 + 14 / 595.28, y: 0.1, width: 2 / 595.28, height: 0.1 } }
  ])
  expect(result.mapped[0].link).toBe(f.link)
  expect(result.mapped[0].target).toEqual({ pageNumber: 2, mode: 1, params: [0, 100, null] })
  expect(f.native.p.FPDFText_ClosePage).toHaveBeenCalledOnce()
  expect(f.native.p.FPDF_ClosePage).toHaveBeenCalledOnce()
  expect(f.native.free).toHaveBeenCalledOnce()
})

it('preserves UTF16 offsets when native spaces and line endings differ', () => {
  const f = fixture('𝛼\r\nAlpha 1. Beta 1.')
  f.capture()
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toEqual({ start: 18, text: '1.' })
  expect(f.map().mapped).toHaveLength(1)
})

type Fixture = ReturnType<typeof fixture>
it.each<[string, (f: Fixture) => void]>([
  [
    'changed translation',
    (f) => {
      f.unit.translation = 'Changed ' + f.unit.source
    }
  ],
  [
    'missing source provenance',
    (f) => {
      f.unit.fragments[0].items = []
    }
  ],
  [
    'wrong source provenance',
    (f) => {
      f.unit.fragments[0].items[0].text = 'Different'
    }
  ],
  [
    'invalid source index',
    (f) => {
      f.unit.fragments[0].items[0].index = -1
    }
  ],
  [
    'repeated source index',
    (f) => {
      f.unit.fragments[0].items.push({ index: 0, text: '' })
    }
  ],
  [
    'missing native character',
    (f) => {
      f.chars.splice(2, 1)
    }
  ],
  [
    'wrong native character',
    (f) => {
      f.chars[2].text = 'X'
    }
  ],
  [
    'nonfinite native bounds',
    (f) => {
      f.chars[0].rect.x = Infinity
    }
  ],
  [
    'unknown native Unicode',
    (f) => {
      f.native.p.FPDFText_GetUnicode.mockReturnValue(0)
    }
  ],
  [
    'foreign overlap',
    (f) => {
      f.chars.push({ ...f.chars[14], text: 'X' })
    }
  ],
  [
    'partially owned glyph',
    (f) => {
      f.chars[0].rect.x = 0.099
    }
  ],
  [
    'rotated native text',
    (f) => {
      f.chars[0].angle = Math.PI / 4
    }
  ],
  [
    'rotated source page',
    (f) => {
      f.native.p.FPDFPage_GetRotation.mockReturnValue(1)
    }
  ],
  [
    'native char-box refusal',
    (f) => {
      f.native.p.FPDFText_GetCharBox.mockReturnValue(0)
    }
  ],
  [
    'multiple source fragments',
    (f) => {
      f.unit.fragments.push(structuredClone(f.unit.fragments[0]))
    }
  ],
  [
    'multiple source owners',
    (f) => {
      f.input.units.push(structuredClone(f.unit))
    }
  ],
  [
    'protected source owner',
    (f) => {
      f.unit.kind = 'visual'
    }
  ],
  [
    'incorrect native label',
    (f) => {
      f.link.labels[0] = '2.'
    }
  ],
  [
    'empty native label',
    (f) => {
      f.link.labels[0] = ''
    }
  ],
  [
    'nonfinite annotation rectangle',
    (f) => {
      f.link.regions[0].width = Infinity
    }
  ],
  [
    'clipped annotation label',
    (f) => {
      f.link.regions[0].width = 0.01
    }
  ]
])('retains the existing fallback for %s', (_name, mutate) => {
  const f = fixture()
  mutate(f)
  f.capture()
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  expect(f.map().mapped).toHaveLength(0)
})

it('binds certificates to the exact native annotation and unchanged source snapshot', () => {
  const f = fixture()
  f.capture()
  expect(nativeLinkOriginSpan(structuredClone(f.link), f.unit, 0, 0)).toBeUndefined()
  expect(nativeLinkOriginSpan(f.link, structuredClone(f.unit), 0, 0)).toBeUndefined()
  expect(nativeLinkOriginSpan(f.link, f.unit, 1, 0)).toBeUndefined()
  f.link.labels[0] = '1. '
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  f.link.labels[0] = '1.'
  f.unit.fragments[0].items[0].text = 'Altered'
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toBeUndefined()
})

it('discards stale proof on recapture and returns independent result values', () => {
  const f = fixture()
  f.capture()
  const result = nativeLinkOriginSpan(f.link, f.unit, 0, 0)
  result.start = 0
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toEqual({ start: 14, text: '1.' })
  f.chars[2].text = 'X'
  f.capture()
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toBeUndefined()
})
