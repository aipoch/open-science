import { describe, expect, it } from 'vitest'
import { buildPdfElementToolSummary } from './literature-tool-presentation'

const shortened = 'Caption is truncated; inspect the source PDF for the complete text.'
const summary = (
  action: 'read' | 'search',
  warnings: unknown[]
): NonNullable<ReturnType<typeof buildPdfElementToolSummary>['pdfElements']> =>
  buildPdfElementToolSummary(action, { document: { name: 'Example.pdf' }, warnings }).pdfElements!

describe('PDF evidence limitations', () => {
  it('only downgrades known listing abbreviations, keeping read omissions and unknown warnings', () => {
    expect(summary('search', [shortened]).incomplete).toBe(false)
    expect(summary('read', [shortened]).incomplete).toBe(true)
    for (const warning of ['private/path/unknown-warning', '', null, { reason: 'secret' }]) {
      const result = summary('search', [shortened, warning])
      expect(result.incomplete).toBe(true)
      expect(result.limitations).toEqual([
        expect.objectContaining({ summaryShortened: true, otherLimitations: true })
      ])
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
  it('accepts historical results without warning details', () => {
    expect(
      buildPdfElementToolSummary('read', { document: { name: 'Example.pdf' }, imageIncluded: true })
        .pdfElements
    ).toMatchObject({ imageIncluded: true, incomplete: false, limitations: [] })
  })
})
