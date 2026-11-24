import {
  literatureCandidateStatesRequestSchema,
  literatureCandidateStatesResultSchema
} from './literature'
import { literatureItemInputSchema as contractItemSchema } from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema as itemSchema } from '@aipoch/literature-library/item'
import { describe, expect, it } from 'vitest'

import {
  literatureCatalogCommandSchema,
  literatureCatalogSearchRequestSchema,
  literatureCitationStylesRequestSchema,
  literatureCollectionViewSchema,
  literatureFormatDocumentRequestSchema,
  literatureFormatReferencesRequestSchema
} from '@aipoch/literature-library/contracts'
import {
  createLiteratureAttachmentVersionReference,
  parseLiteratureAttachmentVersionReference
} from './literature-attachment-reference'
import { literatureApplicationCommandContracts } from './literature'

describe('Temporary citation exploration command contract', () => {
  it.each(['skg-if', 'index'] as const)(
    'preserves an explicit OpenCitations %s session mode',
    (opencitationsMode) => {
      const request = {
        itemId: 'saved-root',
        expectedMetadataRevision: 7,
        direction: 'citations',
        provider: 'opencitations',
        opencitationsMode,
        resolutionToken: '00000000-0000-4000-8000-000000000001',
        seedPaperId: 'opencitations:br/062203052290',
        offset: 20
      }
      expect(literatureApplicationCommandContracts.related.args.parse([request])).toEqual([request])
      for (const provider of [undefined, 'auto', 'unknown-source', 'europe-pmc']) {
        expect(() =>
          literatureApplicationCommandContracts.related.args.parse([{ ...request, provider }])
        ).toThrow()
      }
      expect(() =>
        literatureApplicationCommandContracts.related.args.parse([
          { ...request, opencitationsMode: 'other' }
        ])
      ).toThrow()
    }
  )
  it.each([
    ['europe-pmc', 'europe-pmc:MED:10647931'],
    ['europe-pmc', 'europe-pmc:PMC:PMC3690193'],
    ['opencitations', 'opencitations:br/06180349574']
  ] as const)(
    'preserves the explicit %s provider and its temporary identity',
    (provider, seedPaperId) => {
      const request = {
        itemId: 'saved-root',
        expectedMetadataRevision: 7,
        direction: 'citations',
        provider,
        resolutionToken: '00000000-0000-4000-8000-000000000001',
        seedPaperId,
        offset: 20
      }
      expect(literatureApplicationCommandContracts.related.args.parse([request])).toEqual([request])
      expect(() =>
        literatureApplicationCommandContracts.related.args.parse([
          { ...request, provider: 'unknown-source' }
        ])
      ).toThrow()
      expect(() =>
        literatureApplicationCommandContracts.related.args.parse([
          { ...request, seedPaperId: 'europe-pmc:MED:../paper' }
        ])
      ).toThrow()
      for (const seedPaperId of [
        'opencitations:br/../1',
        'opencitations:ra/123',
        'opencitations:br/123?x=1'
      ])
        expect(() =>
          literatureApplicationCommandContracts.related.args.parse([{ ...request, seedPaperId }])
        ).toThrow()
    }
  )
  it.each([
    { provider: 'unknown-source' },
    { provider: 'europe-pmc', seedPaperId: 'b'.repeat(40) }
  ])('rejects unsupported citation source identities: %j', (removed) => {
    expect(() =>
      literatureApplicationCommandContracts.related.args.parse([
        {
          itemId: 'saved-root',
          expectedMetadataRevision: 7,
          direction: 'references',
          offset: 0,
          ...removed
        }
      ])
    ).toThrow()
  })
  it('retains the saved root and resolution token when selecting an unsaved center', () => {
    const request = {
      itemId: 'saved-root',
      expectedMetadataRevision: 7,
      direction: 'citations',
      resolutionToken: '00000000-0000-4000-8000-000000000001',
      seedPaperId: 'europe-pmc:MED:31020319',
      offset: 0
    }
    expect(literatureApplicationCommandContracts.related.args.parse([request])).toEqual([request])
    expect(() =>
      literatureApplicationCommandContracts.related.args.parse([
        { ...request, seedPaperId: '../paper' }
      ])
    ).toThrow()
    expect(() =>
      literatureApplicationCommandContracts.related.args.parse([{ ...request, itemId: '' }])
    ).toThrow()
  })
})

