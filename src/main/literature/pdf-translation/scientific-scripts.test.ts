import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import {
  resolveInlineFractions,
  type FractionItem
} from '../../../../resources/pdf-translation/math-fractions.mjs'
import {
  resolveScientificScriptSpans,
  resolveNestedScriptGroups,
  resolveOrdinalSuffixIndices,
  resolveExplicitTransposeIndices,
  resolveExplicitPowerIndices,
  type ScientificScriptMarker
} from '../../../../resources/pdf-translation/scientific-scripts.mjs'

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    expected: ReturnType<typeof resolveNestedScriptGroups>
  }>('spaced-native-script-groups.jsonl')
)('proves spaced native script ownership: $name', ({ source, translation, markers, expected }) => {
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual(expected)
  for (const suffix of ['q', '2', '_', '′', '\u0302', '𝑎']) {
    expect(
      resolveNestedScriptGroups(
        source,
        translation.replace(expected[0].label, expected[0].label + suffix),
        markers
      )
    ).toEqual([])
  }
  for (const target of [
    translation + ` Z ${expected[0].label}`,
    translation.replace('Z', 'Y'),
    translation.replace(expected[0].label, 'C')
  ])
    expect(resolveNestedScriptGroups(source, target, markers)).toEqual([])
  for (const change of [
    'flat',
    'size',
    'offset',
    'gap',
    'nan',
    'missing',
    'duplicate',
    'index',
    'prefix',
    'far-above',
    'bounds'
  ] as const) {
    const m = markers.map((marker) => ({ ...structuredClone(marker) }))
    if (change === 'flat') m[1].rise = 0
    if (change === 'size') m[1].scale = 1
    if (change === 'offset') m[1].sourceOffset++
    if (change === 'gap') m[1].bounds = [120, 104, 124, 109]
    if (change === 'nan') m[0].rise = NaN
    if (change === 'missing') m.shift()
    if (change === 'duplicate') m.push({ ...m[1] })
    if (change === 'index') m[1].sourceIndices = [15]
    if (change === 'prefix') m[0].label = 'word Z'
    if (change === 'far-above') m[1].rise = 50
    if (change === 'bounds') m[0].bounds = [90, 100, 80, 108]
    expect(resolveNestedScriptGroups(source, translation, m)).toEqual([])
  }
  if (markers.length === 3) {
    for (const change of ['upper', 'scale', 'alignment', 'far-below']) {
      const m = markers.map((marker) => ({ ...structuredClone(marker) }))
      if (change === 'upper') m[2].rise = 4
      if (change === 'scale') m[2].scale = 0.6
      if (change === 'alignment') m[2].bounds = [87, 97.5, 91, 102.5]
      if (change === 'far-below') m[2].rise = -50
      expect(resolveNestedScriptGroups(source, translation, m)).toEqual([])
    }
  }
})

it.each(['s+', 's−'])('keeps native signed subscript tokens complete (%s)', (label) => {
  const source = `😀 Use ${label}.`,
    translation = `使用${label}。`,
    offset = source.indexOf(label)
  const markers = [
    {
      label: label[0],
      sourceOffset: offset,
      sourceIndices: [10],
      scale: 1,
      rise: 0,
      bounds: [100, 100, 104, 104.5]
    },
    {
      label: label[1],
      sourceOffset: offset + 1,
      sourceIndices: [11],
      scale: 0.7,
      rise: -1.5,
      bounds: [104.5, 98.5, 109, 102.8]
    }
  ] satisfies ScientificScriptMarker[]
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    {
      sourceOffset: offset,
      targetOffset: translation.indexOf(label),
      label,
      sourceIndices: [10, 11],
      baselineIndex: 10
    }
  ])
  for (const suffix of ['q', '2', '_', '′', '\u0302', '𝑎', '+', '−']) {
    expect(
      resolveNestedScriptGroups(source, translation.replace(label, label + suffix), markers)
    ).toEqual([])
    const longer = source.replace(label, label + suffix)
    expect(resolveNestedScriptGroups(longer, translation, markers)).toEqual([])
  }
  for (const target of [
    '使用s。',
    translation.replace(label, label === 's+' ? 's−' : 's+'),
    translation + label
  ])
    expect(resolveNestedScriptGroups(source, target, markers)).toEqual([])
  for (const change of [
    'same-level',
    'same-size',
    'far-below',
    'distant',
    'duplicate',
    'missing',
    'indices',
    'offset',
    'nan',
    'bounds'
  ] as const) {
    const m = structuredClone(markers)
    if (change === 'same-level') m[1].rise = 0
    if (change === 'same-size') m[1].scale = 1
    if (change === 'far-below') m[1].rise = -100
    if (change === 'distant') m[1].bounds = [130, 98, 135, 102]
    if (change === 'duplicate') m.push({ ...m[1], sourceIndices: [12] })
    if (change === 'missing') m.shift()
    if (change === 'indices') m[1].sourceIndices = [12]
    if (change === 'offset') m[1].sourceOffset++
    if (change === 'nan') m[1].scale = NaN
    if (change === 'bounds') m[1].bounds = [] as unknown as [number, number, number, number]
    expect(resolveNestedScriptGroups(source, translation, m)).toEqual([])
  }
})

it.each(['xzt', 'xzj', 'xz<t', 'ab2', 'ab≥2'])(
  'preserves three native cascading subscript runs (%s)',
  (label) => {
    const source = `😀 Use ${label}.`,
      translation = `😀使用${label}。`,
      offset = source.indexOf(label)
    const markers = [
      {
        label: label[0],
        sourceOffset: offset,
        sourceIndices: [10],
        scale: 1,
        rise: 0,
        bounds: [100, 100, 105, 104.5]
      },
      {
        label: label[1],
        sourceOffset: offset + 1,
        sourceIndices: [11],
        scale: 0.7,
        rise: -1.5,
        bounds: [105.2, 98.5, 108.5, 101.7]
      },
      {
        label: label.slice(2),
        sourceOffset: offset + 2,
        sourceIndices: [12],
        scale: 0.5,
        rise: -2.5,
        bounds: [108.8, 97.5, 112, 100.6]
      }
    ] satisfies ScientificScriptMarker[]
    expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
      {
        sourceOffset: offset,
        targetOffset: translation.indexOf(label),
        label,
        sourceIndices: [10, 11, 12],
        baselineIndex: 10
      }
    ])
    for (const target of [
      translation.replace(label, 'uvw'),
      translation + label,
      translation.replace(label, ''),
      translation.replace(label, label + '′'),
      translation.replace(label, '𝑎' + label),
      translation.replace(label, label + '\u0302'),
      translation.replace(label, label + '_'),
      translation.replace(label, label + 'a')
    ])
      expect(resolveNestedScriptGroups(source, target, markers)).toEqual([])
    for (const change of [
      'empty',
      'nan',
      'duplicate',
      'indices',
      'offset',
      'flat',
      'same-level',
      'same-point',
      'far-below',
      'distant',
      'overlap',
      'missing',
      'raised'
    ] as const) {
      const m = structuredClone(markers)
      if (change === 'empty') m[2].bounds = [] as unknown as [number, number, number, number]
      if (change === 'nan') m[2].rise = NaN
      if (change === 'duplicate') m.push({ ...m[2], sourceIndices: [13] })
      if (change === 'indices') m[2].sourceIndices = [14]
      if (change === 'offset') m[2].sourceOffset++
      if (change === 'flat') m[1].rise = m[2].rise = 0
      if (change === 'same-level') m[2].rise = m[1].rise
      if (change === 'same-point') m[2].scale = m[1].scale
      if (change === 'far-below') m[2].rise = -100
      if (change === 'distant') m[2].bounds = [140, 97.5, 145, 100.6]
      if (change === 'overlap') m[2].bounds = [105.2, 97.5, 110, 100.6]
      if (change === 'missing') m.shift()
      if (change === 'raised') m[2].rise = 1
      expect(resolveNestedScriptGroups(source, translation, m)).toEqual([])
    }
    const source2 = `${source} ${label}.`,
      translation2 = `${translation}与${label}。`,
      delta = source2.lastIndexOf(label) - offset
    const twice = [
      ...markers,
      ...markers.map((m) => ({
        ...m,
        sourceOffset: m.sourceOffset + delta,
        sourceIndices: m.sourceIndices.map((i) => i + 10)
      }))
    ]
    expect(
      resolveNestedScriptGroups(source2, translation2, twice).map((g) => g.targetOffset)
    ).toEqual([translation2.indexOf(label), translation2.lastIndexOf(label)])
    expect(resolveNestedScriptGroups(source2, translation, twice)).toEqual([])
  }
)

