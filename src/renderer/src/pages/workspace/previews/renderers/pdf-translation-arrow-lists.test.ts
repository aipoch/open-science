import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  font = 9,
  fontName = 'body'
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  dir: 'ltr',
  fontName,
  hasEOL: true,
  transform: [font, 0, 0, font, x, 800 - y]
})
const row = (text: string, y: number): PdfLayoutTextItem[] => [
  { ...item('⇒', 365, y, 7.896, 8, 'symbols'), hasEOL: false },
  item(text, 377, y, 172)
]
const fixture = (): PdfLayoutTextItem[] => [
  item('STUDY STRENGTHS AND LIMITATIONS', 365, 100, 181, 10, 'heading'),
  ...row('A strength of the study is the complete inter-', 114),
  item('vention, supported by consistent clinical evidence and', 377, 125, 172),
  item('attention to implementation factors.', 377, 136, 119),
  ...row('The study findings are limited by the small sam-', 147),
  item('ple size.', 377, 158, 27.3),
  ...row('The clinical programme is delivered in a single hospital', 169),
  item('with treatment support available to every participant.', 377, 180, 172),
  item('Separate body paragraph outside the list.', 365, 191, 172)
]
const extract = (items: PdfLayoutTextItem[]): string[] =>
  groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  }).units.map((unit) => unit.source)

// Geometry follows the separate symbol/body runs of BMJ e080239 p1:
// 8pt arrow, 12pt hanging indent, 9pt prose and 11pt native baselines.
it('keeps a heading and each complete hanging arrow entry independent', () => {
  const sources = extract(fixture())
  expect(sources).toEqual([
    'STUDY STRENGTHS AND LIMITATIONS',
    '⇒ A strength of the study is the complete inter-vention, supported by consistent clinical evidence and attention to implementation factors.',
    '⇒ The study findings are limited by the small sam-ple size.',
    '⇒ The clinical programme is delivered in a single hospital with treatment support available to every participant.',
    'Separate body paragraph outside the list.'
  ])
})

it.each([
  { name: 'another font', change: (run: PdfLayoutTextItem) => ({ ...run, fontName: 'caption' }) },
  {
    name: 'a neighboring column',
    change: (run: PdfLayoutTextItem) => ({ ...run, transform: [9, 0, 0, 9, 40, 800 - 158] })
  },
  {
    name: 'an outdented neighboring paragraph',
    change: (run: PdfLayoutTextItem) => ({ ...run, transform: [9, 0, 0, 9, 365, 800 - 158] })
  },
  {
    name: 'an unproven larger vertical gap',
    change: (run: PdfLayoutTextItem) => ({ ...run, transform: [9, 0, 0, 9, 377, 800 - 162] })
  }
])('does not own a short neighboring tail with $name', ({ change }) => {
  const runs = fixture()
  runs[7] = change(runs[7])
  const sources = extract(runs)
  expect(sources).not.toContain('⇒ The study findings are limited by the small sam-ple size.')
  expect(sources.some((source) => source.startsWith('ple size.'))).toBe(true)
})

it('native serialization does not skip a neighboring paragraph to join a list tail', () => {
  const runs = fixture()
  runs.splice(7, 0, item('An independent neighboring caption.', 40, 250, 160))
  expect(extract(runs)).not.toContain('⇒ The study findings are limited by the small sam-ple size.')
})

it('a complete sentence ends ownership before aligned outside prose', () => {
  const runs = fixture()
  runs[runs.length - 1] = item('Another paragraph aligned with the list text.', 377, 191, 172)
  const sources = extract(runs)
  expect(sources).toContain('Another paragraph aligned with the list text.')
  expect(sources.some((source) => source.includes('participant. Another paragraph'))).toBe(false)
})

it('a lone arrow does not prove hanging list ownership', () => {
  expect(extract(fixture().slice(0, 5))).not.toContain(
    '⇒ A strength of the study is the complete inter-vention, supported by consistent clinical evidence and attention to implementation factors.'
  )
})

it('an implication with symbolic operands retains its formula boundary', () => {
  const runs = [
    ...row('x = y + z', 114),
    item('An independent body paragraph follows the equation.', 377, 125, 172),
    ...row('a = b − c', 147),
    item('Another independent sentence follows the equation.', 377, 158, 172)
  ]
  const sources = extract(runs)
  expect(sources.some((source) => source.includes('x = y + z An independent'))).toBe(false)
  expect(sources.some((source) => source.includes('a = b − c Another independent'))).toBe(false)
})

it('a marker cannot own prose serialized past an unrelated native object', () => {
  const runs = fixture()
  runs.splice(6, 0, item('Unrelated native content.', 40, 250, 160))
  expect(extract(runs)).not.toContain('⇒ The study findings are limited by the small sam-ple size.')
})