describe('Literature identifier draft lookup contract', () => {
  it('accepts a DOI and rejects URLs, malformed identifiers, and oversized arguments', () => {
    const { args } = literatureApplicationCommandContracts.lookupMetadata
    expect(args.parse(['10.1007/s11914-026-00956-3'])).toEqual(['10.1007/s11914-026-00956-3'])
    expect(args.parse(['pmid:29370583'])).toEqual(['pmid:29370583'])
    expect(args.parse(['pmcid:PMC12345'])).toEqual(['pmcid:PMC12345'])
    expect(args.parse(['arxiv:2401.12345'])).toEqual(['arxiv:2401.12345'])
    expect(args.parse(['arxiv:hep-th/9901001'])).toEqual(['arxiv:hep-th/9901001'])
    for (const input of [
      ['pmid:abc'],
      ['pmcid:12345'],
      ['pmcid:PMC0'],
      ['pmcid:PMC12345/path'],
      ['arxiv:invalid'],
      ['https://arxiv.org/abs/2401.12345'],
      [],
      ['https://example.com'],
      ['10.1007/has space'],
      ['10.1007/' + 'a'.repeat(2048)]
    ]) {
      expect(() => args.parse(input)).toThrow()
    }
  })
})

describe('Literature citation style requests', () => {
  it('keeps style listing on the stable parameter-free request shape', () => {
    expect(literatureCitationStylesRequestSchema.parse({ kind: 'list' })).toEqual({ kind: 'list' })
    expect(
      literatureCitationStylesRequestSchema.parse({
        kind: 'preview',
        styleId: 'custom:example'
      })
    ).toEqual({ kind: 'preview', styleId: 'custom:example' })
    expect(() =>
      literatureCitationStylesRequestSchema.parse({ kind: 'list', includePreviews: true })
    ).toThrow()
  })
})

describe('Literature Attachment Version references', () => {
  it('round-trips one opaque immutable Version id', () => {
    const reference = createLiteratureAttachmentVersionReference('version:one')

    expect(reference).toBe('literature-attachment-version:version%3Aone')
    expect(parseLiteratureAttachmentVersionReference(reference)).toBe('version:one')
  })

  it('rejects empty, malformed, and path-shaped references', () => {
    expect(
      parseLiteratureAttachmentVersionReference('literature-attachment-version:')
    ).toBeUndefined()
    expect(
      parseLiteratureAttachmentVersionReference('literature-attachment-version:%E0%A4%A')
    ).toBeUndefined()
    expect(
      parseLiteratureAttachmentVersionReference('literature-attachment-version:a%2Fb')
    ).toBeUndefined()
  })
})

describe('Literature reference formatting requests', () => {
  it('accepts supported styles and rejects unbounded or unknown requests', () => {
    expect(
      literatureFormatReferencesRequestSchema.parse({
        itemIds: ['item-1'],
        styleId: 'apa',
        locale: 'en-US'
      })
    ).toEqual({ itemIds: ['item-1'], styleId: 'apa', locale: 'en-US' })
    expect(
      literatureFormatReferencesRequestSchema.parse({
        itemIds: ['item-1'],
        styleId: 'mla',
        locale: 'en-US'
      })
    ).toEqual({ itemIds: ['item-1'], styleId: 'mla', locale: 'en-US' })
    expect(() =>
      literatureFormatReferencesRequestSchema.parse({
        itemIds: [],
        styleId: 'custom',
        locale: 'en-US'
      })
    ).toThrow()
  })

  it('requires optimistic concurrency fields only when saving a formatted document', () => {
    const identity = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      styleId: 'vancouver',
      locale: 'en-US'
    } as const

    expect(literatureFormatDocumentRequestSchema.parse({ mode: 'preview', ...identity })).toEqual({
      mode: 'preview',
      ...identity
    })
    expect(
      literatureFormatDocumentRequestSchema.parse({
        mode: 'save',
        ...identity,
        expectedHeadVersionId: 'version-1',
        operationId: 'operation-1'
      })
    ).toMatchObject({ mode: 'save', expectedHeadVersionId: 'version-1' })
    expect(() =>
      literatureFormatDocumentRequestSchema.parse({ mode: 'save', ...identity })
    ).toThrow()
  })
})

