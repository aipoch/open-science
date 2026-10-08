import { expect, it } from 'vitest'
import { nativeTransposeSourceIndices } from '../../../../resources/pdf-translation/math-symbols.mjs'

// RoFormer 2104.09864v1 page 3: PDFium reads the MSAM7 raised T as '|'.
const objects: Parameters<typeof nativeTransposeSourceIndices>[0] = [
  {
    i: 404,
    text: 'q',
    fontName: 'CMMIB10',
    size: 9.9626,
    baseline: 82.909,
    bounds: [218.0553, 80.9862, 223.0167, 87.4121]
  },
  {
    i: 405,
    text: '|',
    fontName: 'ADKXRR+MSAM7',
    size: 6.9738,
    baseline: 86.524,
    bounds: [223.921, 85.0455, 227.3381, 89.5297]
  },
  {
    i: 406,
    text: 'm',
    fontName: 'CMMI7',
    size: 6.9738,
    baseline: 80.446,
    bounds: [223.7048, 80.3832, 230.1067, 83.5214]
  }
]

it('proves an unchanged transpose spelling using both native script levels', () => {
  expect(nativeTransposeSourceIndices(objects, 'the qᵀmkn term')).toEqual([405])
})

it.each([
  'ordinary-pipe',
  'other-font',
  'body-marker',
  'lower-marker',
  'missing-subscript',
  'wrong-identifier',
  'literal-pipe-source',
  'flat-T-source',
  'distant-marker',
  'distant-subscript',
  'noncontiguous',
  'invalid-bounds',
  'invalid-size'
])('rejects ambiguous native transpose evidence: %s', (kind) => {
  const candidate = structuredClone(objects)
  let source = 'the qᵀmkn term'
  if (kind === 'ordinary-pipe') candidate[1].fontName = 'TimesRoman'
  if (kind === 'other-font') candidate[1].fontName = 'CMSY7'
  if (kind === 'body-marker') candidate[1].size = objects[0].size
  if (kind === 'lower-marker') candidate[1].baseline = 80
  if (kind === 'missing-subscript') candidate.pop()
  if (kind === 'wrong-identifier') source = 'the xᵀmkn term'
  if (kind === 'literal-pipe-source') source = 'the q|mkn term'
  if (kind === 'flat-T-source') source = 'the qTmkn term'
  if (kind === 'distant-marker') candidate[1].bounds[0] += 10
  if (kind === 'distant-subscript') candidate[2].bounds[0] += 2
  if (kind === 'noncontiguous') candidate[2].i += 1
  if (kind === 'invalid-bounds') candidate[1].bounds[2] = candidate[1].bounds[0]
  if (kind === 'invalid-size') candidate[1].size = Number.NaN
  expect(nativeTransposeSourceIndices(candidate, source)).toEqual([])
})
