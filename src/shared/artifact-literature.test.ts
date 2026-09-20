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

it('reads legacy corpus counts without inventing missing evidence and validates explicit metadata counts', async () => {
  const { artifactLiteratureCorpusManifestSchema } = await import('./artifact-literature')
  const legacy = {
    items: [{ itemId: 'item-1', metadataRevision: 1 }],
    retrievals: [{ scope: 'project', resultCount: 1, totalCount: 1, complete: true }],
    coverage: {
      searchedCount: 1,
      candidateCount: 1,
      fullTextCount: 0,
      abstractOnlyCount: 1,
      unprocessedCount: 0
    },
    capturedAt: '2026-09-08T00:00:00.000Z'
  }
  expect(artifactLiteratureCorpusManifestSchema.parse(legacy)).toEqual(legacy)
  const current = {
    ...legacy,
    coverage: { ...legacy.coverage, abstractOnlyCount: 0, metadataOnlyCount: 1 }
  }
  expect(artifactLiteratureCorpusManifestSchema.parse(current)).toEqual(current)
  expect(() =>
    artifactLiteratureCorpusManifestSchema.parse({
      ...current,
      coverage: { ...current.coverage, metadataOnlyCount: 0 }
    })
  ).toThrow('evidence classification')
})
