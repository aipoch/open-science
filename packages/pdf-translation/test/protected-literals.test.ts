import { expect, it } from 'vitest'
import {
  pdfTranslationMissingProtectedLiterals,
  pdfTranslationProtectInlineFormulas,
  pdfTranslationWrittenNumericLiterals
} from '../src/protected-literals.js'

it.each<[string, string[]]>([
  ['2D-to-3D lifting', ['2', '3']],
  ['3D-to-2D projection', ['3', '2']],
  ['x-3', ['-3']],
  ['-3', ['-3']],
  ['−3', ['−3']],
  ['A2D-to-3D', ['2', '-3']],
  ['-2D-to-3D', ['-2', '-3']],
  ['2D-to--3D', ['2', '-3']],
  ['2D-to-−3D', ['2', '−3']],
  ['2D-to-3DNA', ['2', '-3']],
  ['2D-to-3Dα', ['2', '-3']],
  ['2D-to-3D²', ['2', '-3', '²']],
  ['1.2D-to-3D', ['1.2', '-3']],
  ['1/2D-to-3D', ['1', '2', '-3']]
])('distinguishes a dimensional transition from a signed literal: %s', (source, expected) => {
  expect(pdfTranslationWrittenNumericLiterals(source)).toEqual(expected)
})

it('preserves every dimensional occurrence without treating the connector as a negative sign', () => {
  expect(
    pdfTranslationMissingProtectedLiterals('Use 2D-to-3D and 3D-to-2D.', '使用2D到3D和3D到2D。')
  ).toEqual([])
  expect(pdfTranslationMissingProtectedLiterals('Use x-3.', '使用x3。')).toContain('-3')
  expect(pdfTranslationMissingProtectedLiterals('Use −3.', '使用3。')).toContain('−3')
})

it('protects formulas next to literal placeholder text and skips occupied namespaces', () => {
  const literal = '⟦PDFMATHA⟧ ⟦PDFMATHZAZA⟧',
    source = `${literal} accompanies [2, 5]m and ℓ∞.`
  const protectedMath = pdfTranslationProtectInlineFormulas(source)
  expect(protectedMath?.source).toBe(`${literal} accompanies ⟦PDFMATHZBZA⟧ and ⟦PDFMATHZBZB⟧.`)
  expect(protectedMath?.restore(`${literal} 对应 ⟦PDFMATHZBZA⟧ 和 ⟦PDFMATHZBZB⟧。`)).toBe(
    `${literal} 对应 [2, 5]m 和 ℓ∞。`
  )
  expect(protectedMath?.restore(`${literal} 对应 ⟦PDFMATHZBZA⟧。`)).toBe('')
})
