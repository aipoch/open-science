import { expect, it } from 'vitest'
import {
  nativeSignedScriptRanges,
  type NativeSignedScriptRegion
} from '../resources/script-atomicity.mjs'
type Marker = NonNullable<NativeSignedScriptRegion['nativeScriptMarkers']>[number]
type Region = {
  nativeScriptBodySize: number
  nativeScriptMarkers: Array<
    Omit<Marker, 'bounds' | 'sourceIndices'> & { bounds: number[]; sourceIndices: number[] }
  >
  anchors: Array<NativeSignedScriptRegion['anchors'][number]>
}

const source = 'A plot of Rate −2 versus time.',
  target = '变化率 Rate −2 随时间变化。'
const region = (): Region => ({
  nativeScriptBodySize: 10,
  nativeScriptMarkers: [
    {
      sourceOffset: 10,
      label: 'Rate',
      sourceIndices: [1],
      fontName: 'BodyItalic',
      baseline: 100,
      bounds: [10, 100, 30, 107],
      scale: 1,
      rise: 0
    },
    {
      sourceOffset: 15,
      label: '−',
      sourceIndices: [2],
      fontName: 'MathSymbols',
      baseline: 103.5,
      bounds: [31, 105, 35, 106],
      scale: 0.75,
      rise: 3.5
    },
    {
      sourceOffset: 16,
      label: '2',
      sourceIndices: [3],
      fontName: 'BodyRoman',
      baseline: 103.5,
      bounds: [36, 103.5, 39, 109],
      scale: 0.75,
      rise: 3.5
    }
  ],
  anchors: [
    {
      indices: [2],
      sourceOffset: 15,
      targetOffset: 9,
      label: '−',
      baseline: 103.5,
      movable: true,
      annotation: undefined as { uri: string } | undefined,
      nativeFootnoteRow: false
    },
    {
      indices: [3],
      sourceOffset: 16,
      targetOffset: 10,
      label: '2',
      baseline: 103.5,
      movable: true,
      annotation: undefined as { uri: string } | undefined,
      nativeFootnoteRow: false
    }
  ]
})
it('proves an intact native identifier and signed exponent through target whitespace', () => {
  expect(nativeSignedScriptRanges(source, target, [region()])).toEqual([
    { start: 4, scriptStart: 9, end: 11 }
  ])
})
it.each([
  [
    'body-baseline measurement',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[1].rise = 0
    }
  ],
  [
    'detached raised note',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[1].bounds[0] = 44
    }
  ],
  [
    'non-finite script metrics',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[1].scale = Number.NaN
    }
  ],
  [
    'unrelated raised baseline',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[1].baseline += 10
      r.anchors[0].baseline += 10
    }
  ],
  [
    'unknown native font',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[0].fontName = ''
    }
  ],
  [
    'ambiguous native occurrence',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers.push({ ...r.nativeScriptMarkers[0] })
    }
  ],
  [
    'shared script index',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[2].sourceIndices = [2]
    }
  ],
  [
    'baseline disagreement',
    (r: ReturnType<typeof region>) => {
      r.anchors[0].baseline = 101
    }
  ],
  [
    'linked marker',
    (r: ReturnType<typeof region>) => {
      r.anchors[0].annotation = { uri: 'https://example.invalid/' }
    }
  ],
  [
    'footnote marker',
    (r: ReturnType<typeof region>) => {
      r.anchors[0].nativeFootnoteRow = true
    }
  ],
  [
    'changed source offset',
    (r: ReturnType<typeof region>) => {
      r.nativeScriptMarkers[1].sourceOffset++
    }
  ],
  [
    'duplicated anchor',
    (r: ReturnType<typeof region>) => {
      r.anchors.push({ ...r.anchors[0] })
    }
  ],
  [
    'unmovable native marker',
    (r: ReturnType<typeof region>) => {
      r.anchors[0].movable = false
    }
  ]
] as const)('abstains from %s', (_name, change) => {
  const r = region()
  change(r)
  expect(nativeSignedScriptRanges(source, target, [r])).toEqual([])
})
it('rejects extra target occurrences, changed powers and duplicate fragment ownership', () => {
  expect(nativeSignedScriptRanges(source, target + ' Rate −2', [region()])).toEqual([])
  expect(nativeSignedScriptRanges(source, target.replace('−2', '−3'), [region()])).toEqual([])
  expect(nativeSignedScriptRanges(source, target, [region(), region()])).toEqual([])
})
it('does not make ordinary numeric bases, unsigned footnotes or URI suffixes atomic', () => {
  for (const value of ['10 −2', 'Rate 2', 'https://example.invalid/Rate −2'])
    expect(nativeSignedScriptRanges(value, value, [region()])).toEqual([])
})

it('keeps a geometrically identical signed power atomic when target spacing changes', () => {
  const r = region()
  r.anchors.forEach((anchor) => anchor.targetOffset--)
  expect(nativeSignedScriptRanges(source, target.replace('Rate −2', 'Rate−2'), [r])).toEqual([
    { start: 4, scriptStart: 8, end: 10 }
  ])
})

it('maps repeated identical powers by complete source and target occurrence', () => {
  const first = region(),
    second = region(),
    sourceShift = source.length + 1,
    targetShift = target.length + 1
  for (const marker of second.nativeScriptMarkers) {
    marker.sourceOffset += sourceShift
    marker.sourceIndices = marker.sourceIndices.map((index) => index + 3)
  }
  for (const anchor of second.anchors) {
    anchor.sourceOffset += sourceShift
    anchor.targetOffset += targetShift
    anchor.indices = anchor.indices.map((index) => index + 3)
  }
  expect(
    nativeSignedScriptRanges(source + ' ' + source, target + ' ' + target, [first, second])
  ).toEqual([
    { start: 4, scriptStart: 9, end: 11 },
    { start: 4 + targetShift, scriptStart: 9 + targetShift, end: 11 + targetShift }
  ])
  second.anchors[0].targetOffset = first.anchors[0].targetOffset
  expect(
    nativeSignedScriptRanges(source + ' ' + source, target + ' ' + target, [first, second])
  ).toHaveLength(1)
})