it.each([
  'z00',
  'z0L',
  ...readPdfTranslationCases<{ label: string }>('native-perpendicular-script-token.jsonl').map(
    (record) => record.label
  )
])('keeps short paired native token %s subject to the full native proof', (label) => {
  const source = `😀 Use ${label}.`,
    translation = `😀使用${label}。`,
    offset = source.indexOf(label)
  const markers = [
    {
      label: label[0],
      sourceOffset: offset,
      sourceIndices: [10],
      scale: 1,
      rise: 0,
      bounds: [100, 100, 104, 104.5]
    },
    {
      label: label[1],
      sourceOffset: offset + 1,
      sourceIndices: [11],
      scale: 0.7,
      rise: 3.615,
      bounds: [104.1, 103.6, 107.5, 108.4]
    },
    {
      label: label[2],
      sourceOffset: offset + 2,
      sourceIndices: [12],
      scale: 0.7,
      rise: -2.542,
      bounds: [104.1, 97.45, 107.5, 102.1]
    }
  ] satisfies ScientificScriptMarker[]
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    {
      sourceOffset: offset,
      targetOffset: translation.indexOf(label),
      label,
      sourceIndices: [10, 11, 12],
      baselineIndex: 10
    }
  ])
  for (const target of [
    translation.replace(label, 'z01'),
    translation + label,
    translation.replace(label, label + '′'),
    translation.replace(label, label + '_'),
    translation.replace(label, label + '⊥')
  ])
    expect(resolveNestedScriptGroups(source, target, markers)).toEqual([])
  for (const change of ['bounds', 'indices', 'level', 'flat', 'duplicate', 'offset'] as const) {
    const altered = structuredClone(markers)
    if (change === 'bounds') altered[2].bounds = [120, 97, 125, 102]
    if (change === 'indices') altered[2].sourceIndices = [18]
    if (change === 'level') altered[2].rise = 3
    if (change === 'flat') altered[1].rise = altered[2].rise = 0
    if (change === 'duplicate') altered.push({ ...altered[2], sourceIndices: [18] })
    if (change === 'offset') altered[2].sourceOffset++
    expect(resolveNestedScriptGroups(source, translation, altered)).toEqual([])
  }
  expect(resolveNestedScriptGroups('abc', 'abc', markers)).toEqual([])
})

it.each([
  'exact',
  'repeated',
  'surrogate-prefix',
  'flat',
  'same-level',
  'different-scale',
  'nan',
  'empty-bounds',
  'inverted-bounds',
  'distant',
  'unaligned',
  'far-below',
  'wrong-adjacency',
  'duplicate-marker',
  'missing-base',
  'changed',
  'extra-target',
  'source-prefix',
  'source-underscore',
  'target-underscore',
  'source-combining',
  'target-combining',
  'source-prime',
  'target-prime',
  'oversized-label'
] as const)('preserves complete paired native script groups (%s)', (kind) => {
  let source = 'Constant cFP322.',
    translation = '常数cFP322。'
  if (kind === 'repeated') {
    source += ' And cFP322.'
    translation += '与cFP322。'
  }
  if (kind === 'surrogate-prefix') {
    source = '😀 ' + source
    translation = '😀更多' + translation
  }
  if (kind === 'changed') translation = '常数cFP321。'
  if (kind === 'extra-target') translation += 'cFP322'
  if (kind === 'source-prefix') source = 'AcFP322'
  if (kind === 'source-underscore') source = '_cFP322'
  if (kind === 'target-underscore') translation = 'cFP322_'
  if (kind === 'source-combining') source = 'cFP322\u0302'
  if (kind === 'target-combining') translation = 'cFP322\u0302'
  if (kind === 'source-prime') source = 'cFP322′'
  if (kind === 'target-prime') translation = "cFP322'"
  if (kind === 'oversized-label') {
    source = 'cFP1282'
    translation = source
  }
  const offset = source.indexOf('cFP'),
    upper = kind === 'oversized-label' ? 'FP128' : 'FP32',
    markers = [
      {
        label: 'c',
        sourceOffset: offset,
        sourceIndices: [10],
        scale: 1,
        rise: 0,
        bounds: [100, 100, 104, 104.5]
      },
      {
        label: upper,
        sourceOffset: offset + 1,
        sourceIndices: [11],
        scale: 0.7,
        rise: 3.615,
        bounds: [104.1, 103.6, 118.5, 108.4]
      },
      {
        label: '2',
        sourceOffset: offset + 1 + upper.length,
        sourceIndices: [12],
        scale: 0.7,
        rise: -2.542,
        bounds: [104.4, 97.45, 107.5, 102.1]
      }
    ] satisfies ScientificScriptMarker[]
  if (kind === 'flat') markers[1].rise = 0
  if (kind === 'same-level') markers[2].rise = 2
  if (kind === 'different-scale') markers[2].scale = 0.55
  if (kind === 'nan') markers[1].rise = NaN
  if (kind === 'empty-bounds') markers[1].bounds = [] as unknown as [number, number, number, number]
  if (kind === 'inverted-bounds') markers[1].bounds = [120, 103, 110, 108]
  if (kind === 'distant') markers[1].bounds = [140, 103, 154, 108]
  if (kind === 'unaligned') markers[2].bounds = [105.5, 97, 108, 102]
  if (kind === 'far-below') {
    markers[2].rise = -20
    markers[2].bounds = [104.4, 80, 107.5, 84]
  }
  if (kind === 'wrong-adjacency') markers[2].sourceIndices = [15]
  if (kind === 'duplicate-marker') markers.push({ ...markers[1], sourceIndices: [16] })
  if (kind === 'missing-base') markers.shift()
  const groups = resolveNestedScriptGroups(source, translation, markers)
  expect(groups).toEqual(
    ['exact', 'repeated', 'surrogate-prefix'].includes(kind)
      ? [
          {
            sourceOffset: offset,
            targetOffset: translation.indexOf('cFP322'),
            label: 'cFP322',
            sourceIndices: [10, 11, 12],
            baselineIndex: 10
          }
        ]
      : []
  )
})

