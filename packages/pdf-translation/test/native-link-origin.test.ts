import { expect, it, vi } from 'vitest'
import {
  captureNativeLinkOrigins,
  nativeLinkOriginSpan,
  nativeLinkSourceSpan
} from '../resources/native-link-origin.mjs'
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

function closedHitFixture(source = 'First [7, 9]. Next [7, 12].'): Fixture {
  const f = fixture(source),
    start = f.unit.source.lastIndexOf('[7,'),
    last = start + 2
  f.unit.translation = '首先 [7, 9]，随后 [7, 12]。'
  f.link.labels = ['[7, ']
  f.link.regions = [
    {
      x: f.chars[start].rect.x - 0.001,
      y: 0.119,
      width: f.chars[last].rect.x + f.chars[last].rect.width - f.chars[start].rect.x + 0.002,
      height: 0.022
    }
  ]
  return f
}

it('maps punctuation-bearing hits through the complete native closed list', () => {
  const f = closedHitFixture()
  expect(f.map().mapped).toHaveLength(0)
  f.capture()
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start: 19, text: '[7,' })
  const result = f.map()
  expect(result.failed.size).toBe(0)
  expect(result.mapped).toHaveLength(1)
  expect(result.mapped[0].target).toEqual(f.link.destination)
  expect(result.mapped[0].regions[0].rect.width).toBeCloseTo(3 / 595.28)
})

it.each<[string, (f: Fixture) => void]>([
  [
    'changed list',
    (f) => {
      f.unit.translation = '首先 [7, 9]，随后 [7, 13]。'
    }
  ],
  [
    'added list occurrence',
    (f) => {
      f.unit.translation += ' 再次 [7, 12]。'
    }
  ],
  [
    'native item mismatch',
    (f) => {
      f.unit.fragments[0].items[0].text = 'Foreign source'
    }
  ],
  [
    'foreign native glyph',
    (f) => {
      f.chars[0].text = 'Z'
    }
  ],
  [
    'rotated native glyph',
    (f) => {
      f.chars[0].angle = 0.1
    }
  ],
  [
    'outside glyph',
    (f) => {
      f.chars[0].rect.x = 0.09
    }
  ],
  [
    'partial source block',
    (f) => {
      f.unit.source = f.unit.source.replace('[7, 12]', '[7, 12')
    }
  ]
])('rejects a closed native hit with %s', (_name, change) => {
  const f = closedHitFixture()
  change(f)
  f.capture()
  expect(f.map().mapped).toHaveLength(0)
  expect(f.map().failed).toEqual(new Set([1]))
})

it('binds a closed hit certificate to the original owner, region and source', () => {
  const f = closedHitFixture()
  f.capture()
  const original = f.unit.source
  f.unit.source += ' changed'
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  f.unit.source = original
  f.link.regions[0].width += 0.001
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  expect(nativeLinkSourceSpan({ ...f.link }, f.unit, 0, 0)).toBeUndefined()
})

it('does not recover a duplicate native list from a truncated source owner', () => {
  const f = closedHitFixture('First [7, 9]. Next [7, 9]. 1')
  f.unit.source = '7,9]. Next [7, 9]. 1'
  f.unit.translation = '译文 [7, 9]。'
  f.capture()
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  expect(f.map().mapped).toHaveLength(0)
})

it('uses a unique full native list with literal nearby context after line joining', () => {
  const f = fixture('First hy-phen [7,9]. Middle suf-fix 1'),
    start = f.unit.source.indexOf('[7,')
  f.link.labels = ['[7,']
  f.link.regions = [
    {
      x: f.chars[start].rect.x - 0.001,
      y: 0.119,
      width: f.chars[start + 2].rect.x + 0.01 - f.chars[start].rect.x + 0.001,
      height: 0.022
    }
  ]
  f.unit.source = f.unit.source.replace('hy-phen', 'hyphen').replace('suf-fix', 'suffix')
  f.unit.translation = '译文 [7,9]。'
  Object.assign(f.native.p, { FPDFText_IsHyphen: vi.fn(() => 1) })
  f.native.p.FPDFText_GetUnicode.mockImplementation((_page: number, index: number) =>
    f.chars[index].text === '-' ? 2 : f.chars[index].text.codePointAt(0)
  )
  f.capture()
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start: 13, text: '[7,' })
  expect(f.map().mapped).toHaveLength(1)
})

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

