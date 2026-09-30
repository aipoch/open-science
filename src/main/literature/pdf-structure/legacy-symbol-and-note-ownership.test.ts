import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', name + '.jsonl'))

it.each(['native', 'wrong-font', 'wrong-width', 'wrong-slot', 'wrong-unicode'])(
  'repairs legacy punctuation symbols only with %s evidence',
  async (variant) => {
    for (const { font, glyph, expected } of fixture('legacy-punctuation-comparison-encodings')) {
      if (variant === 'wrong-font') font.name = 'Times-Roman'
      if (variant === 'wrong-width') glyph.width++
      if (variant === 'wrong-slot') glyph.originalCharCode += 100
      if (variant === 'wrong-unicode') glyph.unicode = '?'
      const content = { items: [{ str: glyph.unicode, fontName: 'source' }] }
      const original = structuredClone(content)
      const result = await repairPdfSymbolText({ commonObjs: { get: () => font } }, content, {
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['source', 10], [[glyph]]]
      })
      expect(result.items[0].str).toBe(variant === 'native' ? expected : glyph.unicode)
      expect(content).toEqual(original)
    }
  }
)

it('retains an abbreviated glossary and its outdented final definition', () => {
  const x = fixture('source-grids/abbreviated-glossary-with-outdented-tail')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/^Abbr: BMD, bone mineral density;/)
  expect(notes[0].text).toMatch(/TBS, trabecular bone score\.$/)
})

it('owns a statistical-test note with its raised exponent below the closing rule', () => {
  const x = fixture('source-grids/statistical-test-note-below-closing-rule')
  // Production font decoding precedes page geometry and note association.
  x.page.lines.find((l: { text: string }) => l.text.includes('Statistics according')).text =
    'Statistics according to χ'
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes.map((n: { text: string }) => n.text).join(' ')).toMatch(
    /^Statistics according to χ² test\. \*Kruskal–Wallis test;/
  )
  expect(notes.at(-1).text).toMatch(/progesterone receptor\.$/)
})

it('does not decode a footnote slot in an incompatible mathematical subset', async () => {
  const { font, glyph } = fixture('legacy-punctuation-comparison-encodings')[0]
  font.differences[3] = 'C21'
  const content = { items: [{ str: glyph.unicode, fontName: 'source' }] }
  const result = await repairPdfSymbolText({ commonObjs: { get: () => font } }, content, {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['source', 10], [[glyph]]]
  })
  expect(result.items).toEqual(content.items)
})

it('does not turn prose after a semicolon into a glossary continuation', () => {
  const x = fixture('source-grids/abbreviated-glossary-with-outdented-tail')
  x.page.lines.find((l: { text: string }) => l.text.startsWith('TBS,')).text =
    'The next paragraph describes the study methods.'
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes[0].text).not.toContain('next paragraph')
})

it.each(['inside-table', 'distant-paragraph', 'unrelated-method'])(
  'does not adopt a statistical sentence with %s geometry or meaning',
  (variant) => {
    const x = fixture('source-grids/statistical-test-note-below-closing-rule')
    const start = x.page.lines.find((l: { text: string }) =>
      l.text.includes('Statistics according')
    )
    start.text = 'Statistics according to χ'
    if (variant === 'inside-table') x.tables[0].rect[3] += 15
    if (variant === 'distant-paragraph')
      x.page.lines.forEach((l: { y: number }) => {
        if (l.y > 515) l.y += 80
      })
    if (variant === 'unrelated-method') start.text = 'Statistics were collected by the assessor'
    const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
    expect(notes.some((n: { text: string }) => n.text.includes('Statistics'))).toBe(false)
  }
)

it('retains an unlabelled terminal aggregate proved by the preceding totals and closing rule', () => {
  const x = fixture('source-grids/unassigned-terminal-aggregate')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.at(-2)).toEqual(['Total cost', '', '', '', '2,875.79', '1,708.59'])
  expect(t.grid.at(-1)).toEqual(['', '', '', '', '4,584.38', ''])
  expect(t.unassigned).not.toContain('4,584.38')
  expect(t.grid.flat().filter((s: string) => s === '4,584.38')).toHaveLength(1)
})

it.each(['wrong-sum', 'no-rule', 'no-caption', 'no-total-label', 'other-column', 'distant-value'])(
  'does not recover a terminal aggregate without independent proof: %s',
  (variant) => {
    const x = fixture('source-grids/unassigned-terminal-aggregate')
    const amount = x.tokens.find((i: { text: string }) => i.text === '4,584.38')
    if (variant === 'wrong-sum') amount.text = '4,584.39'
    if (variant === 'no-rule') x.rules = []
    if (variant === 'no-caption') x.captions = []
    if (variant === 'no-total-label')
      x.tokens.find((i: { text: string }) => i.text === 'Total cost').text = 'Measurement'
    if (variant === 'other-column') {
      amount.rect[0] += 115
      amount.rect[2] += 115
    }
    if (variant === 'distant-value') {
      amount.rect[1] += 35
      amount.rect[3] += 35
      amount.baseline += 35
    }
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.repairs).not.toContain('terminal-total-row-recovered')
  }
)