it.each(
  (['move', 'changed', 'count', 'reordered', 'prime', 'unchanged'] as const).flatMap((kind) =>
    ['FP32', '0'].map((upper) => ({ kind, upper }))
  )
)(
  'moves or safely retains a complete paired native script stack ($kind, $upper)',
  async ({ kind, upper }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800])
    page.drawText('Constant ', { font, size: 10, x: 40, y: 700 })
    page.drawText('c', { font, size: 10, x: 85, y: 700 })
    page.drawText(upper, { font, size: 7, x: 89.5, y: 703.6 })
    page.drawText('2', { font, size: 7, x: 89.5, y: 697.45 })
    page.drawText(' stays stable.', { font, size: 10, x: 107, y: 700 })
    const source = `Constant c${upper}2 stays stable.`,
      translated =
        kind === 'changed'
          ? `常数c${upper}1保持稳定。`
          : kind === 'count'
            ? `常数c${upper}2和c${upper}2保持稳定。`
            : kind === 'reordered'
              ? `常数c2${upper}保持稳定。`
              : kind === 'prime'
                ? `常数c${upper}2′保持稳定。`
                : kind === 'unchanged'
                  ? source
                  : `原来的量化常数c${upper}2在这里保持稳定。`,
      retained = kind !== 'move' && kind !== 'unchanged'
    const bytes = await pdf.save(),
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'paired-stack', surface: 'electron' }),
      original = getDocument({ data: bytes.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generateDetailed(
        {
          id: 'paired-stack',
          data: bytes,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation: translated,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 600, y: 85 / 800, width: 340 / 600, height: 40 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result!.layoutFailures).toEqual(
        retained
          ? [
              {
                unitIndex: 0,
                code: 'unsupported-layout',
                phase: 'planning',
                pageNumbers: [1],
                fragmentCount: 1
              }
            ]
          : []
      )
      target = getDocument({ data: result!.data, useSystemFonts: true })
      const before = (
          await (await (await original.promise).getPage(1)).getTextContent()
        ).items.filter((i) => 'str' in i),
        after = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        ),
        select = (items: typeof before): typeof before =>
          ['c', upper, '2'].map((text) => items.find((i) => i.str.trim() === text)!)
      const a = select(before),
        b = select(after)
      expect(a.every(Boolean) && b.every(Boolean)).toBe(true)
      for (let i = 0; i < 3; i++) {
        expect(b[i].transform.slice(0, 4)).toEqual(a[i].transform.slice(0, 4))
        for (const coordinate of [4, 5])
          expect(b[i].transform[coordinate] - b[0].transform[coordinate]).toBeCloseTo(
            a[i].transform[coordinate] - a[0].transform[coordinate],
            3
          )
      }
      if (kind === 'move') expect(b[0].transform[4]).not.toBe(a[0].transform[4])
      else {
        const snapshot = (items: typeof before): Array<{ text: string; transform: number[] }> =>
          items
            .filter((i) => i.str.trim())
            .map((i) => ({ text: i.str.trim(), transform: i.transform.map((n) => +n.toFixed(3)) }))
        expect(snapshot(after)).toEqual(snapshot(before))
      }
      expect(
        after
          .map((i) => i.str)
          .join('')
          .replace(/\s/gu, '')
      ).toContain((retained ? source : translated).replace(/\s/gu, ''))
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it.each([
  'exact',
  'folded',
  'surrogate-prefix',
  'flat',
  'equal-size',
  'raised',
  'missing-base',
  'wrong-adjacency',
  'distant',
  'far-below',
  'no-vertical-overlap',
  'empty-bounds',
  'nan',
  'duplicate-marker',
  'mixed-source-prefix',
  'mixed-source-suffix',
  'mixed-target-prefix',
  'mixed-target-suffix',
  'ascii-collision',
  'font-collision',
  'extra-target',
  'changed-letter',
  'operator',
  'math-digit',
  'citation',
  'nested',
  'independent-formula'
] as const)('preserves complete native mathematical-letter groups (%s)', (kind) => {
  let source = 'Block 𝐵𝑐 size.',
    translation = '块𝐵𝑐大小。'
  if (kind === 'folded') translation = '块Bc大小。'
  if (kind === 'surrogate-prefix') {
    source = '😀 Block 𝐵𝑐 size.'
    translation = '😀𝐴 条件下的Bc大小。'
  }
  if (kind === 'mixed-source-prefix') source = 'A𝐵𝑐 size.'
  if (kind === 'mixed-source-suffix') source = '𝐵𝑐x size.'
  if (kind === 'mixed-target-prefix') translation = '𝐴Bc'
  if (kind === 'mixed-target-suffix') translation = 'Bc𝒅'
  if (kind === 'ascii-collision') {
    source += ' Bc'
    translation = 'Bc'
  }
  if (kind === 'font-collision') {
    source += ' 𝑩𝒄'
    translation = 'Bc'
  }
  if (kind === 'extra-target') translation = 'Bc和Bc'
  if (kind === 'changed-letter') translation = 'Bd'
  if (kind === 'operator') {
    source = 'Block 𝐵𝛁 size.'
    translation = '𝐵𝛁'
  }
  if (kind === 'math-digit') {
    source = 'Block 𝐵𝟏 size.'
    translation = 'B1'
  }
  if (kind === 'citation') {
    source = 'Reference 𝐵𝑐.'
    translation = '引用Bc。'
  }
  if (kind === 'nested') {
    source = 'Block 𝐵𝑐𝑑.'
    translation = 'Bcd'
  }
  const offset = source.indexOf('𝐵'),
    suffix = [...source.slice(offset)][1],
    markers = [
      {
        label: '𝐵',
        sourceOffset: offset,
        sourceIndices: [10],
        scale: 1,
        rise: 0,
        bounds: [0, 100, 6, 107]
      },
      {
        label: suffix,
        sourceOffset: offset + 2,
        sourceIndices: [11],
        scale: 0.72,
        rise: -1.5,
        bounds: [6.7, 98.5, 10, 102]
      }
    ] satisfies ScientificScriptMarker[]
  if (kind === 'flat') markers[1].rise = 0
  if (kind === 'equal-size') markers[1].scale = 1
  if (kind === 'raised' || kind === 'citation') markers[1].rise = 2
  if (kind === 'wrong-adjacency') markers[1].sourceIndices = [14]
  if (kind === 'distant') markers[1].bounds = [40, 98, 44, 103]
  if (kind === 'far-below') {
    markers[1].rise = -100
    markers[1].bounds = [6.7, 0, 10, 4]
  }
  if (kind === 'no-vertical-overlap') markers[1].bounds = [6.7, 94, 10, 98]
  if (kind === 'empty-bounds') markers[1].bounds = [] as unknown as [number, number, number, number]
  if (kind === 'nan') markers[1].rise = NaN
  if (kind === 'missing-base') markers.shift()
  if (kind === 'duplicate-marker') markers.push({ ...markers[1], sourceIndices: [12] })
  if (kind === 'independent-formula') markers.length = 0
  const groups = resolveNestedScriptGroups(source, translation, markers),
    expected = ['exact', 'folded', 'surrogate-prefix'].includes(kind)
  expect(groups).toHaveLength(expected ? 1 : 0)
  if (expected) {
    const label = kind === 'exact' ? '𝐵𝑐' : 'Bc'
    expect(groups[0]).toEqual({
      sourceOffset: offset,
      targetOffset: translation.indexOf(label),
      label,
      sourceIndices: [10, 11],
      baselineIndex: 10
    })
    expect(source.slice(groups[0].sourceOffset, groups[0].sourceOffset + 4)).toBe('𝐵𝑐')
    expect(translation.slice(groups[0].targetOffset, groups[0].targetOffset + label.length)).toBe(
      label
    )
  }
})

it('maps repeated mathematical identifiers in order without borrowing a missing native group', () => {
  const source = '𝐵𝑐 and 𝐵𝑐',
    translation = '😀Bc与Bc',
    markers: ScientificScriptMarker[] = [0, 9].flatMap((offset, index) => [
      {
        label: '𝐵',
        sourceOffset: offset,
        sourceIndices: [index * 2],
        scale: 1,
        rise: 0,
        bounds: [0, 100, 6, 107]
      },
      {
        label: '𝑐',
        sourceOffset: offset + 2,
        sourceIndices: [index * 2 + 1],
        scale: 0.72,
        rise: -1.5,
        bounds: [6.7, 98.5, 10, 102]
      }
    ])
  expect(resolveNestedScriptGroups(source, translation, markers)).toEqual([
    { sourceOffset: 0, targetOffset: 2, label: 'Bc', sourceIndices: [0, 1], baselineIndex: 0 },
    { sourceOffset: 9, targetOffset: 5, label: 'Bc', sourceIndices: [2, 3], baselineIndex: 2 }
  ])
  expect(resolveNestedScriptGroups(source, translation, markers.slice(2))).toEqual([
    { sourceOffset: 9, targetOffset: 5, label: 'Bc', sourceIndices: [2, 3], baselineIndex: 2 }
  ])
  expect(resolveNestedScriptGroups(source, 'Bc', markers)).toEqual([])
})

it.each([
  ['σ', 17, 100, 10, false],
  [', σ', 17, 100, 10, false],
  ['; x', 17, 100, 10, false],
  [', word', 17, 100, 10, true],
  [', σ', 5, 100, 10, true],
  [', σ', 17, 110, 10, true],
  [', σ', 17, 100, 7, true]
])(
  'distinguishes paired scripts beside a punctuation-prefixed base from a fraction: %s/%s/%s/%s',
  (text, right, baseline, fontSize, fraction) => {
    const items: FractionItem[] = [
      { i: 1, text, fontSize, baseline, bounds: [0, 97, right, 108] },
      { i: 2, text: '2', fontSize: 7, baseline: 104, bounds: [18, 103, 22, 110] },
      { i: 3, text: '1', fontSize: 7, baseline: 96, bounds: [18, 95, 22, 102] }
    ]
    const fractions = resolveInlineFractions(items, 100, 10)
    expect(fractions.map((value) => value.label)).toEqual(fraction ? ['2/1'] : [])
    if (fraction) expect(fractions[0].indices).toEqual([2, 3])
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    expected: Array<{ start: number; end: number; rise?: number; scale?: number }>
    sourceOffsets?: number[]
  }>('scientific-script-identity-and-ambiguity.jsonl')
)('$name', ({ source, translation, markers, expected, sourceOffsets }) => {
  const spans = resolveScientificScriptSpans(source, translation, markers)
  expect(spans).toHaveLength(expected.length)
  expect(spans).toMatchObject(expected)
  if (sourceOffsets) expect(spans[0].sourceOffsets).toEqual(sourceOffsets)
})

it.each([
  {
    name: 'finite numeric alphabet retains its native matrix exponent',
    change: 'none',
    accepted: true
  },
  {
    name: 'finite alphabet dimensions are not restricted to N and D',
    change: 'letters',
    accepted: true
  },
  {
    name: 'single native matrix exponent run keeps its full identity',
    change: 'single',
    accepted: true
  },
  {
    name: 'changed finite alphabet cannot borrow a native exponent',
    change: 'values',
    accepted: false
  },
  {
    name: 'changed dimension cannot borrow a native exponent',
    change: 'dimension',
    accepted: false
  },
  {
    name: 'extra finite-set occurrence cannot borrow one exponent',
    change: 'extra',
    accepted: false
  },
  { name: 'prose in braces is not a finite numeric alphabet', change: 'prose', accepted: false },
  {
    name: 'ordinary closing brace plus letters is not an exponent',
    change: 'not-set',
    accepted: false
  },
  { name: 'flat dimension is not a native raised exponent', change: 'flat', accepted: false },
  {
    name: 'mixed script scales cannot prove one matrix exponent',
    change: 'scale',
    accepted: false
  },
  { name: 'mixed script rises cannot prove one matrix exponent', change: 'rise', accepted: false },
  {
    name: 'raised closing brace cannot prove a body attachment',
    change: 'brace-rise',
    accepted: false
  },
  {
    name: 'small closing brace cannot prove a body attachment',
    change: 'brace-size',
    accepted: false
  },
  {
    name: 'missing closing brace cannot prove a body attachment',
    change: 'missing-brace',
    accepted: false
  },
  {
    name: 'duplicate closing brace cannot prove unique attachment',
    change: 'duplicate-brace',
    accepted: false
  },
  {
    name: 'missing dimension glyph cannot prove a complete exponent',
    change: 'missing',
    accepted: false
  },
  { name: 'unowned dimension glyph cannot prove an exponent', change: 'unowned', accepted: false },
  {
    name: 'shared dimension glyph cannot prove unique ownership',
    change: 'shared',
    accepted: false
  },
  {
    name: 'missing native dimension bounds cannot prove attachment',
    change: 'bounds',
    accepted: false
  },
  {
    name: 'dimension in the next column cannot own this brace',
    change: 'detached',
    accepted: false
  },
  { name: 'overlapping nearby dimension cannot own this brace', change: 'left', accepted: false },
  {
    name: 'baseline dimension bounds cannot prove a raised attachment',
    change: 'baseline',
    accepted: false
  }
])('$name', ({ change, accepted }) => {
  const dimension = change === 'letters' ? 'M×K' : 'N×D',
    source =
      change === 'prose'
        ? `{ab} ${dimension}`
        : change === 'not-set'
          ? `} ${dimension}`
          : `R ∈ {0, 1}${dimension}`,
    translation =
      change === 'values'
        ? `采用 R ∈ {0,2}${dimension}`
        : change === 'dimension'
          ? '采用 R ∈ {0,1}N×K'
          : change === 'extra'
            ? `采用 R ∈ {0,1}${dimension}，R ∈ {0,1}${dimension}`
            : `采用 ${source.replace('0, 1', '0,1')}`,
    offset = source.indexOf(dimension),
    markers: ScientificScriptMarker[] = [
      {
        sourceOffset: source.indexOf('}'),
        label: '}',
        scale: change === 'brace-size' ? 0.7 : 1,
        rise: change === 'brace-rise' ? 3 : 0,
        sourceIndices: [0],
        bounds: [0, -3, 4, 8]
      },
      ...[...dimension].map((label, index): ScientificScriptMarker => ({
        sourceOffset: offset + index,
        label,
        scale: change === 'flat' ? 1 : change === 'scale' && index === 1 ? 0.6 : 0.73,
        rise: change === 'flat' ? 0 : change === 'rise' && index === 1 ? 4.2 : 3.958,
        sourceIndices:
          change === 'unowned' && index === 1
            ? []
            : [change === 'shared' && index === 1 ? 1 : index + 1],
        bounds:
          change === 'bounds' && index === 0
            ? undefined
            : [
                [5, 13.5, 19][index] + (change === 'detached' ? 30 : change === 'left' ? -5 : 0),
                change === 'baseline' ? -3 : 3,
                [12, 17.5, 25][index] + (change === 'detached' ? 30 : change === 'left' ? -5 : 0),
                (index === 1 ? 7.5 : 9) - (change === 'baseline' ? 6 : 0)
              ]
      }))
    ]
  if (change === 'single')
    markers.splice(1, 3, { ...markers[1], label: dimension, bounds: [5, 3, 25, 9] })
  if (change === 'missing-brace') markers.shift()
  if (change === 'duplicate-brace') markers.push({ ...markers[0], sourceIndices: [4] })
  if (change === 'missing') markers.splice(2, 1)
  const spans = resolveScientificScriptSpans(source, translation, markers)
  expect(spans).toHaveLength(accepted ? 1 : 0)
  if (accepted) {
    const start = translation.indexOf(dimension)
    expect(spans[0]).toMatchObject({
      start,
      end: start + dimension.length,
      scale: 0.73,
      rise: 3.958
    })
    expect(spans[0].sourceIndices).toEqual(change === 'single' ? [1] : [1, 2, 3])
  }
})

it.each([
  {
    name: 'spacing hat',
    source: 'At Hˆi.',
    translation: '采用Hˆi。',
    scale: 2 / 3,
    rise: -1,
    accepted: true
  },
  {
    name: 'spacing hat with native space',
    source: 'At Wˆ i.',
    translation: '采用Wˆ i。',
    scale: 2 / 3,
    rise: -1,
    accepted: true
  },
  {
    name: 'combining hat',
    source: 'At H\u0302i.',
    translation: '采用H\u0302i。',
    scale: 2 / 3,
    rise: -1,
    accepted: true
  },
  {
    name: 'changed base',
    source: 'At Hˆi.',
    translation: '采用Wˆi。',
    scale: 2 / 3,
    rise: -1,
    accepted: false
  },
  {
    name: 'changed hat spelling',
    source: 'At Hˆi.',
    translation: '采用H\u0302i。',
    scale: 2 / 3,
    rise: -1,
    accepted: false
  },
  {
    name: 'ordinary baseline',
    source: 'At Hˆi.',
    translation: '采用Hˆi。',
    scale: 1,
    rise: 0,
    accepted: false
  },
  {
    name: 'missing occurrence',
    source: 'At Hˆi and Hˆi.',
    translation: '采用Hˆi。',
    scale: 2 / 3,
    rise: -1,
    accepted: false
  }
])(
  'keeps native subscript ownership after a $name',
  ({ source, translation, scale, rise, accepted }) => {
    const offset = source.indexOf('i'),
      spans = resolveScientificScriptSpans(source, translation, [
        { sourceOffset: offset, label: 'i', scale, rise, sourceIndices: [17] }
      ])
    expect(spans).toEqual(
      accepted
        ? [
            {
              start: translation.indexOf('i'),
              end: translation.indexOf('i') + 1,
              scale,
              rise,
              sourceIndices: [17],
              sourceOffsets: [offset]
            }
          ]
        : []
    )
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    markers: ScientificScriptMarker[]
    expected: number[]
  }>('native-ordinal-suffixes.jsonl')
)('$name', ({ source, markers, expected }) => {
  expect(resolveOrdinalSuffixIndices(source, markers, 12)).toEqual(expected)
})

it.each([
  'extra-occurrence',
  'changed-punctuation',
  'grouped-dimension',
  'raised-matrix-dimension',
  'variable-before-prose-qualifier',
  'named-variable',
  'indexed-expression',
  'multiple-regions',
  'explicit-transpose',
  'parenthesized-coordinate',
  'standalone-parenthesized-index',
  'indexed-range',
  'indicator-predicate',
  'matrix-indicator'
] as const)('generates scientific subscripts from actual PDF objects with %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792])
  const scripted =
    kind === 'variable-before-prose-qualifier'
      ? { prefix: 'd', labels: ['model'] }
      : kind === 'raised-matrix-dimension'
        ? { prefix: 'R', labels: ['K', '×', 'H'] }
        : kind === 'matrix-indicator'
          ? { prefix: 'D', labels: ['1', '[', 'x', '>', '0]'] }
          : kind === 'standalone-parenthesized-index'
            ? { prefix: '', labels: ['(', 'q', ')'] }
            : kind === 'indicator-predicate'
              ? { prefix: 'x1', labels: ['x>', '0'] }
              : kind === 'parenthesized-coordinate'
                ? { prefix: 'x', labels: ['(', 'k', ')'] }
                : kind === 'indexed-range'
                  ? { prefix: 'x', labels: ['1', '...', 'N'] }
                  : kind === 'explicit-transpose'
                    ? { prefix: 'J', labels: ['T'] }
                    : kind === 'grouped-dimension'
                      ? { prefix: 'k', labels: ['2', 'x', '2'] }
                      : kind === 'named-variable'
                        ? { prefix: 'rate', labels: ['q'] }
                        : kind === 'multiple-regions'
                          ? { prefix: 'H', labels: ['j'] }
                          : kind === 'indexed-expression'
                            ? { prefix: 'H', labels: ['j', '-', '2'] }
                            : undefined
  const parts = scripted
    ? [
        { text: 'At ' + scripted.prefix, small: false },
        ...scripted.labels.map((text) => ({ text, small: true })),
        {
          text: kind === 'variable-before-prose-qualifier' ? '-dimensional keys.' : '.',
          small: false
        }
      ]
    : [
        { text: 'At A', small: false },
        { text: kind === 'changed-punctuation' ? '0,' : '0', small: true },
        { text: ' and A', small: false },
        { text: '0', small: true },
        { text: '.', small: false }
      ]
  let x = 40
  for (const part of parts) {
    const size = part.small ? 8 : 12
    page.drawText(part.text, {
      font,
      x,
      y: part.small
        ? [
            'raised-matrix-dimension',
            'explicit-transpose',
            'parenthesized-coordinate',
            'standalone-parenthesized-index'
          ].includes(kind)
          ? 703
          : 697
        : 700,
      size
    })
    x += font.widthOfTextAtSize(part.text, size)
  }
  if (kind === 'multiple-regions') {
    x = 40
    for (const part of parts) {
      const size = part.small ? 8 : 12
      page.drawText(part.text, { font, x, y: part.small ? 647 : 650, size })
      x += font.widthOfTextAtSize(part.text, size)
    }
  }
  const translation =
    kind === 'variable-before-prose-qualifier'
      ? '采用dmodel维度的键。'
      : kind === 'explicit-transpose'
        ? '采用J^T。'
        : kind === 'multiple-regions'
          ? '采用Hj，再Hj。'
          : scripted
            ? '采用' + scripted.prefix + scripted.labels.join('') + '。'
            : kind === 'extra-occurrence'
              ? '先A0，再A0，最后A0。'
              : '先A0，再A0。'
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'script-reader', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'scientific-script',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        preserveUnsupported: true,
        units: [
          {
            source:
              parts.map((part) => part.text).join('') +
              (kind === 'multiple-regions' ? ' ' + parts.map((part) => part.text).join('') : ''),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 75 / 792, width: 280 / 612, height: 45 / 792 }
              },
              ...(kind === 'multiple-regions'
                ? [
                    {
                      pageNumber: 1,
                      rect: { x: 40 / 612, y: 125 / 792, width: 280 / 612, height: 45 / 792 }
                    }
                  ]
                : [])
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const document = await task.promise,
      content = await (await document.getPage(1)).getTextContent(),
      items = content.items.filter((item) => 'str' in item)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    if (kind === 'explicit-transpose') {
      expect(items.some((item) => item.str.includes('J^T'))).toBe(true)
      return
    }
    const digits = items.filter((item) => item.str === (scripted?.labels.join('') ?? '0'))
    expect(digits).toHaveLength(
      kind === 'multiple-regions' ? 2 : scripted ? 1 : kind === 'extra-occurrence' ? 3 : 2
    )
    for (const digit of digits) {
      const identifier = items.find(
        (item) =>
          item.str.endsWith(scripted?.prefix ?? 'A') &&
          Math.abs(item.transform[4] + item.width - digit.transform[4]) < 1
      )
      expect(identifier).toBeDefined()
      expect(digit.transform[3]).toBeLessThan(identifier!.transform[3])
      expect(digit.transform[5]).toBeCloseTo(
        identifier!.transform[5] +
          ([
            'raised-matrix-dimension',
            'parenthesized-coordinate',
            'standalone-parenthesized-index'
          ].includes(kind)
            ? 3
            : -3),
        1
      )
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    expected: number[]
  }>('native-transpose-caret-representation.jsonl')
)('$name', ({ source, translation, markers, expected }) => {
  expect(resolveExplicitTransposeIndices(source, translation, markers)).toEqual(expected)
})

it.each(
  readPdfTranslationCases<{ name: string; translation: string }>(
    'indexed-set-bound-anchor-ownership.jsonl'
  )
)('$name', async ({ translation }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    parts = [
      { text: 'At {x', size: 12, rise: 0 },
      { text: '}', size: 12, rise: 0 },
      { text: 'K', size: 8, rise: 3 },
      { text: 'k', size: 8, rise: -3 },
      { text: '=1', size: 8, rise: -3 },
      { text: '.', size: 12, rise: 0 }
    ]
  let x = 40
  for (const part of parts) {
    page.drawText(part.text, { font, x, y: 700 + part.rise, size: part.size })
    x += font.widthOfTextAtSize(part.text, part.size)
  }
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'indexed-set', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'indexed-set',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'At {x}Kk=1.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 300 / 612, height: 55 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output! })
    const content = await (await (await task.promise).getPage(1)).getTextContent(),
      items = content.items.filter((item) => 'str' in item)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    const upper = items.find((item) => item.str === 'K')!,
      lower = items.find((item) => item.str === 'k=1')!
    expect(upper).toBeDefined()
    expect(lower).toBeDefined()
    expect(upper.transform[5] - lower.transform[5]).toBeCloseTo(6, 1)
    expect(upper.transform[3]).toBeCloseTo(lower.transform[3], 2)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it('keeps native primes and distinct script levels in translated scientific prose', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([612, 792]),
    examples = [
      {
        source: 'At g′(x).',
        translation: '采用g′(x)。',
        parts: [
          { text: 'At g', rise: 0 },
          { text: '′', rise: 3 },
          { text: '(x).', rise: 0 }
        ]
      },
      {
        source: 'At NtrBN.',
        translation: '采用NtrBN。',
        parts: [
          { text: 'At N', rise: 0 },
          { text: 'tr', rise: 3 },
          { text: 'BN', rise: -3 },
          { text: '.', rise: 0 }
        ]
      }
    ]
  for (const [index, example] of examples.entries()) {
    let x = 40
    for (const part of example.parts) {
      const selected = part.text === '′' ? symbol : font,
        size = part.rise ? 8 : 12
      page.drawText(part.text, { font: selected, x, y: 700 - index * 100 + part.rise, size })
      x += selected.widthOfTextAtSize(part.text, size)
    }
  }
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'scientific-levels', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'scientific-levels',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: examples.map((example, index) => ({
          source: example.source,
          translation: example.translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: (72 + index * 100) / 792, width: 300 / 612, height: 55 / 792 }
            }
          ]
        }))
      },
      caller.lease
    )
    task = getDocument({ data: output! })
    const content = await (await (await task.promise).getPage(1)).getTextContent(),
      items = content.items.filter((item) => 'str' in item)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(examples.map((example) => example.translation).join(''))
    const upper = items.find((item) => item.str === 'tr')!,
      lower = items.find((item) => item.str === 'BN')!
    expect(upper).toBeDefined()
    expect(lower).toBeDefined()
    expect(upper.transform[5] - lower.transform[5]).toBeCloseTo(6, 1)
    expect(items.some((item) => item.str === '′')).toBe(true)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    bodySize: number
    expected: number[]
  }>('native-explicit-negative-power.jsonl')
)('$name', ({ source, translation, markers, bodySize, expected }) => {
  expect(resolveExplicitPowerIndices(source, translation, markers, bodySize)).toEqual(expected)
})

