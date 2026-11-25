import { nativeMathSymbolText } from '../resources/math-symbols.mjs'
import { expect, it } from 'vitest'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { resolveNativeMathAccents, type NativeMathObject } from '../resources/math-accents.mjs'

it.each([
  { name: 'native extension-font tilde keeps its bold variable', change: 'none', accepted: true },
  { name: 'subset extension-font tilde keeps its variable', change: 'subset', accepted: true },
  { name: 'ordinary e is not a native tilde', change: 'prose', accepted: false },
  { name: 'different extension-font name cannot prove a tilde', change: 'font', accepted: false },
  { name: 'multi-letter extension object cannot prove a tilde', change: 'text', accepted: false },
  { name: 'native inline e is not a raised accent', change: 'inline', accepted: false },
  { name: 'detached variable cannot own a tilde', change: 'detached', accepted: false },
  { name: 'duplicate variables cannot own one tilde', change: 'duplicate', accepted: false },
  { name: 'missing variable cannot prove a tilde', change: 'missing', accepted: false },
  {
    name: 'ordinary prose letter cannot own an extension accent',
    change: 'base-font',
    accepted: false
  },
  { name: 'tall extension object is not an accent', change: 'tall', accepted: false },
  { name: 'changed native encoding is not a tilde', change: 'encoding', accepted: false }
])('$name', ({ change, accepted }) => {
  const objects: NativeMathObject[] = [
    {
      i: 1,
      text: change === 'text' ? 'ee' : change === 'encoding' ? 'f' : 'e ',
      fontName:
        change === 'subset'
          ? 'ABCDEF+CMEX10'
          : change === 'prose'
            ? 'Times-Roman'
            : change === 'font'
              ? 'OtherCMEX10'
              : 'CMEX10',
      bounds:
        change === 'inline'
          ? [1.31527, 0, 7.36981, 1.24365]
          : change === 'tall'
            ? [1.31527, 6.81744, 7.36981, 12]
            : [1.31527, 6.81744, 7.36981, 8.0611]
    },
    {
      i: 2,
      text: 'w',
      fontName: change === 'base-font' ? 'Times-Roman' : 'CMBX10',
      bounds: change === 'detached' ? [20, 0, 28.5091, 4.87634] : [0, 0, 8.5091, 4.87634]
    }
  ]
  if (change === 'missing') objects.pop()
  if (change === 'duplicate') objects.push({ ...objects[1], i: 3 })
  const result = resolveNativeMathAccents(objects)
  expect(result).toHaveLength(accepted ? 1 : 0)
  if (accepted)
    expect(result[0]).toMatchObject({ indices: [1, 2], label: 'w˜', labels: ['w˜', '˜w'] })
})

it.each([
  { name: 'native calligraphic F hat', change: 'none', accepted: true },
  { name: 'subset native calligraphic F hat', change: 'subset', accepted: true },
  { name: 'ordinary F is not a math-font anchor', change: 'prose', accepted: false },
  { name: 'nearby calligraphic F does not own the hat', change: 'detached', accepted: false },
  { name: 'ambiguous calligraphic bases do not own a hat', change: 'duplicate', accepted: false },
  { name: 'missing complete calligraphic letter', change: 'incomplete', accepted: false },
  { name: 'an inline mark is not a raised calligraphic hat', change: 'inline', accepted: false },
  { name: 'an unsupported symbol-font name is not CMSY', change: 'font', accepted: false }
])('$name', ({ change, accepted }) => {
  const objects: NativeMathObject[] = [
    {
      i: 1,
      text: 'ˆ',
      fontName: 'CMR10',
      bounds: change === 'inline' ? [3.68, 1.2, 6.34, 2.74] : [3.68, 8.21, 6.34, 9.74]
    },
    {
      i: 2,
      text: change === 'incomplete' ? 'F,' : 'F',
      fontName:
        change === 'subset'
          ? 'ABCDEF+CMSY10'
          : change === 'prose'
            ? 'Helvetica'
            : change === 'font'
              ? 'OtherCMSY10'
              : 'CMSY10',
      bounds: change === 'detached' ? [20, 0, 28.1, 7.19] : [0, 0, 8.1, 7.19]
    }
  ]
  if (change === 'duplicate') objects.push({ ...objects[1], i: 3 })
  const result = resolveNativeMathAccents(objects)
  expect(result).toHaveLength(accepted ? 1 : 0)
  if (accepted) expect(result[0]).toMatchObject({ indices: [1, 2], label: 'Fˆ' })
})

