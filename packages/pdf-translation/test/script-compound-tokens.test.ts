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

it('moves an exact TeX base and lowered letter together', () => {
  const source = 'Compare Vm with the reference.',
    translation = '比较 Vm 与基准。',
    start = source.indexOf('Vm')
  const markers: ScientificScriptMarker[] = [
    {
      label: 'V',
      sourceOffset: start,
      scale: 1,
      rise: 0,
      baseline: 100,
      bounds: [30, 99.4, 38, 108],
      sourceIndices: [4],
      fontName: 'CMSY10'
    },
    {
      label: 'm',
      sourceOffset: start + 1,
      scale: 0.73,
      rise: -1.7,
      baseline: 98.3,
      bounds: [38.3, 98.2, 43, 101.8],
      sourceIndices: [5],
      fontName: 'CMMI8'
    }
  ]
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    {
      sourceOffset: start,
      targetOffset: translation.indexOf('Vm'),
      label: 'Vm',
      sourceIndices: [4, 5],
      baselineIndex: 4,
      nativeScriptGroup: true,
      needsInlineReflow: true
    }
  ])
  const [base, index] = markers
  expect(resolveNestedScriptGroups(source, translation, [base, { ...index, rise: 0 }])).toEqual([])
  expect(
    resolveNestedScriptGroups(source, translation, [base, { ...index, sourceIndices: [7] }])
  ).toEqual([])
  expect(resolveNestedScriptGroups(source, translation.replace('Vm', 'Vm2'), markers)).toEqual([])
})

it.each(['CMMI7', 'CMMI8'])(
  'keeps a membership symbol, its calligraphic capital, and a lowered %s index together',
  (indexFont) => {
    const source = 'Choose q ∈ Xm as the control.',
      translation = '选择 q ∈ Xm 作为对照。',
      start = source.indexOf('∈ Xm')
    const markers: ScientificScriptMarker[] = [
      {
        label: '∈ X',
        sourceOffset: start,
        scale: 1,
        rise: 0,
        baseline: 100,
        bounds: [28, 99.3, 49, 108],
        sourceIndices: [4],
        fontName: 'CMSY10'
      },
      {
        label: 'm',
        sourceOffset: start + 3,
        scale: 0.73,
        rise: -1.7,
        baseline: 98.3,
        bounds: [46.15, 97.6, 50.8, 101.2],
        sourceIndices: [5],
        fontName: indexFont
      }
    ]
    expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
      {
        sourceOffset: start,
        targetOffset: translation.indexOf('∈ Xm'),
        label: '∈ Xm',
        sourceIndices: [4, 5],
        baselineIndex: 4,
        nativeScriptGroup: true,
        needsInlineReflow: true
      }
    ])
    expect(resolveNestedScriptGroups(source, translation.replace('Xm', 'Xn'), markers)).toEqual([])
    expect(resolveNestedScriptGroups(source, translation + ' ∈ Xm', markers)).toEqual([])
  }
)

it('keeps a bracketed TeX index and its raised suffix in one movable group', () => {
  const source = 'Use ω[j]d with the second state.',
    translation = '使用 ω[j]d 和第二个状态。',
    start = source.indexOf('ω')
  const run = (
    label: string,
    offset: number,
    fontName: string,
    scale: number,
    rise: number,
    bounds: NonNullable<ScientificScriptMarker['bounds']>
  ): ScientificScriptMarker => ({
    label,
    sourceOffset: start + offset,
    fontName,
    scale,
    rise,
    baseline: 100 + rise,
    bounds,
    sourceIndices: [4 + offset]
  })
  const markers = [
    run('ω', 0, 'CMMI10', 1, 0, [30, 100, 36, 105]),
    run('[', 1, 'CMR7', 0.7, -1.8, [37, 97, 38, 104]),
    run('j', 2, 'CMMI7', 0.7, -1.8, [38.5, 99, 41.5, 104]),
    run(']', 3, 'CMR7', 0.7, -1.8, [42, 97, 43, 104]),
    run('d', 4, 'CMMI5', 0.5, 0.2, [44.5, 100, 47, 103])
  ]
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    {
      sourceOffset: start,
      targetOffset: translation.indexOf('ω'),
      label: 'ω[j]d',
      sourceIndices: [4, 5, 6, 7, 8],
      baselineIndex: 4,
      nativeScriptGroup: true,
      needsInlineReflow: true
    }
  ])
  expect(resolveNestedScriptGroups(source, translation, markers.slice(0, -1))).toEqual([])
  expect(resolveNestedScriptGroups(source, translation.replace(']d', ']d2'), markers)).toEqual([])
  const detached = [...markers.slice(0, -1), { ...markers[4], bounds: [52, 100, 55, 103] as const }]
  expect(resolveNestedScriptGroups(source, translation, detached)).toEqual([])
})