it('generates exact explicit negative powers from separately raised native sign and digit', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([612, 792])
  let x = 40
  for (const part of [
    { text: 'Rate 10', font, size: 12, y: 700 },
    { text: '−', font: symbol, size: 8, y: 704 },
    { text: '3', font, size: 8, y: 704 },
    { text: ' is used.', font, size: 12, y: 700 }
  ]) {
    page.drawText(part.text, { font: part.font, x, y: part.y, size: part.size })
    x += part.font.widthOfTextAtSize(part.text, part.size)
  }
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'negative-power', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'negative-power',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'Rate 10⁻³ is used.',
            translation: '采用10^(-3)。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 300 / 612, height: 45 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output! })
    const content = await (await (await task.promise).getPage(1)).getTextContent()
    expect(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe('采用10^(-3)。')
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'nested-script-native-compound.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const { resolveNestedScriptGroups } =
    await import('../../../../resources/pdf-translation/scientific-scripts.mjs')
  const source = 'Apply ABα(j),β(j) now.',
    label = 'ABα(j),β(j)',
    parts = ['AB', 'α', '(', 'j', ')', ',β', '(', 'j', ')']
  let offset = source.indexOf(label)
  const markers = parts.map((text, index) => {
    const low = /^[,αβ]+$/.test(text)
    const marker = {
      sourceOffset: offset,
      label: text,
      sourceIndices: [index],
      scale: index === 0 ? 1 : low ? 0.7 : 0.5,
      rise: index === 0 ? 0 : low ? -2 : change === 'lowered-index' ? -2 : 0.2
    }
    offset += text.length
    return change === 'flat' ? { ...marker, scale: 1, rise: 0 } : marker
  })
  const target =
    change === 'label'
      ? 'ABα(j),γ(j)'
      : change === 'duplicate'
        ? `${label} ${label}`
        : change === 'extended'
          ? `${label}X`
          : label
  const result = resolveNestedScriptGroups(
    source,
    `现在使用 ${target}。`,
    change === 'missing' ? markers.filter((_, i) => i !== 3) : markers
  )
  expect(result).toHaveLength(accepted ? 1 : 0)
  if (accepted)
    expect(result[0]).toMatchObject({
      label,
      sourceOffset: 6,
      targetOffset: 5,
      sourceIndices: parts.map((_, i) => i)
    })
})

