import { it, expect } from 'vitest'
import {
  resolveNestedScriptGroups,
  resolveScientificScriptSpans
} from '../resources/scientific-scripts.mjs'
import type { ScientificScriptMarker } from '../resources/scientific-scripts.mjs'
import { nativeMathSymbolText } from '../resources/math-symbols.mjs'
const source = 'Use q′β in this expression.',
  translation = '在表达式中使用q′β。',
  start = source.indexOf('q′β')
const base = {
    label: 'q',
    sourceOffset: start,
    scale: 1,
    rise: 0,
    bounds: [100, 100, 105.19, 106.33],
    sourceIndices: [10]
  } satisfies ScientificScriptMarker,
  upper = {
    label: '′',
    sourceOffset: start + 1,
    scale: 0.7,
    rise: 3.615,
    bounds: [105.65, 105.82, 107.4, 109.44],
    sourceIndices: [11]
  } satisfies ScientificScriptMarker,
  lower = {
    label: 'β',
    sourceOffset: start + 2,
    scale: 0.7,
    rise: -2.822,
    bounds: [105.76, 99.04, 108.89, 104.01],
    sourceIndices: [12]
  } satisfies ScientificScriptMarker
it('retains a prime and aligned lower index as one complete native group', () => {
  expect(resolveNestedScriptGroups(source, translation, [base, upper, lower])).toEqual([
    {
      sourceOffset: start,
      targetOffset: translation.indexOf('q′β'),
      label: 'q′β',
      sourceIndices: [10, 11, 12],
      baselineIndex: 10,
      nativeScriptGroup: true
    }
  ])
  expect(resolveNestedScriptGroups(source, source, [base, upper, lower])).toHaveLength(1)
})
it.each([
  'changed',
  'missing',
  'duplicate-target',
  'source-boundary',
  'offset',
  'shared',
  'nonconsecutive',
  'same-level',
  'same-size',
  'far-rise',
  'misaligned',
  'nan',
  'missing-bounds'
])('rejects an unproved prime stack %s', (fault) => {
  const m = structuredClone([base, upper, lower])
  let a = source,
    b = translation
  if (fault === 'changed') b = b.replace('q′β', 'q′γ')
  if (fault === 'missing') b = b.replace('q′β', 'qβ')
  if (fault === 'duplicate-target') b += 'q′β'
  if (fault === 'source-boundary') a = a.replace('q′β', 'aq′β')
  if (fault === 'offset') m[1].sourceOffset++
  if (fault === 'shared') m[2].sourceIndices = [11]
  if (fault === 'nonconsecutive') m[2].sourceIndices = [14]
  if (fault === 'same-level') m[1].rise = -1
  if (fault === 'same-size') m[1].scale = 1
  if (fault === 'far-rise') m[1].rise = 20
  if (fault === 'misaligned') m[2].bounds[0] += 10
  if (fault === 'nan') m[1].scale = NaN
  if (fault === 'missing-bounds') m[1].bounds = [] as unknown as [number, number, number, number]
  expect(resolveNestedScriptGroups(a, b, m)).toEqual([])
})
it('uses only the existing native prime encoding proof', () => {
  const object = { text: '0', bounds: upper.bounds }
  expect(nativeMathSymbolText(object, 'CMSY7')).toBe('′')
  expect(nativeMathSymbolText(object, 'Ordinary')).toBe('0')
  expect(nativeMathSymbolText({ ...object, bounds: [100, 100, 105, 105] }, 'CMSY7')).toBe('0')
  expect(
    resolveNestedScriptGroups(source, translation, [base, { ...upper, label: '0' }, lower])
  ).toEqual([])
})
it.each(['range', 'tuple'])('closes the whole native %s script run', (kind) => {
  const label = kind === 'range' ? 'y1:j−1' : 'z(a,b)',
    a = 'Use ' + label + '.',
    b = '使用' + label + '。',
    at = a.indexOf(label),
    pieces = kind === 'range' ? ['y', '1:', 'j', '−1'] : ['z', '(', 'a,b', ')']
  let offset = at
  const markers = pieces.map((label, index) => {
    const result = {
      label,
      sourceOffset: offset,
      scale: index ? 0.7 : 1,
      rise: index ? (kind === 'range' ? -1.5 : 3.6) : 0,
      bounds: [100 + index * 3, 100, 103 + index * 3, 105] as [number, number, number, number],
      sourceIndices: [index + 20]
    }
    offset += label.length
    return result
  })
  const spans = resolveScientificScriptSpans(a, b, markers)
  expect(spans).toHaveLength(1)
  expect(b.slice(spans[0].start, spans[0].end)).toBe(label.slice(1))
  expect(spans[0].sourceIndices).toEqual(pieces.slice(1).map((_, i) => i + 21))
  expect(spans[0].rise).toBe(kind === 'range' ? -1.5 : 3.6)
  expect(
    resolveScientificScriptSpans(
      a,
      b,
      markers.map((m) => ({ ...m, scale: 1, rise: 0 }))
    )
  ).toEqual([])
  expect(
    resolveScientificScriptSpans(
      a,
      b.replace(label, kind === 'range' ? 'y1:k−1' : 'z(a,c)'),
      markers
    )
  ).toEqual([])
})

