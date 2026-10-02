import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const {
  recoverPriorCohortContinuation,
  recoverNativeCountContinuationCaption,
  isNativeAuthorAffiliationRegion,
  recoverAdjacentStatisticalSections,
  groupNativeStatisticalSections
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-table-candidates.mjs')).href
)
const { refineTable, recoverRuledTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverWrappedCountTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-count-grid.mjs')).href
)
const { groupTableParts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-group.mjs')).href
)
const { groupRuledComparisonSections } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
const load = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
const continuation = (): ReturnType<typeof readPdfFixture> =>
  load('ruled-two-cohort-continuation-before-independent-caption')
const recover = (f: ReturnType<typeof readPdfFixture>): ReturnType<typeof JSON.parse> =>
  recoverPriorCohortContinuation(
    f.tokens,
    f.rules,
    f.pageNumber,
    f.previousPage,
    f.captions,
    f.detected
  )
it('recovers a source-proved intermediate cohort continuation without swallowing the next caption', () => {
  const f = continuation()
  expect(recoverRuledTable(f.tokens, f.rules, f.pageNumber)).toBeUndefined()
  expect(recoverWrappedCountTable(f.tokens, f.rules, f.pageNumber)).toBeUndefined()
  const proof = recover(f)
  expect(proof.caption.page).toBe(18)
  expect(proof.caption.lines[0]).toMatch(/^TABLE 1:/)
  expect(proof.table.cropRect[3]).toBeLessThan(f.captions[1].rect[1] * 1.5)
  const result = refineTable(proof.table, f.tokens, [], [], f.rules)
  expect(result.grid[0]).toEqual(['xx', '1 (2%)', '3 (19%)', ''])
  expect(result.grid.find((r: string[]) => r[1] === '23 (48%)')).toEqual([
    'xx',
    '23 (48%)',
    '10 (63%)',
    ''
  ])
  expect(result.grid.every((r: string[]) => r.length === 4)).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(hasTableEvidence(result, undefined, f.tokens)).toBe(true)
})
const statistics = (): ReturnType<typeof readPdfFixture> =>
  load('overlapping-statistical-sections-with-changing-leaf-count')
const split = (f: ReturnType<typeof readPdfFixture>): ReturnType<typeof JSON.parse> =>
  recoverAdjacentStatisticalSections(f.tables, f.tokens, f.captions, f.rules, f.pageNumber)
it('replaces four overlapping detector proposals with two complete native statistical sections', () => {
  const f = statistics(),
    proof = split(f)
  expect(proof.replaced).toHaveLength(4)
  expect(proof.tables).toHaveLength(2)
  expect(proof.tables[0].cropRect[3]).toBe(proof.tables[1].cropRect[1])
  const sections = proof.tables.map((t: ReturnType<typeof JSON.parse>, n: number) => ({
    ...refineTable(t, f.tokens, f.captions, [], f.rules),
    page: f.pageNumber,
    caption: n ? undefined : proof.caption,
    sourceViewport: { width: 918, height: 1188, scale: 1.5 }
  }))
  expect(sections[0].grid).toHaveLength(5)
  expect(sections[1].grid).toHaveLength(9)
  expect(sections[1].grid[8][0]).toBe('7')
  expect(sections[1].grid[4][4]).toBe('<0.2223')
  expect(sections[0].cells[0].colSpan).toBe(4)
  expect(sections[1].cells[0].colSpan).toBe(5)
  expect(
    sections.every((s: ReturnType<typeof JSON.parse>) => !s.unassigned.length && !s.issues.length)
  ).toBe(true)
  // The ordinary source-row pass must precede converting these sections to
  // multipart transport, whose top-level object has no rows or grid.
  const page = {
    lines: f.tokens.map((i: ReturnType<typeof JSON.parse>) => ({
      ...i,
      x: i.x / 1.5,
      y: i.y / 1.5,
      width: i.width / 1.5,
      height: i.height / 1.5
    }))
  }
  const grouped = groupRuledComparisonSections(
    groupNativeStatisticalSections(groupTableParts(sections, page))
  )
  expect(grouped).toHaveLength(1)
  expect(grouped[0].parts).toHaveLength(2)
  expect(grouped[0].parts.map((p: ReturnType<typeof JSON.parse>) => p.title)).toEqual([
    'Repeated measures analyses on normalized measurements',
    'Regression model: relation of measured value and score'
  ])
  expect(grouped[0].parts.map((p: ReturnType<typeof JSON.parse>) => p.grid[0].length)).toEqual([
    4, 5
  ])
})
it('requires both complete native frames, all probabilities, and uninterrupted ordinal records', () => {
  for (const mutation of ['rule', 'leaf-rule', 'value', 'ordinal', 'caption']) {
    const f = statistics()
    if (mutation === 'rule') f.rules.splice(1, 1)
    if (mutation === 'leaf-rule') f.rules.splice(3, 1)
    if (mutation === 'value')
      f.tokens.find((i: { text: string }) => i.text === '0.968').text = 'missing'
    if (mutation === 'ordinal') f.tokens.find((i: { text: string }) => i.text === '6').text = '8'
    if (mutation === 'caption') f.captions = []
    expect(split(f)).toBeUndefined()
  }
})
it('rejects source ink that is not fully and uniquely owned by either native section', () => {
  const f = statistics(),
    proof = split(f),
    [left, , , divider] = proof.tables[0].cropRect
  f.tokens.push({
    text: 'Independent source text',
    rect: [left + 10, divider - 4, left + 100, divider + 4],
    baseline: divider + 4,
    height: 8,
    horizontal: true
  })
  expect(split(f)).toBeUndefined()
})
it('does not discard a detector proposal crossing an independently occupied source region', () => {
  const f = statistics()
  f.tables.push({ cropRect: [400, 900, 800, 1200] })
  expect(split(f)).toBeUndefined()
  const ordinary = statistics()
  ordinary.tables = ordinary.tables.slice(0, 2)
  expect(split(ordinary)).toBeUndefined()
})
it('requires the immediately preceding unique caption and repeated native cohort anchors', () => {
  for (const mutation of ['page', 'caption', 'header', 'anchors']) {
    const f = continuation()
    if (mutation === 'page') f.previousPage.pageNumber -= 1
    if (mutation === 'caption')
      f.captions = f.captions.filter((c: { page: number }) => c.page !== 18)
    if (mutation === 'header') f.previousPage.lines[0].text = 'Measures Cohort A Cohort B'
    if (mutation === 'anchors') f.previousPage.lines[1].x += 10
    expect(recover(f)).toBeUndefined()
  }
})
it('rejects open native bands, incomplete paired records, overlap, and a new caption inside the band', () => {
  for (const mutation of ['rule', 'record', 'overlap', 'caption']) {
    const f = continuation()
    if (mutation === 'rule') f.rules.pop()
    if (mutation === 'record')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '(31%)')
    if (mutation === 'overlap') f.detected = [{ cropRect: [90, 100, 690, 420] }]
    if (mutation === 'caption') f.captions[1].rect[1] = 200
    expect(recover(f)).toBeUndefined()
  }
})
const affiliations = (): ReturnType<typeof readPdfFixture> =>
  load('native-contact-email-above-superscript-institution-list')