it.each([
  { name: 'complete native nested stack', change: 'none', accepted: true },
  { name: 'other native letters use the same stack', change: 'letters', accepted: true },
  { name: 'lower index serialized before upper parameter', change: 'order', accepted: true },
  { name: 'changed stack base is rejected', change: 'base', accepted: false },
  { name: 'changed inner index is rejected', change: 'index', accepted: false },
  { name: 'duplicated target stack is rejected', change: 'duplicate', accepted: false },
  { name: 'embedded target stack is rejected', change: 'extended', accepted: false },
  { name: 'missing source stack object is rejected', change: 'missing', accepted: false },
  { name: 'shared source stack object is rejected', change: 'shared', accepted: false },
  { name: 'flat source letters are not nested scripts', change: 'flat', accepted: false },
  { name: 'inner index below the body is rejected', change: 'inner-baseline', accepted: false },
  { name: 'inner index above its parameter is rejected', change: 'inner-raised', accepted: false },
  { name: 'inner index at the outer size is rejected', change: 'inner-size', accepted: false },
  { name: 'neighboring upper letter is rejected', change: 'upper-position', accepted: false },
  { name: 'neighboring inner index is rejected', change: 'inner-position', accepted: false },
  { name: 'neighboring lower index is rejected', change: 'lower-position', accepted: false },
  { name: 'stack without native bounds is rejected', change: 'bounds', accepted: false }
])('$name', ({ change, accepted }) => {
  const label = change === 'letters' ? 'GMjk' : change === 'order' ? 'FiLi' : 'FLii',
    order = change === 'order' ? [0, 3, 1, 2] : [0, 1, 2, 3],
    styles = [
      { scale: 1, rise: 0, bounds: [0, 0, 8.1, 7.2] },
      { scale: 0.7, rise: 4.43, bounds: [8.46, 4.74, 13.01, 9.5] },
      { scale: 0.5, rise: 3.43, bounds: [13.9, 3.69, 15.65, 7.06] },
      { scale: 0.7, rise: -2.78, bounds: [7.32, -2.53, 9.43, 2.15] }
    ],
    markers: ScientificScriptMarker[] = order.map((styleIndex, index) => ({
      sourceOffset: 4 + index,
      label: label[index],
      scale: change === 'flat' ? 1 : styles[styleIndex].scale,
      rise:
        change === 'flat'
          ? 0
          : styleIndex === 2 && change === 'inner-baseline'
            ? -1
            : styleIndex === 2 && change === 'inner-raised'
              ? 5
              : styles[styleIndex].rise,
      sourceIndices: [change === 'shared' && styleIndex === 2 ? 1 : styleIndex],
      ...(change === 'bounds'
        ? {}
        : { bounds: styles[styleIndex].bounds as [number, number, number, number] })
    }))
  if (change === 'inner-size') markers[2] = { ...markers[2], scale: 0.7 }
  for (const [kind, index] of [
    ['upper-position', 1],
    ['inner-position', 2],
    ['lower-position', 3]
  ] as const)
    if (change === kind) markers[index] = { ...markers[index], bounds: [40, 5, 44, 8] }
  const target =
      change === 'base'
        ? 'GLii'
        : change === 'index'
          ? 'FLji'
          : change === 'duplicate'
            ? `${label}和${label}`
            : change === 'extended'
              ? `X${label}`
              : label,
    groups = resolveNestedScriptGroups(
      `Use ${label} now.`,
      `采用${target}。`,
      change === 'missing' ? markers.filter((_, index) => index !== 2) : markers
    )
  expect(groups).toHaveLength(accepted ? 1 : 0)
  if (accepted)
    expect(groups[0]).toEqual({
      sourceOffset: 4,
      targetOffset: 2,
      label,
      sourceIndices: order
    })
})

