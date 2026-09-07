import { describe, expect, it } from 'vitest'

import { artifactLiteratureRequestSchema } from './artifact-literature'

describe('artifactLiteratureRequestSchema', () => {
  it('normalizes a semantic citation request without accepting duplicate citation ids', () => {
    const citation = {
      citationId: 'citation-1',
      itemId: 'item-1',
      locator: { label: 'page' as const, value: '17' }
    }
    expect(artifactLiteratureRequestSchema.parse({ citations: [citation] })).toEqual({
      styleId: 'apa',
      locale: 'en-US',
      citations: [citation]
    })
    expect(() =>
      artifactLiteratureRequestSchema.parse({ citations: [citation, citation] })
    ).toThrow('Citation ids must be unique.')
  })

  it('accepts review judgments while reserving retrieval facts for the app', () => {
    const citations = [{ citationId: 'citation-1', itemId: 'item-1' }]
    const corpus = {
      itemIds: ['item-1'],
      candidateCount: 2
    }

    expect(artifactLiteratureRequestSchema.parse({ corpus, citations })).toMatchObject({ corpus })
    expect(() =>
      artifactLiteratureRequestSchema.parse({
        corpus: {
          ...corpus,
          searchedCount: 4
        },
        citations
      })
    ).toThrow()
  })

  it('reserves full-text coverage classification for the app', () => {
    const citations = [{ citationId: 'citation-1', itemId: 'item-1' }]
    const corpus = {
      itemIds: ['item-1'],
      candidateCount: 2,
      fullTextCount: 1
    }

    expect(() => artifactLiteratureRequestSchema.parse({ corpus, citations })).toThrow()
  })
})