it('certifies a translated paragraph source occurrence without inventing a target position', () => {
  const f = fixture()
  f.unit.translation = '甲的结果为1。乙的结果也为1。'
  f.capture()
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start: 14, text: '1.' })
  expect(nativeLinkOriginSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  expect(f.map().mapped).toHaveLength(0)
  f.link.pageNumber = 2
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  f.link.pageNumber = 1
  f.link.index++
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  f.link.index--
  f.unit.translation = '另一种译文'
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start: 14, text: '1.' })
  f.unit.source += ' Changed source.'
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
})
it.each(['ambiguous-context', 'native-text', 'direction', 'source-owner', 'source-index'])(
  'does not certify an unproved translated source context: %s',
  (kind) => {
    const f = fixture()
    f.unit.translation = '甲的结果为1。乙的结果也为1。'
    if (kind === 'ambiguous-context') f.unit.source += ' ' + f.unit.source
    if (kind === 'native-text') f.chars[0].text = 'Z'
    if (kind === 'direction') f.chars[0].angle = Math.PI / 2
    if (kind === 'source-owner') f.unit.fragments[0].items[0].text += 'foreign'
    if (kind === 'source-index') f.unit.fragments[0].items.push({ index: 0, text: '' })
    f.capture()
    expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
    expect(f.map().mapped).toHaveLength(0)
  }
)

it.each([true, false])(
  'requires native proof before reading a line-end hyphen marker: %s',
  (proved) => {
    const f = fixture('Alpha- 1. Beta 1.')
    f.unit.translation = '不同的译文'
    const index = f.chars.findIndex((c) => c.text === '-')
    f.chars[index].text = '\u0002'
    Object.assign(f.native.p, {
      FPDFText_IsHyphen: (_page: number, at: number) => (proved && at === index ? 1 : 0)
    })
    f.capture()
    if (proved)
      expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start: 15, text: '1.' })
    else expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  }
)

it('maps a repeated author prefix only after native source and dated target proofs agree', () => {
  const source = '(Morris et al., 2021) versus (Morris et al., 2022).'
  const f = fixture(source)
  const label = '(Morris et al.,'
  const start = source.lastIndexOf(label),
    end = start + label.length
  f.unit.translation = '比較（Morris等，2022年）与（Morris等，2021年）。'
  f.link.labels[0] = label
  f.link.regions[0] = {
    x: f.chars[start].rect.x - 0.001,
    y: 0.119,
    width: f.chars[end - 1].rect.x + f.chars[end - 1].rect.width - f.chars[start].rect.x + 0.002,
    height: 0.022
  }
  f.capture()
  expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start, text: label })
  const mapped = f.map()
  expect(mapped.mapped).toHaveLength(1)
  expect(mapped.mapped[0].regions[0].rect.x).toBeCloseTo(
    0.1 + f.unit.translation.indexOf('（') / 595.28
  )
  f.unit.translation = f.unit.translation.replace('2022', '2023')
  expect(f.map().mapped).toHaveLength(0)
})

it.each(['clear', 'foreign-ink', 'large-hit-area', 'spilling-owned-ink'])(
  'keeps the annotation whitespace collar separate from native ink ownership: %s',
  (kind) => {
    const f = fixture()
    f.unit.translation = '一处不同的译文'
    f.unit.fragments[0].rect.height = 0.04
    if (kind === 'foreign-ink')
      f.chars.push({
        text: 'X',
        angle: 0,
        rect: { x: f.link.regions[0].x + 0.002, y: 0.1405, width: 0.002, height: 0.001 }
      })
    if (kind === 'large-hit-area') f.link.regions[0].height += 0.004
    if (kind === 'spilling-owned-ink') f.chars[0].rect.height += 0.005
    f.capture()
    if (kind === 'clear')
      expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toEqual({ start: 14, text: '1.' })
    else expect(nativeLinkSourceSpan(f.link, f.unit, 0, 0)).toBeUndefined()
  }
)