it.each([
  { change: 'none', accepted: true },
  { change: 'flat', accepted: true },
  { change: 'neighbor', accepted: false },
  { change: 'duplicate', accepted: false }
])('native nested stack preserves every level: $change', async ({ change, accepted }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([612, 792]),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'nested-stack', surface: 'electron' })
  page.drawText('Use ', { font, size: 12, x: 40, y: 700 })
  const x = 40 + font.widthOfTextAtSize('Use ', 12),
    upperX = x + font.widthOfTextAtSize('F', 12)
  page.drawText('F', { font, size: 12, x, y: 700 })
  page.drawText('L', {
    font,
    size: change === 'flat' ? 12 : 8,
    x: upperX,
    y: change === 'flat' ? 700 : 704
  })
  page.drawText('i', {
    font,
    size: change === 'flat' ? 12 : 6,
    x:
      change === 'neighbor'
        ? upperX + 40
        : upperX + font.widthOfTextAtSize('L', change === 'flat' ? 12 : 8),
    y: change === 'flat' ? 700 : 703
  })
  page.drawText('i', {
    font,
    size: change === 'flat' ? 12 : 8,
    x: change === 'flat' ? upperX + font.widthOfTextAtSize('Li', 12) : upperX,
    y: change === 'flat' ? 700 : 697
  })
  page.drawText(' now.', { font, size: 12, x: upperX + 50, y: 700 })
  const source = 'Use FLii now.',
    translation = change === 'duplicate' ? '采用FLii和FLii。' : '采用FLii。'
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const bytes = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'nested-stack',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        preserveUnsupported: true,
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 75 / 792, width: 250 / 612, height: 30 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: bytes! })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe((accepted ? translation : source).replace(/\s/gu, ''))
    if (accepted && change !== 'flat') {
      const base = items.find((item) => item.str === 'F')!,
        upper = items.find((item) => item.str === 'L')!,
        inner = items.find((item) => item.str === 'i' && Math.abs(item.transform[3] - 6) < 0.01)!,
        lower = items.find((item) => item.str === 'i' && Math.abs(item.transform[3] - 8) < 0.01)!
      expect(base.transform[3]).toBeCloseTo(12, 3)
      expect(upper.transform[3]).toBeCloseTo(8, 3)
      expect(inner.transform[5] - base.transform[5]).toBeCloseTo(3, 3)
      expect(upper.transform[5] - base.transform[5]).toBeCloseTo(4, 3)
      expect(lower.transform[5] - base.transform[5]).toBeCloseTo(-3, 3)
      expect(inner.transform[4] - upper.transform[4]).toBeCloseTo(font.widthOfTextAtSize('L', 8), 3)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    expected: number[]
    native?: boolean
  }>('native-ordinal-suffixes.jsonl').filter((record) => record.native)
)(
  'native ordinal translation and unchanged fallback: $name',
  async ({ source, translation, markers, expected }) => {
    const suffix = markers[1]
    for (const targetText of [translation, source]) {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.addPage([612, 792]),
        registry = new ApplicationCallerLeaseRegistry(),
        caller = registry.acquire({ leaseId: 'ordinal-reader', surface: 'electron' })
      const before = source.slice(0, suffix.sourceOffset),
        after = source.slice(suffix.sourceOffset + suffix.label.length)
      page.drawText(before, { font, size: 12, x: 40, y: 700 })
      const x = 40 + font.widthOfTextAtSize(before, 12)
      page.drawText(suffix.label, { font, size: 12 * suffix.scale, x, y: 700 + suffix.rise })
      page.drawText(after, {
        font,
        size: 12,
        x: x + font.widthOfTextAtSize(suffix.label, 12 * suffix.scale),
        y: 700
      })
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const bytes = await new PdfTranslationWriter(() =>
          resolve('resources/pdf-translation/worker.mjs')
        ).generate(
          {
            id: 'ordinal',
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            preserveUnsupported: true,
            units: [
              {
                source,
                translation: targetText,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 75 / 792, width: 400 / 612, height: 25 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        task = getDocument({ data: bytes!, useSystemFonts: true })
        const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        )
        const retained = !expected.length || targetText === source
        expect(
          items
            .map((i) => i.str)
            .join('')
            .replace(/\s/gu, '')
        ).toBe((retained ? source : targetText).replace(/\s/gu, ''))
        if (retained) {
          const originalSuffix = items.find((i) => i.str === suffix.label)!
          expect(originalSuffix.transform[0]).toBeCloseTo(12 * suffix.scale, 4)
          expect(originalSuffix.transform[5]).toBeCloseTo(700 + suffix.rise, 4)
        }
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    base: string
    upper: string
    lower: string
    translation: string
    accepted: boolean
    lead?: string
  }>('native-paired-script-reflow.jsonl')
)('$name', async ({ base, upper, lower, translation, accepted, lead }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    leadingPage = lead ? pdf.addPage([612, 792]) : undefined,
    page = pdf.addPage([612, 792]),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'paired-scripts', surface: 'electron' }),
    source = `${lead ? lead + ' ' : ''}Value ${base}${upper}${lower} is stable.`,
    prefix = `Value ${base}`,
    x = 40 + font.widthOfTextAtSize(prefix, 12)
  if (lead) leadingPage!.drawText(lead, { font, size: 12, x: 40, y: 700 })
  if (lower === '⊥') {
    page.drawText('Value ', { font, size: 12, x: 40, y: 700 })
    page.drawText(base, { font, size: 12, x: 40 + font.widthOfTextAtSize('Value ', 12), y: 700 })
  } else page.drawText(prefix, { font, size: 12, x: 40, y: 700 })
  page.drawText(upper, { font, size: 8, x, y: 704 })
  const lowerFont = lower === '⊥' ? await pdf.embedFont(StandardFonts.Symbol) : font
  page.drawText(lower, { font: lowerFont, size: 8, x, y: 697 })
  page.drawText(' is stable.', {
    font,
    size: 12,
    x: x + Math.max(8, font.widthOfTextAtSize(upper, 8), lowerFont.widthOfTextAtSize(lower, 8)),
    y: 700
  })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const bytes = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'paired-scripts',
        data: await pdf.save(),
        pages: pdf.getPages().map(() => ({ width: 612, height: 792 })),
        preserveUnsupported: true,
        units: [
          {
            source,
            translation,
            fragments: [
              ...(lead
                ? [
                    {
                      pageNumber: 1,
                      rect: { x: 40 / 612, y: 75 / 792, width: 400 / 612, height: 25 / 792 }
                    }
                  ]
                : []),
              {
                pageNumber: lead ? 2 : 1,
                rect: { x: 40 / 612, y: 75 / 792, width: 400 / 612, height: 25 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: bytes!, useSystemFonts: true })
    const document = await task.promise,
      items = (await (await document.getPage(lead ? 2 : 1)).getTextContent()).items.filter(
        (i) => 'str' in i
      ),
      leadingText = lead
        ? (await (await document.getPage(1)).getTextContent()).items
            .flatMap((i) => ('str' in i ? [i.str] : []))
            .join('')
        : ''
    if (lead && accepted) expect(leadingText).not.toContain(base + upper + lower)
    expect((leadingText + items.map((i) => i.str).join('')).replace(/\s/gu, '')).toBe(
      (accepted ? translation.replace('²', '2') : source).replace(/\s/gu, '')
    )
    const above = items.find((i) => i.str === upper)!,
      below = items.find((i) => i.str === lower)!,
      body = items.find((i) => i.str.endsWith(base))!
    expect(above.transform[3]).toBeCloseTo(8, 3)
    expect(below.transform[3]).toBeCloseTo(8, 3)
    expect(above.transform[5] - body.transform[5]).toBeCloseTo(4, 1)
    expect(below.transform[5] - body.transform[5]).toBeCloseTo(-3, 1)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    expected: number[]
  }>('native-asymptotic-power-notation.jsonl')
)('$name', ({ source, translation, markers, expected }) => {
  expect(resolveExplicitPowerIndices(source, translation, markers, 12)).toEqual(expected)
})

it.each(
  readPdfTranslationCases<{ name: string; translation: string; raised: boolean; matched: boolean }>(
    'compact-slashed-derivative.jsonl'
  )
)('$name', async ({ translation, raised, matched }) => {
  const source = 'The derivative ∂g/∂zj−2 remains bounded.',
    prefix = 'The derivative ',
    labels = ['∂', 'g', '/', '∂', 'z', 'j', '−', '2']
  let offset = prefix.length
  const markers = labels.map((label, index) => {
    const marker = {
      sourceOffset: offset,
      label,
      sourceIndices: [index],
      scale: index === 2 ? 1 : index >= 5 ? 5.5 / 12 : 8 / 12,
      rise: index < 2 && raised ? 3 : index >= 5 ? -2 : 0
    }
    offset += label.length
    return marker
  })
  const groups = resolveNestedScriptGroups(source, translation, markers)
  expect(groups).toHaveLength(matched ? 1 : 0)
  if (!matched) return
  expect(groups[0]).toMatchObject({ baselineIndex: 2, sourceIndices: labels.map((_, i) => i) })
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([612, 792]),
    caller = new ApplicationCallerLeaseRegistry().acquire({
      leaseId: 'derivative',
      surface: 'electron'
    })
  page.drawText(prefix, { font, x: 40, y: 700, size: 12 })
  let x = 40 + font.widthOfTextAtSize(prefix, 12)
  for (const marker of markers) {
    const face = /[∂−]/u.test(marker.label) ? symbol : font,
      size = marker.scale * 12
    page.drawText(marker.label, { font: face, x, y: 700 + marker.rise, size })
    x += face.widthOfTextAtSize(marker.label, size)
  }
  page.drawText(' remains bounded.', { font, x, y: 700, size: 12 })
  let output: ReturnType<typeof getDocument> | undefined
  try {
    const bytes = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'slashed-derivative',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 77 / 792, width: 350 / 612, height: 25 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    output = getDocument({ data: bytes!, useSystemFonts: true })
    const items = (await (await (await output.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    const numerator = items.find((item) => item.str === 'g')!,
      slash = items.find((item) => item.str === '/')!,
      denominator = items.find((item) => item.str === 'z')!
    expect(numerator.transform[5] - slash.transform[5]).toBeCloseTo(3, 3)
    expect(denominator.transform[5]).toBeCloseTo(slash.transform[5], 3)
    expect(numerator.height).toBeCloseTo(8, 3)
  } finally {
    await output?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; translation: string; valid: boolean }>(
    'native-signed-unit-power-reflow.jsonl'
  )
)('$name', async ({ translation, valid }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([612, 792])
  let x = 40
  for (const part of [
    { text: 'Rate kg', small: false },
    { text: '−', small: true },
    { text: '1', small: true },
    { text: ' and min ', small: false },
    { text: '−', small: true },
    { text: ' ', small: true },
    { text: '1', small: true },
    { text: ' and h', small: false },
    { text: '−', small: true },
    { text: '1', small: true },
    { text: '.', small: false }
  ]) {
    const face = part.text === '−' ? symbol : font,
      size = part.small ? 8 : 12
    page.drawText(part.text, { font: face, size, x, y: part.small ? 704 : 700 })
    x += face.widthOfTextAtSize(part.text, size)
  }
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'unit-powers', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    const promise = writer.generate(
      {
        id: 'unit-powers',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'Rate kg−1 and min −1 and h−1.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 300 / 612, height: 45 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!valid) {
      await expect(promise).rejects.toMatchObject({ failure: { code: 'annotations' } })
      return
    }
    task = getDocument({ data: (await promise)! })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    const raised = items.filter((item) => /^[−1]+$/u.test(item.str))
    expect(
      raised
        .map((item) => item.str)
        .join('')
        .split('−')
    ).toHaveLength(4)
    expect(
      raised
        .map((item) => item.str)
        .join('')
        .split('1')
    ).toHaveLength(4)
    for (const item of raised) {
      expect(item.transform[3]).toBe(8)
      expect(item.transform[5]).toBeGreaterThan(700)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each([false, true])(
  'retains a native significance marker and rejects duplication: %s',
  async (duplicate) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792])
    page.drawText('Caption ', { font, size: 12, x: 40, y: 700 })
    const x = 40 + font.widthOfTextAtSize('Caption ', 12)
    page.drawText('#', { font, size: 8, x, y: 704 })
    page.drawText('P < 0.05 compared with T0.', {
      font,
      size: 12,
      x: x + font.widthOfTextAtSize('#', 8),
      y: 700
    })
    const registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'significance', surface: 'electron' })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const translation = duplicate ? '图注#P < 0.05，与T0相比#。' : '图注#P < 0.05，与T0相比。'
      const promise = new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generate(
        {
          id: 'significance',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source: 'Caption #P < 0.05 compared with T0.',
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 72 / 792, width: 300 / 612, height: 45 / 792 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (duplicate) {
        await expect(promise).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      task = getDocument({ data: (await promise)! })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
        (item) => 'str' in item
      )
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation.replace(/\s/gu, ''))
      expect(items.find((item) => item.str === '#')).toMatchObject({
        transform: [8, 0, 0, 8, expect.any(Number), 704]
      })
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

// Native script size/baseline and exact target identity still own the entire
// dimension; admitting × does not make changed operators or prose scripts safe.
it.each([
  { name: 'unchanged matrix dimension', translation: '采用RK×H。', styles: [3, 3, 3], expected: 1 },
  { name: 'changed dimension operator', translation: '采用RK+H。', styles: [3, 3, 3], expected: 0 },
  { name: 'missing dimension operand', translation: '采用RK×。', styles: [3, 3, 3], expected: 0 },
  { name: 'ordinary baseline operands', translation: '采用RK×H。', styles: [0, 0, 0], expected: 0 },
  { name: 'mixed script baselines', translation: '采用RK×H。', styles: [3, -3, 3], expected: 0 }
])('$name', ({ translation, styles, expected }) => {
  const spans = resolveScientificScriptSpans('At RK×H.', translation, [
    { label: 'R', sourceOffset: 3, sourceIndices: [1], scale: 1, rise: 0 },
    ...['K', '×', 'H'].map((label, i) => ({
      label,
      sourceOffset: 4 + i,
      sourceIndices: [2 + i],
      scale: 2 / 3,
      rise: styles[i]
    }))
  ])
  expect(spans.filter((span) => span.sourceIndices.length === 3)).toHaveLength(expected)
})

it.each([
  {
    name: 'lowered variable before translated prose qualifier',
    source: 'Use dmodel-dimensional keys.',
    target: '采用dmodel维度的键。',
    rise: -2,
    expected: 1
  },
  {
    name: 'changed variable before prose qualifier',
    source: 'Use dmodel-dimensional keys.',
    target: '采用dother维度的键。',
    rise: -2,
    expected: 0
  },
  {
    name: 'ordinary hyphenated word has no script identity',
    source: 'Use dmodel-dimensional keys.',
    target: '采用dmodel维度的键。',
    rise: 0,
    expected: 0
  },
  {
    name: 'raised ordinary suffix is not a scientific identifier',
    source: 'Use graphbased-dimensional keys.',
    target: '采用graphbased维度的键。',
    rise: 2,
    expected: 0
  }
])('$name', ({ source, target, rise, expected }) => {
  const prefix = source.startsWith('Use graph') ? 'graph' : 'd',
    suffix = source.startsWith('Use graph') ? 'based' : 'model'
  expect(
    resolveScientificScriptSpans(source, target, [
      { label: 'Use ' + prefix, sourceOffset: 0, sourceIndices: [1], scale: 1, rise: 0 },
      { label: suffix, sourceOffset: 4 + prefix.length, sourceIndices: [2], scale: 0.7, rise }
    ])
  ).toHaveLength(expected)
})

it.each([
  { name: 'keeps a raised symbol in its original font', target: '♦', copies: 1, accepted: true },
  {
    name: 'does not replace a raised symbol with another',
    target: '♥',
    copies: 1,
    accepted: false
  },
  { name: 'does not drop a raised symbol', target: '', copies: 1, accepted: false },
  { name: 'does not duplicate one raised symbol', target: '♦♦', copies: 1, accepted: false },
  { name: 'keeps repeated unchanged raised symbols', target: '♦♦', copies: 2, accepted: true },
  { name: 'does not omit one of two raised symbols', target: '♦', copies: 2, accepted: false }
])('$name', async ({ target, copies, accepted }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([612, 792])
  page.drawText('Comparison results on', { font, size: 12, x: 40, y: 714 })
  page.drawText('WikiText. ', { font, size: 12, x: 40, y: 700 })
  let x = 40 + font.widthOfTextAtSize('WikiText. ', 12)
  for (let copy = 0; copy < copies; copy++) {
    page.drawText('♦', { font: symbol, size: 8, x, y: 704 })
    x += symbol.widthOfTextAtSize('♦', 8)
  }
  page.drawText(' indicates contemporary work.', { font, size: 12, x, y: 700 })
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'raised-caption-symbol', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      translation = `WikiText比较结果，${target}表示同时期工作。`,
      promise = writer.generate(
        {
          id: 'raised-caption-symbol',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source: `Comparison results on WikiText. ${'♦'.repeat(copies)} indicates contemporary work.`,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 64 / 792, width: 280 / 612, height: 40 / 792 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
    if (!accepted) {
      await expect(promise).rejects.toMatchObject({ failure: { code: 'annotations' } })
      return
    }
    task = getDocument({ data: (await promise)!, useSystemFonts: true })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    const symbols = items.filter((item) => item.str.includes('♦'))
    expect(
      symbols
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe('♦'.repeat(copies))
    for (const item of symbols) {
      expect(item.height).toBeCloseTo(8, 3)
      expect(item.transform[5]).toBeGreaterThan(700)
    }
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(['4', '16', '128', '1024'])(
  'centered small letter-over-integer tiers preserve their complete fraction: %s',
  (denominator) => {
    const items: FractionItem[] = [
      { i: 1, text: 'H', fontSize: 7, baseline: 104, bounds: [20, 103, 27, 110] },
      { i: 2, text: denominator, fontSize: 7, baseline: 96, bounds: [20, 95, 27, 102] }
    ]
    expect(resolveInlineFractions(items, 100, 10).map((value) => value.label)).toEqual([
      'H/' + denominator
    ])
  }
)

it.each([
  'body-size',
  'not-centered',
  'same-tier',
  'long-denominator',
  'numeric-expression',
  'competing-denominators',
  'adjacent-scripts',
  'intervening-native-item',
  'reversed-native-order'
])(
  'letter-over-integer resolution retains fraction geometry and grammar safeguards: %s',
  (fault) => {
    const items: FractionItem[] = [
      { i: 1, text: 'H', fontSize: 7, baseline: 104, bounds: [20, 103, 27, 110] },
      { i: 2, text: '4', fontSize: 7, baseline: 96, bounds: [20, 95, 27, 102] }
    ]
    if (fault === 'body-size') items[0].fontSize = items[1].fontSize = 10
    if (fault === 'not-centered') items[1].bounds = [30, 95, 37, 102]
    if (fault === 'same-tier') items[1].baseline = 104
    if (fault === 'long-denominator') items[1].text = '10000'
    if (fault === 'numeric-expression') items[1].text = '4+1'
    if (fault === 'competing-denominators')
      items.push({ i: 3, text: '8', fontSize: 7, baseline: 97, bounds: [20, 96, 27, 103] })
    if (fault === 'adjacent-scripts')
      items.unshift({ i: 0, text: 'x', fontSize: 10, baseline: 100, bounds: [10, 97, 19, 108] })
    if (fault === 'intervening-native-item') {
      items[1].i = 3
      items.push({
        i: 2,
        text: 'intervening',
        fontSize: 10,
        baseline: 100,
        bounds: [40, 97, 90, 108]
      })
    }
    if (fault === 'reversed-native-order') items[1].i = 0
    expect(resolveInlineFractions(items, 100, 10)).toEqual([])
  }
)

it.each([
  'norm',
  'no-opener',
  'mismatched-opener',
  'distant-opener',
  'raised-opener',
  'no-variable'
])('paired norm scripts do not become a fraction without changing genuine tiers: %s', (variant) => {
  const { page } = readPdfTranslationCases<{
    page: { items: Array<{ str: string; width: number; transform: number[] }> }
  }>('norm-script-native-body.jsonl')[0]
  const items: FractionItem[] = page.items.map((item, i) => {
    const [fontSize, , , , x, y] = item.transform
    return {
      i,
      text: item.str,
      fontSize,
      baseline: y,
      bounds: [x, y - fontSize * 0.25, x + item.width, y + fontSize * 0.8]
    }
  })
  const opener = items.find((item) => item.text === '‖')!
  if (variant === 'no-opener') opener.text = ''
  if (variant === 'mismatched-opener') opener.text = '|'
  if (variant === 'distant-opener') {
    opener.bounds[0] -= 50
    opener.bounds[2] -= 50
  }
  if (variant === 'raised-opener') opener.baseline += 10
  if (variant === 'no-variable') items.find((item) => item.text === 'w')!.text = '+'
  const base = items.find((item) => item.text === 'λ')!
  expect(
    resolveInlineFractions(items, base.baseline, base.fontSize).map((value) => value.label)
  ).toEqual(variant === 'norm' ? [] : ['2/2'])
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    markers: ScientificScriptMarker[]
    bodySize: number
    expected: number[]
  }>('native-unicode-negative-power.jsonl').concat(
    readPdfTranslationCases('shared-prose-negative-power.jsonl')
  )
)(
  'proves complete unchanged Unicode negative powers: $name',
  ({ source, translation, markers, bodySize, expected }) => {
    expect(resolveExplicitPowerIndices(source, translation, markers, bodySize)).toEqual(expected)
    if (expected.length) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const changed = structuredClone(markers)
        changed[1] = { ...changed[1], rise: value }
        expect(resolveExplicitPowerIndices(source, translation, changed, bodySize)).toEqual([])
      }
    }
  }
)