it('keeps the asymmetric uncertainty attached to a generated measurement', () => {
  const source = 'Run yielded 62+7−9 kHz.',
    translation = '测得 62+7−9 kHz。',
    label = '+7−9',
    start = source.indexOf(label),
    markers: ScientificScriptMarker[] = [
      {
        sourceOffset: 0,
        label: 'Run yielded 62',
        scale: 1,
        rise: 0,
        baseline: 30,
        fontName: 'CMR10',
        bounds: [10, 28, 85, 37],
        sourceIndices: [9]
      },
      {
        sourceOffset: start,
        label: '+7',
        scale: 0.7,
        rise: 4,
        baseline: 34,
        fontName: 'CMR7',
        bounds: [85.5, 34, 93, 39],
        sourceIndices: [10]
      },
      {
        sourceOffset: start + 2,
        label: '−',
        scale: 0.7,
        rise: -2.5,
        baseline: 27.5,
        fontName: 'CMSY7',
        bounds: [85.6, 29, 89, 30],
        sourceIndices: [11]
      },
      {
        sourceOffset: start + 3,
        label: '9',
        scale: 0.7,
        rise: -2.5,
        baseline: 27.5,
        fontName: 'CMR7',
        bounds: [89.5, 28, 93, 32],
        sourceIndices: [12]
      }
    ]
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    {
      sourceOffset: start,
      targetOffset: translation.indexOf(label),
      label,
      sourceIndices: [10, 11, 12],
      baselineIndex: 9,
      nativeScriptGroup: true,
      needsInlineReflow: true
    }
  ])
  expect(resolveNestedScriptGroups(source, translation.replace('62', '63'), markers)).toEqual([])
  expect(resolveNestedScriptGroups(source, translation.replace('−9', '−8'), markers)).toEqual([])
  expect(resolveNestedScriptGroups(source, translation + ' 62+7−9', markers)).toEqual([])
  expect(resolveNestedScriptGroups(source, translation, markers.slice(0, -1))).toEqual([])
  const [base, upper, minus, lower] = markers
  expect(
    resolveNestedScriptGroups(source, translation, [
      base,
      upper,
      { ...minus, bounds: [90, 29, 94, 30] },
      lower
    ])
  ).toEqual([])
})

it('moves all native glyphs of a raised fractional exponent as a unit', () => {
  const source = 'Constrain x2/5 for the model.',
    translation = '将 x2/5 用于模型。',
    label = 'x2/5',
    start = source.indexOf(label)
  const markers: ScientificScriptMarker[] = [
    {
      label: 'x',
      sourceOffset: start,
      scale: 1,
      rise: 0,
      baseline: 100,
      fontName: 'CMMI10',
      bounds: [20, 100, 26, 106],
      sourceIndices: [7]
    },
    ...(['2', '/', '5'] as const).map((digit, index): ScientificScriptMarker => ({
      label: digit,
      sourceOffset: start + index + 1,
      scale: 0.73,
      rise: 4.2,
      baseline: 104.2,
      fontName: digit === '/' ? 'CMMI8' : 'CMR8',
      bounds: [26.5 + index * 4, digit === '/' ? 102 : 104, 29.5 + index * 4, 108],
      sourceIndices: [8 + index]
    }))
  ]
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    {
      sourceOffset: start,
      targetOffset: translation.indexOf(label),
      label,
      sourceIndices: [7, 8, 9, 10],
      baselineIndex: 7,
      nativeScriptGroup: true,
      needsInlineReflow: true
    }
  ])
  expect(resolveNestedScriptGroups(source, translation.replace('2/5', '2/7'), markers)).toEqual([])
  expect(
    resolveNestedScriptGroups(
      source,
      translation,
      markers.map((marker) =>
        marker.label === '/' ? { ...marker, baseline: 100, rise: 0 } : marker
      )
    )
  ).toEqual([])
  expect(
    resolveNestedScriptGroups(
      source,
      translation,
      markers.map((marker) => (marker.label === '/' ? { ...marker, baseline: NaN } : marker))
    )
  ).toEqual([])
})

it.each(['exact', 'detached', 'different target'])(
  'uses exact text and geometry for a lowered Latin index pair (%s)',
  (shape) => {
    const source = 'See the node pk,h near the boundary.'
    const target = shape === 'different target' ? '请查看节点 pk,g。' : '请查看节点 pk,h。'
    const at = source.indexOf('pk,h')
    const markers: ScientificScriptMarker[] = [
      {
        label: 'p',
        sourceOffset: at,
        scale: 1,
        rise: 0,
        bounds: [100, 100, 108, 107],
        sourceIndices: [8]
      },
      {
        label: 'k,h',
        sourceOffset: at + 1,
        scale: 0.66,
        rise: -1.8,
        bounds: shape === 'detached' ? [116, 98, 124, 105] : [108.2, 98, 116, 105],
        sourceIndices: [9]
      }
    ]
    const spans = resolveScientificScriptSpans(source, target, markers)
    if (shape === 'exact') {
      expect(spans).toHaveLength(1)
      expect(target.slice(spans[0].start, spans[0].end)).toBe('k,h')
      expect(spans[0].sourceIndices).toEqual([9])
      expect(spans[0].rise).toBe(-1.8)
    } else expect(spans).toEqual([])
  }
)