const countCaption = (): ReturnType<typeof readPdfFixture> =>
  load('native-three-cohort-continuation-with-matching-prior-samples')
const inheritedCaption = (f: ReturnType<typeof readPdfFixture>): ReturnType<typeof JSON.parse> =>
  recoverNativeCountContinuationCaption(
    f.table,
    f.tokens,
    f.rules,
    f.pageNumber,
    f.previousPage,
    f.captions,
    f.previousRules
  )
it('inherits the original native caption only for a closed matching three-cohort continuation', () => {
  const f = countCaption()
  expect(inheritedCaption(f)).toBe(f.captions[0])
  expect(inheritedCaption(f).rect).toEqual(f.captions[0].rect)
  expect(inheritedCaption(f).page).toBe(1)
  expect(inheritedCaption(f).lines).toEqual(['Table 2. Cohort sample measurements.'])
  expect(refineTable(f.table, f.tokens, [], [], f.rules).unassigned).toEqual([])
})
it('requires adjacent unique captions, native frames, matching samples and complete cohort records', () => {
  for (const mutation of [
    'gap',
    'prior-caption',
    'current-caption',
    'samples',
    'probability-lane',
    'cohort-lane',
    'prior-frame',
    'current-frame',
    'record',
    'prose'
  ]) {
    const f = countCaption()
    if (mutation === 'gap') f.previousPage.pageNumber = 0
    if (mutation === 'prior-caption')
      f.captions.push({ ...f.captions[0], lines: ['Table 3. Other measured samples.'] })
    if (mutation === 'current-caption')
      f.captions.push({ ...f.captions[0], page: 2, lines: ['Table 3. New measurements.'] })
    if (mutation === 'samples')
      f.previousPage.lines.find((l: { text: string }) => /n=16/.test(l.text)).text = 'Cohort'
    if (mutation === 'probability-lane')
      f.previousPage.lines.find((l: { text: string }) => l.text === 'p-value').x -= 100
    if (mutation === 'cohort-lane')
      f.previousPage.lines
        .filter((l: { x: number }) => l.x > 440)
        .forEach((l: { x: number }) => {
          l.x += 5
        })
    if (mutation === 'prior-frame') f.previousRules = []
    if (mutation === 'current-frame') f.rules.pop()
    if (mutation === 'record')
      f.tokens.find((t: { text: string }) => t.text === '19 (40%)').text = '19 missing'
    if (mutation === 'prose') f.table.structure.objects = []
    expect(inheritedCaption(f), mutation).toBeUndefined()
  }
})
it('rejects a first-page native contact block followed by four serial superscript institutions', () => {
  const f = affiliations()
  expect(isNativeAuthorAffiliationRegion(f.table, f.tokens, 1, undefined, f.rules)).toBe(true)
})
it('preserves ordinary numbered tables, captioned institutions, and independently enclosed grids', () => {
  for (const mutation of ['email', 'font', 'serial', 'rule', 'closed']) {
    const f = affiliations()
    if (mutation === 'email')
      f.tokens = f.tokens.filter((i: { text: string }) => !i.text.includes('@'))
    if (mutation === 'font')
      f.tokens
        .filter((i: { text: string }) => /^\d$/.test(i.text))
        .forEach((i: { height: number }) => (i.height = 12.75))
    if (mutation === 'serial') f.tokens.find((i: { text: string }) => i.text === '3').text = '5'
    if (mutation === 'rule') f.rules = []
    if (mutation === 'closed') f.rules.push([64, 1078, 431, 1078])
    expect(isNativeAuthorAffiliationRegion(f.table, f.tokens, 1, undefined, f.rules)).toBe(false)
  }
  const f = affiliations()
  expect(isNativeAuthorAffiliationRegion(f.table, f.tokens, 2, undefined, f.rules)).toBe(false)
  expect(
    isNativeAuthorAffiliationRegion(
      f.table,
      f.tokens,
      1,
      { lines: ['Table 1. Institutions'] },
      f.rules
    )
  ).toBe(false)
})
