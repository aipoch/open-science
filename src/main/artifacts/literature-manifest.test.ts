import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import { ArtifactLiteratureManifestOwner } from './literature-manifest'

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
            resultCount: 2,
            totalCount: 2,
            complete: true
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