it.each([false, true])(
  'proves a native dot above one Greek math letter (detached=%s)',
  (detached) => {
    const base: NativeMathObject = {
      i: 2,
      text: 'θ',
      fontName: 'CMMI10',
      size: 10,
      bounds: [0, 0, 5.6, 6.4]
    }
    const mark: NativeMathObject = {
      i: 1,
      text: '˙',
      fontName: 'CMR10',
      size: 10,
      bounds: detached ? [7, 7.6, 8.1, 8.7] : [2.5, 7.6, 3.6, 8.7]
    }
    expect(resolveNativeMathAccents([mark, base])).toMatchObject(
      detached ? [] : [{ indices: [1, 2], labels: ['θ˙', '˙θ'] }]
    )
  }
)

it.each(
  ['native-math-accent-geometry.jsonl', 'native-short-macron.jsonl'].flatMap((file) =>
    readPdfTranslationCases<{
      name: string
      objects: NativeMathObject[]
      expected: Array<{ indices: number[]; label: string }>
    }>(file)
  )
)('$name', ({ objects, expected }) => {
  const result = resolveNativeMathAccents(objects)
  expect(result).toHaveLength(expected.length)
  expect(result).toMatchObject(expected)
})

it.each(
  readPdfTranslationCases<{
    name: string
    font: string
    text: string
    bounds: [number, number, number, number]
    expected: string
  }>('native-math-delimiter-encoding.jsonl')
)('$name', ({ font, text, bounds, expected }) => {
  expect(nativeMathSymbolText({ text, bounds }, font)).toBe(expected)
})

it('resolves the Planck constant only with matching native ink and source intent', () => {
  const glyph = { text: '~', bounds: [0, 0, 5.9, 8.4] as [number, number, number, number] }
  expect(nativeMathSymbolText(glyph, 'MSBM10', true)).toBe('ℏ')
  expect(nativeMathSymbolText(glyph, 'MSBM10')).toBe('~')
  expect(nativeMathSymbolText(glyph, 'OtherMath10', true)).toBe('~')
  expect(nativeMathSymbolText({ text: '~', bounds: [0, 0, 5.9, 1.8] }, 'MSBM10', true)).toBe('~')
})

it.each([
  { name: 'native adjacent tilde', change: 'none', accepted: true },
  { name: 'intervening object', change: 'sequence', accepted: false },
  { name: 'different native font', change: 'font', accepted: false },
  { name: 'different point size', change: 'size', accepted: false },
  { name: 'detached mark', change: 'geometry', accepted: false },
  { name: 'missing native character bounds', change: 'glyph', accepted: false }
])(
  'admits a raised tilde after a fused equality only with native proof: $name',
  ({ change, accepted }) => {
    const mark: NativeMathObject = {
      i: 4,
      text: '˜ ',
      fontName: change === 'font' ? 'CMR9' : 'CMR10',
      size: change === 'size' ? 9 : 10,
      bounds: change === 'geometry' ? [11, 8, 14.4, 9] : [1.8, 8, 5.2, 9]
    }
    const base: NativeMathObject = {
      i: change === 'sequence' ? 6 : 5,
      text: 'Γ =',
      fontName: 'CMR10',
      size: 10,
      bounds: [0, 0, 17, 6.8],
      glyphs: change === 'glyph' ? undefined : [{ text: 'Γ', offset: 0, bounds: [0, 0, 6.8, 6.8] }]
    }

    expect(resolveNativeMathAccents([mark, base])[0]?.labels.includes('Γ =˜') ?? false).toBe(
      accepted
    )
  }
)
