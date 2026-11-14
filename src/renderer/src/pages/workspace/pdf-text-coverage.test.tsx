// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildLiteratureLibraryToolSummary,
  buildLiteratureToolSummary,
  getLiteratureLibraryToolAction
} from './literature-tool-presentation'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'

vi.mock('./LiteratureToolReferenceList', () => ({ LiteratureToolReferenceList: () => null }))
vi.mock('./LiteratureCandidateStatus', () => ({ LiteratureCandidateStatus: () => null }))

afterEach(cleanup)

describe('cached PDF search guidance', () => {
  const missingPdf =
    'Full-text evidence is incomplete. Check that the selected references have PDFs and prepare their text before retrying.'
  const verifyPdf =
    'Cached text does not establish complete full-text coverage. Check the source PDF before drawing conclusions about missing evidence.'
  const continueSearch =
    'Continue searching the remaining references or refine the query within the selected scope.'
  const cachedResult = {
    scope: 'project',
    coverageKind: 'cached-text-only',
    fullTextCoverage: 'unverified',
    incomplete: true,
    recordCount: 2,
    totalRecordCount: 2,
    scannedSources: 0,
    coverage: {
      requestedDocuments: 0,
      cachedDocuments: 0,
      notCachedDocuments: 0,
      unavailableDocuments: 0
    },
    limitations: ['cached-pages-unverified'],
    matches: []
  }
  const showResult = (output: unknown): ReturnType<typeof buildLiteratureLibraryToolSummary> => {
    const summary = buildLiteratureLibraryToolSummary('search', { scope: 'project' }, output)
    render(<WorkspaceLiteratureToolCard summary={summary} />)
    return summary
  }

  it.each([
    'mcp__open-science-library__search_library_full_text',
    'open-science-library/search_library_full_text',
    'open_science_library_search_library_full_text'
  ])('recognizes the cached PDF search tool as a Library card: %s', (identity) => {
    expect(getLiteratureLibraryToolAction(identity)).toBe('search')
  })

  it('shows a stable next step for the actual zero-source A05 result without claiming absence', () => {
    showResult({ structuredContent: cachedResult })
    expect(screen.getByRole('status').textContent).toContain(missingPdf)
    expect(screen.queryByText(continueSearch)).toBeNull()
  })

  it.each(['notCachedDocuments', 'unavailableDocuments'])(
    'offers PDF preparation when some sources are missing: %s',
    (reason) => {
      showResult({
        ...cachedResult,
        scannedSources: 2,
        coverage: { ...cachedResult.coverage, requestedDocuments: 2, [reason]: 1 }
      })
      expect(screen.getByText(missingPdf)).toBeTruthy()
    }
  )

  it.each([
    { nextOffset: 20, limitations: ['more-records'] },
    { sourceSelectionTruncated: true, limitations: ['source-limit'] },
    { truncated: true, limitations: ['result-limit'] }
  ])('keeps continuation within the selected scope for bounded results: %j', (limits) => {
    showResult({
      ...cachedResult,
      scannedSources: 2,
      coverage: { ...cachedResult.coverage, requestedDocuments: 2, cachedDocuments: 2 },
      ...limits
    })
    expect(screen.getByText(continueSearch)).toBeTruthy()
    expect(screen.queryByText(missingPdf)).toBeNull()
  })

  it('requests source verification without mislabelling cached documents as missing', () => {
    showResult({
      ...cachedResult,
      scannedSources: 2,
      coverage: { ...cachedResult.coverage, requestedDocuments: 2, cachedDocuments: 2 }
    })
    expect(screen.getByText(verifyPdf)).toBeTruthy()
    expect(screen.queryByText(missingPdf)).toBeNull()
    expect(screen.queryByText(continueSearch)).toBeNull()
  })

  it.each([
    { ...cachedResult, incomplete: false },
    { items: [], totalCount: 0 },
    { ...cachedResult, recordCount: 0, totalRecordCount: 0 },
    { coverageKind: 'cached-text-only', matches: [] }
  ])('does not invent missing caches for complete, empty or historical results: %j', (output) => {
    expect(showResult(output).cachedTextCoverage).toBeUndefined()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

it('shows retained ACP coverage when the passage JSON is truncated', () => {
  const summary = buildLiteratureToolSummary({}, [
    {
      type: 'content',
      content: {
        type: 'text',
        text: JSON.stringify({
          openScienceLiteraturePresentation: {
            documentNames: ['scan.pdf'],
            textCoverage: [
              { name: 'scan.pdf', total: 3, parsed: 2, ocr: 1, missing: [3], unverified: [2] }
            ]
          }
        })
      }
    },
    {
      type: 'content',
      content: { type: 'text', text: '{"document":{"name":"scan.pdf"},"passage":"truncated…' }
    }
  ])
  expect(summary.textCoverage).toEqual([
    { name: 'scan.pdf', total: 3, parsed: 2, ocr: 1, missing: [3], unverified: [2] }
  ])
  render(<WorkspaceLiteratureToolCard summary={summary} />)
  expect(screen.getByText('Pages with text: 2 / 3')).toBeTruthy()
  expect(screen.getByText('OCR was used. Verify recognized text against the PDF.')).toBeTruthy()
  expect(
    screen.getByText('Text is incomplete. Unread pages: 3. Check the source PDF or retry reading.')
  ).toBeTruthy()
  expect(
    screen.getByText(
      'Image content needs source verification. Pages with text do not establish complete evidence.'
    )
  ).toBeTruthy()
})

it('shows mixed-document coverage, missing pages and the OCR verification reminder', () => {
  const summary = buildLiteratureToolSummary(
    {},
    {
      scope: 'full-document',
      document: {
        id: 'doc',
        name: 'paper.pdf',
        pageCount: 3,
        coverage: {
          textPages: [1],
          ocrPages: [2],
          unavailablePages: [3],
          uncheckedPages: []
        }
      },
      passage: { pageStart: 1, pageEnd: 2, text: 'evidence' },
      nextCursor: null
    }
  )
  expect(summary.textCoverage).toEqual([
    { name: 'paper.pdf', parsed: 2, total: 3, ocr: 1, missing: [3] }
  ])
  render(<WorkspaceLiteratureToolCard summary={summary} />)
  expect(screen.getByText('Pages with text: 2 / 3')).toBeTruthy()
  expect(screen.getByText('OCR was used. Verify recognized text against the PDF.')).toBeTruthy()
  expect(
    screen.getByText('Text is incomplete. Unread pages: 3. Check the source PDF or retry reading.')
  ).toBeTruthy()
})

it('preserves historical results without inventing complete coverage', () => {
  expect(
    buildLiteratureToolSummary(
      {},
      {
        scope: 'full-document',
        document: {
          id: 'doc',
          name: 'old.pdf',
          pageCount: 2
        },
        passage: { pageStart: 1, pageEnd: 2, text: 'old text' },
        nextCursor: null
      }
    ).textCoverage
  ).toBeUndefined()
})

it('reports search coverage even when no passages match', () => {
  const summary = buildLiteratureToolSummary(
    { query: 'absent' },
    {
      scope: 'relevant-passages',
      documents: [
        {
          id: 'doc',
          name: 'paper.pdf',
          pageCount: 2,
          coverage: {
            textPages: [1],
            ocrPages: [],
            unavailablePages: [],
            uncheckedPages: [2]
          }
        }
      ],
      passages: [],
      retrievalMode: 'fallback'
    }
  )
  expect(summary.textCoverage?.[0].missing).toEqual([2])
})

it('separates text presence from image evidence completeness', () => {
  const summary = buildLiteratureToolSummary(
    {},
    {
      scope: 'full-document',
      document: {
        id: 'doc',
        name: 'scan.pdf',
        pageCount: 1,
        coverage: {
          textPages: [1],
          ocrPages: [1],
          unavailablePages: [],
          uncheckedPages: [],
          unverifiedPages: [1]
        }
      },
      passage: { pageStart: 1, pageEnd: 1, text: 'native and OCR evidence' },
      nextCursor: null
    }
  )
  expect(summary.textCoverage?.[0]).toMatchObject({ parsed: 1, ocr: 1, unverified: [1] })
  render(<WorkspaceLiteratureToolCard summary={summary} />)
  expect(screen.getByText('Pages with text: 1 / 1')).toBeTruthy()
  expect(
    screen.getByText(
      'Image content needs source verification. Pages with text do not establish complete evidence.'
    )
  ).toBeTruthy()
})
