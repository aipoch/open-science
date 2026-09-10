import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import { ArtifactLiteratureManifestOwner } from './literature-manifest'
import type { ArtifactLiteratureRequest } from '../../shared/artifact-literature'

const literatureRow = (metadataRevision = 3): Record<string, unknown> => ({
  id: 'item-1',
  itemType: 'journalArticle',
  title: 'A cited paper',
  abstract: '',
  issuedText: '2026',
  issuedYear: 2026,
  containerTitle: 'Journal',
  shortTitle: '',
  language: 'en',
  rights: '',
  url: 'https://example.test/paper',
  accessedAt: null,
  citationKey: 'Doe2026',
  extra: '',
  typeFieldsJson: '{}',
  metadataRevision,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  deletedAt: null,
  creators: [
    {
      itemId: 'item-1',
      creatorId: 'creator-1',
      creatorType: 'author',
      ordinal: 0,
      creator: {
        id: 'creator-1',
        nameMode: 'person',
        givenName: 'Jane',
        familyName: 'Doe',
        literalName: '',
        normalizedName: 'doe jane',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z')
      }
    }
  ],
  identifiers: [],
  projects: [],
  collections: [],
  attachments: []
})

const owner = (metadataRevision = 3): ArtifactLiteratureManifestOwner =>
  new ArtifactLiteratureManifestOwner(
    async () =>
      ({
        projectDeletionIntent: { findMany: vi.fn(async () => []) },
        literatureItem: { findMany: vi.fn(async () => [literatureRow(metadataRevision)]) }
      }) as unknown as PrismaClient
  )

describe('ArtifactLiteratureManifestOwner', () => {
  it('freezes current Library metadata and locator semantics', async () => {
    const manifestOwner = owner()
    const context = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      promptMessageId: 'message-1'
    }
    manifestOwner.recordSearch({
      ...context,
      scope: 'project',
      query: 'retrieval augmented generation',
      offset: 0,
      limit: 20,
      result: {
        items: [{ id: 'item-1' } as never],
        totalCount: 2,
        nextOffset: 1,
        hasMore: true
      }
    })
    manifestOwner.recordSearch({
      ...context,
      scope: 'project',
      query: 'retrieval augmented generation',
      offset: 1,
      limit: 20,
      result: {
        items: [{ id: 'item-2' } as never],
        totalCount: 2,
        hasMore: false
      }
    })
    manifestOwner.recordPdfRead({ ...context, itemId: 'item-1' })
    const prepared = await manifestOwner.prepare(
      {
        styleId: 'apa',
        locale: 'en-US',
        corpus: {
          itemIds: ['item-1'],
          candidateCount: 1
        },
        citations: [
          {
            citationId: 'citation-1',
            itemId: 'item-1',
            locator: { label: 'page', value: '17' }
          }
        ]
      },
      context
    )

    expect(prepared?.checksum).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.parse(prepared!.manifestJson)).toMatchObject({
      schemaVersion: 1,
      references: [
        {
          itemId: 'item-1',
          metadataRevision: 3,
          item: { title: 'A cited paper', citationKey: 'Doe2026' }
        }
      ],
      corpus: {
        items: [{ itemId: 'item-1', metadataRevision: 3 }],
        retrievals: [
          {
            scope: 'project',
            query: 'retrieval augmented generation',
            offset: 0,
            resultCount: 1,
            totalCount: 2,
            complete: false
          },
          {
            scope: 'project',
            query: 'retrieval augmented generation',
            offset: 1,
            resultCount: 1,
            totalCount: 2,
            complete: false
          }
        ],
        coverage: {
          searchedCount: 2,
          candidateCount: 1,
          fullTextCount: 1,
          abstractOnlyCount: 0,
          unprocessedCount: 1
        },
        capturedAt: expect.any(String)
      },
      citations: [{ citationId: 'citation-1', locator: { label: 'page', value: '17' } }]
    })
  })

  it('fails closed when a frozen corpus item was not returned this turn', async () => {
    const manifestOwner = owner()
    const context = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      promptMessageId: 'message-1'
    }
    manifestOwner.recordSearch({
      ...context,
      scope: 'project',
      result: { items: [], totalCount: 0, hasMore: false }
    })

    await expect(
      manifestOwner.prepare(
        {
          corpus: {
            itemIds: ['item-1'],
            candidateCount: 1
          },
          citations: [{ citationId: 'citation-1', itemId: 'item-1' }]
        },
        context
      )
    ).rejects.toThrow('Frozen corpus item was not returned by search_library this turn: item-1')
  })

  it('freezes the current metadata revision without asking the Agent to repeat it', async () => {
    const prepared = await owner(4).prepare({
      citations: [{ citationId: 'citation-1', itemId: 'item-1' }]
    })

    expect(JSON.parse(prepared!.manifestJson)).toMatchObject({
      references: [{ itemId: 'item-1', metadataRevision: 4 }],
      citations: [{ citationId: 'citation-1', itemId: 'item-1', metadataRevision: 4 }]
    })
  })
})

const evidenceContext = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  promptMessageId: 'message-1'
}

