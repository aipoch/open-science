import { strToU8, zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { LiteratureCitationDocument } from './citation-document'
import { literatureItemInputSchema } from '../../shared/literature'
import { artifactLiteratureManifestSchema } from '../../shared/artifact-literature'

it('preserves Library-only fields and frozen corpus evidence while the package reformats citations', async () => {
  const item = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Independent citation boundary',
    issuedYear: 2025,
    rating: 4,
    personalNote: 'This note belongs to the library',
    creators: [
      { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' }
    ]
  })
  const document = new LiteratureCitationDocument({
    getMany: async () => [{ id: 'paper-1', metadataRevision: 7, item }]
  })
  const formatted = await document.format({
    content: zipSync({
      'word/document.xml': strToU8(
        '<w:document><w:body><w:p><w:r><w:t>{{cite:paper-1}}</w:t></w:r></w:p><w:p><w:r><w:t>{{bibliography}}</w:t></w:r></w:p></w:body></w:document>'
      )
    }),
    styleId: 'apa',
    locale: 'en-US'
  })
  const literature = artifactLiteratureManifestSchema.parse({
    schemaVersion: 1,
    styleId: 'apa',
    locale: 'en-US',
    references: [{ itemId: 'paper-1', metadataRevision: 7, item }],
    citations: formatted.literature.citations.map((citation) => ({
      ...citation,
      metadataRevision: 7
    })),
    corpus: {
      items: [{ itemId: 'paper-1', metadataRevision: 7, item }],
      retrievals: [{ scope: 'library', resultCount: 1, totalCount: 1, complete: true }],
      coverage: {
        searchedCount: 1,
        candidateCount: 1,
        fullTextCount: 0,
        metadataOnlyCount: 1,
        abstractOnlyCount: 0,
        unprocessedCount: 0
      },
      capturedAt: '2025-01-01T00:00:00Z'
    }
  })
  const result = await document.reformat({
    content: formatted.content,
    literature,
    styleId: 'ieee',
    locale: 'en-US'
  })
  expect(result.literature).toEqual({ ...literature, styleId: 'ieee' })
  await expect(
    document.reformat({
      content: formatted.content,
      literature: {
        ...literature,
        corpus: {
          ...literature.corpus!,
          coverage: { ...literature.corpus!.coverage, fullTextCount: 1 }
        }
      },
      styleId: 'ieee',
      locale: 'en-US'
    })
  ).rejects.toThrow()
})
