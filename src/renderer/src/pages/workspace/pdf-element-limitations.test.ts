import { describe, expect, it } from 'vitest'
import { buildPdfElementToolSummary } from './literature-tool-presentation'

const shortened = 'Caption is truncated; inspect the source PDF for the complete text.'
const summary = (
  action: 'read' | 'search',
  warnings: unknown[]
): NonNullable<ReturnType<typeof buildPdfElementToolSummary>['pdfElements']> =>
  buildPdfElementToolSummary(action, { document: { name: 'Example.pdf' }, warnings }).pdfElements!

describe('PDF evidence limitations', () => {
  it('hides listing abbreviations, flags read omissions and retains unknown warnings in notes', () => {
    expect(summary('search', [shortened])).toMatchObject({ incomplete: false, limitations: [] })
    expect(summary('read', [shortened]).incomplete).toBe(true)
    for (const warning of ['private/path/unknown-warning', '', null, { reason: 'secret' }]) {
      const result = summary('search', [shortened, warning])
      expect(result.incomplete).toBe(false)
      expect(result.limitations).toEqual([expect.objectContaining({ otherLimitations: true })])
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain('private/path')
    }
  })
  it('retains warnings on distinct elements and groups repeated reasons within each element', () => {
    const result = buildPdfElementToolSummary('search', {
      document: { name: 'Example.pdf' },
      warnings: ['unknown top-level warning'],
      elements: [3, 4].map((page) => ({
        pageStart: page,
        pageEnd: page,
        warnings: [
          'span-conflicts-with-source-rows',
          'span-conflicts-with-source-rows',
          'span-conflicts-with-source-columns'
        ]
      }))
    }).pdfElements!
    expect(result.limitations).toHaveLength(3)
    expect(result.limitations?.slice(1).map((item) => item.pageStart)).toEqual([3, 4])
    expect(result.limitations?.slice(1).every((item) => item.tableStructureConflict)).toBe(true)
  })
  it('flags unavailable pages even without a warning, but not deliberate image omission', () => {
    expect(
      buildPdfElementToolSummary('search', {
        document: { name: 'Example.pdf' },
        coverage: { checkedPages: [1, 2], parsedPages: [1], unavailablePages: [2] }
      }).pdfElements?.incomplete
    ).toBe(true)
    expect(
      buildPdfElementToolSummary('read', {
        document: { name: 'Example.pdf' },
        imageIncluded: false,
        warnings: []
      }).pdfElements?.incomplete
    ).toBe(false)
  })
  it.each([
    'The cached image could not be prepared for the model; inspect the source PDF.',
    'No cached image is available; caption or extracted text cannot replace visual evidence.',
    'Some source rows exceed the response budget and are listed in omittedRows; do not treat this as complete table evidence.',
    'Notes or unassigned text exceed this response budget; inspect the source PDF.',
    'Leading rows or merged labels exceed the context budget; inspect earlier batches and the source PDF for labels.',
    'Part title is truncated; inspect the source PDF for the complete text.'
  ])('keeps an explicit omission visible: %s', (warning) => {
    expect(summary('read', [warning])).toMatchObject({ incomplete: true, limitations: [] })
  })
  it('flags a listed element with neither cells nor an image despite full page coverage', () => {
    expect(
      buildPdfElementToolSummary('search', {
        document: { name: 'Example.pdf' },
        coverage: { checkedPages: [1], parsedPages: [1], unavailablePages: [] },
        elements: [
          { warnings: ['No cells or image are available; caption alone is not detailed evidence.'] }
        ]
      }).pdfElements
    ).toMatchObject({ incomplete: true, limitations: [] })
  })
  it('accepts historical results without warning details', () => {
    expect(
      buildPdfElementToolSummary('read', { document: { name: 'Example.pdf' }, imageIncluded: true })
        .pdfElements
    ).toMatchObject({ imageIncluded: true, incomplete: false, limitations: [] })
  })
})