const corpusRequest = (itemIds = ['item-1']): ArtifactLiteratureRequest => ({
  styleId: 'apa',
  locale: 'en-US',
  corpus: { itemIds, candidateCount: itemIds.length },
  citations: [{ citationId: 'citation-1', itemId: 'item-1' }]
})

const recordResults = (
  manifestOwner: ArtifactLiteratureManifestOwner,
  itemIds: string[],
  totalCount = itemIds.length
): void => {
  manifestOwner.recordSearch({
    ...evidenceContext,
    scope: 'project',
    query: 'retrieval',
    offset: 0,
    limit: 20,
    result: {
      items: itemIds.map((id) => ({
        id,
        metadataRevision: 3,
        item: {
          itemType: 'journalArticle' as const,
          title: 'A cited paper',
          abstract: '',
          issuedText: '2026',
          containerTitle: 'Journal',
          shortTitle: '',
          language: 'en',
          rights: '',
          url: '',
          extra: '',
          typeFields: {},
          creators: [],
          identifiers: []
        },
        projectIds: ['project-1'],
        collectionIds: [],
        attachments: [],
        lifecycle: 'active' as const,
        createdAt: 1,
        updatedAt: 2
      })),
      totalCount,
      hasMore: totalCount > itemIds.length
    }
  })
}

describe('Literature evidence delivered to a review', () => {
  it('does not count a metadata-only search result as delivered abstract content', async () => {
    const manifestOwner = owner()
    recordResults(manifestOwner, ['item-1'])
    const prepared = await manifestOwner.prepare(corpusRequest(), evidenceContext)
    const manifest = JSON.parse(prepared!.manifestJson)

    expect(manifest.corpus.coverage.abstractOnlyCount).toBe(0)
    expect(manifest.corpus.coverage.fullTextCount).toBe(0)
  })

  it('retains bibliographic content for included papers that are not cited', async () => {
    const uncited = {
      ...literatureRow(),
      id: 'item-2',
      title: 'Uncited included study',
      abstract: 'Frozen uncited findings.'
    }
    const manifestOwner = new ArtifactLiteratureManifestOwner(
      async () =>
        ({
          projectDeletionIntent: { findMany: vi.fn(async () => []) },
          literatureItem: { findMany: vi.fn(async () => [literatureRow(), uncited]) }
        }) as unknown as PrismaClient
    )
    recordResults(manifestOwner, ['item-1', 'item-2'])
    const prepared = await manifestOwner.prepare(
      corpusRequest(['item-1', 'item-2']),
      evidenceContext
    )
    // Observe the serialized artifact boundary, without prescribing where snapshots are stored.
    uncited.title = 'Later catalog title'
    uncited.abstract = 'Later catalog findings.'
    expect(prepared!.manifestJson).toContain('Uncited included study')
    expect(prepared!.manifestJson).toContain('Frozen uncited findings.')
  })

  it('recognizes a newly returned paper after repeated identical searches', async () => {
    const manifestOwner = owner()
    const freshOwner = owner()
    recordResults(freshOwner, ['item-1'])
    await expect(freshOwner.prepare(corpusRequest(), evidenceContext)).resolves.toBeDefined()
    for (let i = 0; i < 100; i++) recordResults(manifestOwner, ['item-2'])
    recordResults(manifestOwner, ['item-1'])
    await expect(manifestOwner.prepare(corpusRequest(), evidenceContext)).resolves.toBeDefined()
  })

  it('can freeze a still-existing paper when repeated query results change membership', async () => {
    const manifestOwner = owner()
    recordResults(manifestOwner, ['item-1'], 1)
    recordResults(manifestOwner, ['item-2'], 1)
    await expect(manifestOwner.prepare(corpusRequest(), evidenceContext)).resolves.toBeDefined()
  })
})

it('counts delivered abstracts, keeps PDF precedence, and refuses unrecorded distinct searches', async () => {
  const manifestOwner = owner()
  recordResults(manifestOwner, ['item-1'])
  manifestOwner.recordAbstractRead({ ...evidenceContext, itemId: 'item-1' })
  let prepared = await manifestOwner.prepare(corpusRequest(), evidenceContext)
  expect(JSON.parse(prepared!.manifestJson).corpus.coverage).toMatchObject({
    abstractOnlyCount: 1,
    fullTextCount: 0,
    metadataOnlyCount: 0
  })
  manifestOwner.recordPdfRead({ ...evidenceContext, itemId: 'item-1' })
  prepared = await manifestOwner.prepare(corpusRequest(), evidenceContext)
  expect(JSON.parse(prepared!.manifestJson).corpus.coverage).toMatchObject({
    abstractOnlyCount: 0,
    fullTextCount: 1,
    metadataOnlyCount: 0
  })
  for (let i = 1; i < 100; i++) recordResults(manifestOwner, [`other-${i}`])
  expect(() => recordResults(manifestOwner, ['one-too-many'])).toThrow('LITERATURE_EVIDENCE_LIMIT')
  expect(() => recordResults(manifestOwner, ['item-1'])).not.toThrow()
  await expect(manifestOwner.prepare(corpusRequest(), evidenceContext)).resolves.toBeDefined()
})