describe('Literature Collection contracts', () => {
  it('carries presentation-only descriptions through create, update, delete, and view payloads', () => {
    expect(
      literatureCatalogCommandSchema.parse({
        kind: 'create-collection',
        name: 'Review queue',
        description: 'Studies awaiting full-text review.'
      })
    ).toMatchObject({ description: 'Studies awaiting full-text review.' })
    expect(
      literatureCatalogCommandSchema.parse({
        kind: 'update-collection',
        expectedRevision: 1,
        collectionId: 'collection-1',
        name: 'Included studies',
        description: 'Final synthesis set.'
      })
    ).toMatchObject({
      kind: 'update-collection',
      expectedRevision: 1,
      collectionId: 'collection-1'
    })
    expect(
      literatureCatalogCommandSchema.parse({
        kind: 'delete-collection',
        collectionId: 'collection-1'
      })
    ).toEqual({ kind: 'delete-collection', collectionId: 'collection-1' })
    expect(
      literatureCollectionViewSchema.parse({
        revision: 1,
        id: 'collection-1',
        name: 'Included studies',
        description: 'Final synthesis set.',
        itemCount: 2,
        createdAt: 1,
        updatedAt: 2
      })
    ).toMatchObject({ description: 'Final synthesis set.' })
  })

  it('rejects removed Smart Collection and archived lifecycle inputs', () => {
    expect(() =>
      literatureCatalogCommandSchema.parse({
        kind: 'create-collection',
        name: 'Recent studies',
        filter: { yearFrom: 2024 }
      })
    ).toThrow()
    expect(() =>
      literatureCatalogSearchRequestSchema.parse({
        scope: 'library',
        lifecycle: 'archived'
      })
    ).toThrow()
  })
})

describe('Literature Inbox contracts', () => {
  it('accepts one bounded batch of unique candidates', () => {
    expect(
      literatureCatalogCommandSchema.parse({
        kind: 'settle-candidates',
        candidateIds: ['candidate-1', 'candidate-2'],
        state: 'accepted'
      })
    ).toEqual({
      kind: 'settle-candidates',
      candidateIds: ['candidate-1', 'candidate-2'],
      state: 'accepted'
    })
    expect(() =>
      literatureCatalogCommandSchema.parse({
        kind: 'settle-candidates',
        candidateIds: ['candidate-1', 'candidate-1'],
        state: 'dismissed'
      })
    ).toThrow('Inbox candidate ids must be unique.')
  })

  it('accepts restoring dismissed candidates to the Inbox', () => {
    expect(
      literatureCatalogCommandSchema.parse({
        kind: 'restore-candidates',
        candidateIds: ['candidate-1', 'candidate-2']
      })
    ).toEqual({
      kind: 'restore-candidates',
      candidateIds: ['candidate-1', 'candidate-2']
    })
  })
})

it('binds the full-text contract to application command argument tuples', () => {
  const { args, result } = literatureApplicationCommandContracts.fullText
  expect(args.parse([{ mode: 'transfer', itemId: 'item' }])).toEqual([
    { mode: 'transfer', itemId: 'item' }
  ])
  expect(result.parse({ mode: 'transfer' })).toEqual({ mode: 'transfer' })
})

it('bounds decision-only reads without accepting mutation fields', () => {
  const request = { kind: 'read-smart-decisions', collectionId: 'collection', itemIds: ['paper'] }
  expect(literatureCatalogCommandSchema.parse(request)).toEqual(request)
  expect(literatureCatalogCommandSchema.safeParse({ ...request, itemIds: [] }).success).toBe(false)
  expect(
    literatureCatalogCommandSchema.safeParse({ ...request, itemIds: Array(101).fill('paper') })
      .success
  ).toBe(false)
  expect(
    literatureCatalogCommandSchema.safeParse({ ...request, decision: 'include' }).success
  ).toBe(false)
})

it('scopes progress reads to a run and rejects mutation or unbounded paging fields', () => {
  const request = { kind: 'read-smart-run-progress', collectionId: 'collection', runId: 'run' }
  expect(literatureCatalogCommandSchema.parse(request)).toEqual(request)
  for (const invalid of [
    { ...request, runId: '' },
    { ...request, action: 'refresh' },
    { ...request, limit: 100000 }
  ])
    expect(literatureCatalogCommandSchema.safeParse(invalid).success).toBe(false)
})

it('keeps the public literature item schema identical to the snapshot contract', () => {
  expect(contractItemSchema).toBe(itemSchema)
})

it('bounds exact candidate reads and rejects unknown persisted states', () => {
  expect(literatureCandidateStatesRequestSchema.parse({ candidateIds: [' candidate '] })).toEqual({
    candidateIds: ['candidate']
  })
  for (const candidateIds of [
    [],
    [''],
    ['x'.repeat(257)],
    Array.from({ length: 201 }, () => 'id')
  ]) {
    expect(literatureCandidateStatesRequestSchema.safeParse({ candidateIds }).success).toBe(false)
  }
  expect(
    literatureCandidateStatesRequestSchema.safeParse({ candidateIds: ['a'], state: 'pending' })
      .success
  ).toBe(false)
  expect(
    literatureCandidateStatesResultSchema.safeParse({
      candidates: [{ candidateId: 'a', state: 'imported' }]
    }).success
  ).toBe(false)
})
