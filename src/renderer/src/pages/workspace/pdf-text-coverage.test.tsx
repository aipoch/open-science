// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLiteratureToolSummary } from './literature-tool-presentation'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'

vi.mock('./LiteratureToolReferenceList', () => ({ LiteratureToolReferenceList: () => null }))
vi.mock('./LiteratureCandidateStatus', () => ({ LiteratureCandidateStatus: () => null }))

afterEach(cleanup)

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