function setDimensions(label: string): {
  source: string
  translation: string
  markers: ScientificScriptMarker[]
} {
  const source = `The sample vector x ∈ ${label} lies in the stated space.`
  const translation = `样本向量 x ∈ ${label}，位于指定的空间。`
  const tokens = ['∈', ...label]
  const styles = [
    ['CMSY10', 100, 0, [40, 99, 45, 105]],
    ['MSBM10', 100, 0, [49, 100, 56, 107]],
    ['CMMI7', 104, 4, [57, 104, 62, 107]],
    ['CMSY7', 104, 4, [63, 104, 67, 107]],
    ['CMMI7', 104, 4, [68, 104, 72, 107]]
  ] as const
  const at = source.indexOf(label)
  return {
    source,
    translation,
    markers: tokens.map((token, index) => {
      const [fontName, baseline, rise, bounds] = styles[index]
      return {
        label: token,
        sourceOffset: index === 0 ? source.indexOf(token) : at + index - 1,
        fontName,
        baseline,
        scale: index <= 1 ? 1 : 0.7,
        rise,
        bounds,
        sourceIndices: [index + 5]
      }
    })
  }
}

it.each(['Sa', 'Sa×b'])(
  'keeps the native blackboard base and exponent together for %s',
  (label) => {
    const { source, translation, markers } = setDimensions(label)
    expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
      {
        sourceOffset: source.indexOf(label),
        targetOffset: translation.indexOf(label),
        label,
        sourceIndices: markers.slice(1).flatMap((marker) => marker.sourceIndices),
        baselineIndex: 6,
        nativeScriptGroup: true
      }
    ])
  }
)

it.each(['Sa×b', 'Sa𝑏', 'Sa+b'])(
  'keeps a short dimension separate from the extended term %s',
  (extended) => {
    const { source, translation, markers } = setDimensions('Sa')
    expect(resolveNestedScriptGroups(source, translation.replace('Sa', extended), markers)).toEqual(
      []
    )
  }
)

it('requires the same set relation, exponent and multiplicity', () => {
  const { source, translation, markers } = setDimensions('Sa×b')
  for (const changed of [
    translation.replace('∈', '⊂'),
    translation.replace('Sa×b', 'Sa×c'),
    translation + ' ∈ Sa×b'
  ]) {
    expect(resolveNestedScriptGroups(source, changed, markers)).toEqual([])
  }
})

it('requires contiguous native glyphs with a raised exponent and blackboard font', () => {
  const { source, translation, markers } = setDimensions('Sa×b')
  for (const changed of [
    { ...markers[1], fontName: 'CMR10' },
    { ...markers[2], rise: 0 },
    { ...markers[2], sourceIndices: [99] },
    { ...markers[2], bounds: [79, 104, 84, 107] as const }
  ]) {
    const altered = markers.map((marker) => (marker.label === changed.label ? changed : marker))
    expect(resolveNestedScriptGroups(source, translation, altered)).toEqual([])
  }
})
