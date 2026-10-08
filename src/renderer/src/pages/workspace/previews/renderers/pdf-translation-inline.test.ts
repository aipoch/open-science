import { expect, it, vi } from 'vitest'
vi.mock('../pdfjs', () => ({ pdfjsLib: { OPS: {} } }))
import {
  countUnsupportedPdfPixels,
  fitPdfTranslation,
  isMappedPdfSpace,
  pdfTranslationBreaks
} from './pdf-translation-inline'
it('allows mapped private-use spaces only with exact font identity, unique Unicode and empty ink', () => {
  expect(isMappedPdfSpace('16px g_d1_f1, sans-serif', 'g_d1_f1', new Set([' ']), true)).toBe(true)
  for (const unicode of [undefined, new Set([' ', 'x']), new Set(['x']), new Set(['\uE020'])])
    expect(isMappedPdfSpace('16px g_d1_f1, sans-serif', 'g_d1_f1', unicode, true)).toBe(false)
  expect(isMappedPdfSpace('16px g_d1_f10, sans-serif', 'g_d1_f1', new Set([' ']), true)).toBe(false)
  expect(isMappedPdfSpace('16px g_d1_f1, sans-serif', 'g_d1_f1', new Set([' ']), false)).toBe(false)
})
it('keeps scientific identifiers, quantities and punctuation intact', () => {
  const text = '检测 β-catenin、IL-6 和 2.5 mg/mL，p = 0.002。',
    breaks = pdfTranslationBreaks(text)
  for (const token of ['β-catenin', 'IL-6', '2.5 mg/mL', 'p = 0.002']) {
    const start = text.indexOf(token)
    expect(breaks.some((n) => n > start && n < start + token.length)).toBe(false)
  }
  expect(breaks).not.toContain(text.indexOf('。'))
})
it('rejects a change outside actual selected ink, including a single alpha value', () => {
  const a = new Uint8ClampedArray(8),
    b = a.slice(),
    mask = a.slice()
  b[0] = 20
  mask[3] = 1
  expect(countUnsupportedPdfPixels(a, b, mask)).toBe(0)
  b[7] = 1
  expect(countUnsupportedPdfPixels(a, b, mask)).toBe(1)
  expect(() => countUnsupportedPdfPixels(a, b.slice(0, 4), mask)).toThrow()
})
it('preserves every character and falls back on unbreakable, too tall, RTL or multiline text', () => {
  const ctx = {
    measureText: (text: string) => ({
      width: text.length * 7,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: text.length * 7,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2
    })
  } as CanvasRenderingContext2D
  const rect = { x: 0, y: 0, width: 80, height: 100 },
    text = '完整段落，保留所有字符。'
  expect(
    fitPdfTranslation(ctx, 'a', text, rect)
      ?.lines.map((l) => l.text)
      .join('')
  ).toBe(text)
  for (const value of ['unbreakableidentifierthatislong', 'שלום', 'line\nline'])
    expect(fitPdfTranslation(ctx, 'a', value, rect)).toBeUndefined()
  expect(fitPdfTranslation(ctx, 'a', text, { ...rect, height: 4 })).toBeUndefined()
})
