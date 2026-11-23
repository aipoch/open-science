import assert from 'node:assert/strict'
import { it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const styles = {
  italic: [10.9091, 10.9091, 0.694, -0.194],
  roman: [11.12728, 10.9091, 0.689, -0.194],
  operator: [10.9091, 10.9091, 0.75, -0.194],
  body: [11.12728, 10.9091, 0.689, -0.194],
  probability: [10.9091, 10.9091, 0.464, 0],
  fence: [9.9626, 9.9626, 0.04, -0.6],
  script: [7.9701, 7.9701, 0.694, -0.194],
  smallNumber: [7.9701, 7.9701, 0.689, -0.194]
} as const

type RowItem = [text: string, x: number, y: number, width: number, style: keyof typeof styles]
const native = ([str, x, y, width, fontName]: RowItem): PdfLayoutTextItem => {
  const [advance, height, fontAscent, fontDescent] = styles[fontName]
  return {
    str,
    width,
    height,
    dir: 'ltr',
    hasEOL: false,
    fontName,
    fontAscent,
    fontDescent,
    fontVertical: false,
    transform: [advance, 0, 0, height, x, y]
  }
}
const end: PdfLayoutTextItem = {
  str: '',
  width: 0,
  height: 0,
  dir: 'ltr',
  hasEOL: true,
  transform: [0, 0, 0, 0, 0, 0]
}

it('retains the linked prose spanning unequal math gaps only with the paired measure bounds', () => {
  const upper = 677.411
  const lower = 663.861
  const first: RowItem[] = [
    ['μ', 85.039, upper, 6.574, 'italic'],
    ['(', 91.613, upper, 4.327, 'roman'],
    ['F', 95.94, upper, 7.016, 'italic'],
    [')', 104.47, upper, 4.327, 'roman'],
    ['≥', 113.997, upper, 8.485, 'operator'],
    ['1', 127.681, upper, 5.564, 'roman'],
    ['/', 133.245, upper, 5.455, 'italic'],
    ['2', 138.699, upper, 5.564, 'roman'],
    ['−', 147.555, upper, 8.485, 'operator'],
    ['ε', 159.335, upper, 5.416, 'italic'],
    ['.', 165.139, upper, 3.091, 'body'],
    ['Let', 176.987, upper, 16.228, 'body'],
    ['A', 198.148, upper, 8.182, 'italic'],
    ['be the set of', 211.268, upper, 64.322, 'body'],
    ['x', 280.529, upper, 6.235, 'italic'],
    ['such that', 291.702, upper, 46.741, 'body'],
    ['P', 343.373, upper, 7.004, 'italic'],
    ['as in Lemma 7.1 exists.', 356.83, upper, 119.313, 'body'],
    ['Then', 484.901, upper, 25.347, 'body']
  ]
  const second: RowItem[] = [
    ['μ', 85.039, lower, 6.574, 'italic'],
    ['(', 91.613, lower, 4.268, 'roman'],
    ['A', 95.881, lower, 8.182, 'italic'],
    [')', 104.062, lower, 4.268, 'roman'],
    ['≥', 111.365, lower, 8.485, 'operator'],
    ['1', 122.884, lower, 5.487, 'roman'],
    ['/', 128.371, lower, 5.455, 'italic'],
    ['2 +', 133.825, lower, 16.449, 'roman'],
    ['ε', 152.7, lower, 5.416, 'italic'],
    ['. By Lemma 7.3 we have', 158.508, lower, 119.715, 'body'],
    ['P', 281.857, lower, 6.667, 'probability'],
    ['(', 288.523, 672.168, 4.566, 'fence'],
    ['Y', 293.09, lower, 6.334, 'italic'],
    ['P', 299.423, 662.173, 5.369, 'script'],
    ['/', 310.712, lower, 5.455, 'italic'],
    ['∈ I', 309.501, lower, 16.246, 'operator'],
    ['(', 326.552, lower, 4.268, 'roman'],
    ['H', 330.82, lower, 9.069, 'italic'],
    [') +', 340.775, lower, 15.229, 'roman'],
    ['I', 358.43, lower, 5.94, 'operator'],
    ['(', 365.176, lower, 4.268, 'roman'],
    ['H', 369.444, lower, 9.069, 'italic'],
    [')', 379.398, lower, 4.268, 'roman'],
    [')', 383.666, 672.168, 4.566, 'fence'],
    ['< K', 391.267, lower, 20.783, 'italic'],
    ['3', 412.831, 667.82, 4.235, 'smallNumber'],
    ['/', 417.066, 667.82, 4.235, 'script'],
    ['2', 421.3, 667.82, 4.235, 'smallNumber'],
    ['. Thus the events', 426.032, lower, 84.213, 'body']
  ]
  const sourceOnly = (notPaired: boolean): boolean => {
    const values = second.map(([text, ...position]): RowItem => [
      notPaired && text === '2 +' ? '2 −' : text,
      ...position
    ])
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [
        {
          page: 1,
          width: 595.276,
          height: 841.89,
          rotation: 0,
          items: [...first.map(native), end, ...values.map(native), end]
        }
      ]
    })
    const matched = units.find(
      (unit) => unit.source.startsWith('. Let A ') && unit.source.endsWith('By Lemma 7.3 we have P')
    )
    assert.ok(matched)
    return Boolean(matched.sourceOnly)
  }
  assert.equal(sourceOnly(false), true)
  assert.equal(sourceOnly(true), false)
})
