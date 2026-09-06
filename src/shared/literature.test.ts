import { describe, expect, it } from 'vitest'

import {
  createLiteratureAttachmentVersionReference,
  createLiteratureIdentifierUrl,
  literatureCatalogCommandSchema,
  literatureCatalogSearchRequestSchema,
  literatureCollectionViewSchema,
  literatureCitationStylesRequestSchema,
  literatureFormatDocumentRequestSchema,
  literatureFormatReferencesRequestSchema,
  literatureIdentifierInputSchema,
  normalizeLiteratureIdentifierValue,
  parseLiteratureAttachmentVersionReference
} from './literature'

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

describe('Literature identifier links', () => {
  it('normalizes resolvable identifiers and builds their canonical URLs', () => {
    expect(normalizeLiteratureIdentifierValue('doi', '10.1234/exampleCopyright')).toBe(
      '10.1234/example'
    )
    expect(createLiteratureIdentifierUrl('doi', '10.1234/exampleCopyright')).toBe(
      'https://doi.org/10.1234/example'
    )
    expect(createLiteratureIdentifierUrl('pmid', 'PMID: 32877581')).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/32877581/'
    )
    expect(
      normalizeLiteratureIdentifierValue(
        'pmid',
        'https://pubmed.ncbi.nlm.nih.gov/12345678/?from=library'
      )
    ).toBe('12345678')
    expect(createLiteratureIdentifierUrl('pmcid', '7610567')).toBe(
      'https://pmc.ncbi.nlm.nih.gov/articles/PMC7610567/'
    )
    expect(
      normalizeLiteratureIdentifierValue(
        'pmcid',
        'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/'
      )
    ).toBe('PMC1234567')
    expect(
      normalizeLiteratureIdentifierValue(
        'arxiv',
        'https://arxiv.org/pdf/2401.12345v2.pdf?download=1'
      )
    ).toBe('2401.12345')
    expect(createLiteratureIdentifierUrl('arxiv', 'arXiv:2401.12345v2')).toBe(
      'https://arxiv.org/abs/2401.12345'
    )
    expect(createLiteratureIdentifierUrl('issn', '0028-4793')).toBeUndefined()
  })

  it('canonicalizes identifier values at the input boundary', () => {
    expect(
      literatureIdentifierInputSchema.parse({
        scheme: 'doi',
        value: 'https://doi.org/10.1234/exampleCopyright',
        isPrimary: true
      })
    ).toEqual({ scheme: 'doi', value: '10.1234/example', isPrimary: true })
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
        collectionId: 'collection-1',
        name: 'Included studies',
        description: 'Final synthesis set.'
      })
    ).toMatchObject({ kind: 'update-collection', collectionId: 'collection-1' })
    expect(
      literatureCatalogCommandSchema.parse({
        kind: 'delete-collection',
        collectionId: 'collection-1'
      })
    ).toEqual({ kind: 'delete-collection', collectionId: 'collection-1' })
    expect(
      literatureCollectionViewSchema.parse({
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
