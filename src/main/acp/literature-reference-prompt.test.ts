import { describe, expect, it } from 'vitest'

import { sanitizeMessageParts } from '../../shared/session-persistence'
import {
  docFromMessageParts,
  docToMessageParts,
  docArtifactCount
} from '../../renderer/src/pages/workspace/composer/composer-doc'

import { buildLiteratureReferencePrompt } from './literature-reference-prompt'

describe('buildLiteratureReferencePrompt', () => {
  it.each([5, 6, 10])(
    'preserves exact retrieval identities for %i composer Collections',
    (count) => {
      const scopes = Array.from({ length: count }, (_, index) => ({
        type: 'literature-scope' as const,
        scope: 'collection' as const,
        collectionId: `collection-exact-${index + 1}`,
        name: `Study set ${index + 1}`
      }))
      const doc = docFromMessageParts(scopes)
      expect(docArtifactCount(doc)).toBe(count)
      const parts = sanitizeMessageParts(docToMessageParts(doc))
      expect(parts).toEqual(scopes)
      const prompt = buildLiteratureReferencePrompt(parts)
      for (const scope of scopes) expect(prompt).toContain(JSON.stringify(scope.collectionId))
    }
  )

  it('serializes an immutable metadata snapshot without local file paths', () => {
    const prompt = buildLiteratureReferencePrompt([
      {
        type: 'literature',
        itemId: 'item-1',
        metadataRevision: 4,
        attachmentVersionId: 'version-1',
        item: {
          itemType: 'journalArticle',
          title: 'A cited paper',
          abstract: 'Evidence summary',
          issuedText: '2025',
          issuedYear: 2025,
          containerTitle: 'Research Journal',
          shortTitle: '',
          language: 'en',
          rights: '',
          url: 'https://example.test/paper',
          extra: '',
          typeFields: {},
          creators: [],
          identifiers: [{ scheme: 'doi', value: '10.1/example', isPrimary: true }]
        }
      }
    ])

    expect(prompt).toContain('immutable bibliographic snapshot')
    expect(prompt).toContain('scope "items"')
    expect(prompt).toContain('A cited paper')
    expect(prompt).toContain('10.1/example')
    expect(prompt).toContain('version-1')
    expect(prompt).not.toContain('/Users/')
  })

  it('returns no extra context when the message has no Literature references', () => {
    expect(buildLiteratureReferencePrompt([{ type: 'text', text: 'Hello' }])).toBeUndefined()
  })

  it('retains reported phase and masking only for relevant study-design comparisons', () => {
    const prompt = buildLiteratureReferencePrompt([{ type: 'literature-scope', scope: 'project' }])!
    expect(prompt).toContain(
      'When comparing study designs, retain relevant trial phase and masking information'
    )
    expect(prompt).toContain('already established by the evidence used in that comparison')
    expect(prompt).toContain('Omit unrelated optional elaboration')
    expect(prompt).not.toContain(
      'Omit optional elaboration, or cite its actual supporting passage separately'
    )
  })

  it('steers paged Library and Collection retrieval without attaching their contents', () => {
    const prompt = buildLiteratureReferencePrompt([
      { type: 'literature-scope', scope: 'project' },
      {
        type: 'literature-scope',
        scope: 'collection',
        collectionId: 'collection-1',
        name: 'TP53 evidence'
      }
    ])

    expect(prompt).toContain('does not attach every record or PDF')
    expect(prompt).toContain('search_library')
    expect(prompt).toContain('trusted current Project')
    expect(prompt).toContain('nextOffset')
    expect(prompt).toContain('focused, bounded searches')
    expect(prompt).toContain('begin with metadata and abstract previews')
    expect(prompt).toContain('read_library_abstract')
    expect(prompt).toContain('batch of up to five itemIds')
    expect(prompt).toContain('do not batch-read every search result')
    expect(prompt).toContain('read_library_pdf')
    expect(prompt).toContain('bounded passages with page numbers')
    expect(prompt).toContain('answer briefly and directly')
    expect(prompt).toContain('[1](href)')
    expect(prompt).toContain('short #library-cite= reference')
    expect(prompt).toContain(
      'specific numerical result, study population, method, endpoint or limitation'
    )
    expect(prompt).toContain('support elsewhere in the paper is insufficient')
    expect(prompt).toContain('exact tool-generated sourceCitation.href or citations[].href')
    expect(prompt).toContain('Do not construct, decode, rewrite, or modify a citation href')
    expect(prompt).toContain('titles do not establish paper contents')
    expect(prompt).toContain('Label abstract-only evidence as abstract evidence')
    expect(prompt).toContain('Metadata citationHref is optional')
    expect(prompt).toContain('Never index or read the entire Library')
    expect(prompt).toContain('Library itemId and linked-PDF documentId are not interchangeable')
    expect(prompt).toContain('not every Library search result or attachment')
    expect(prompt).toContain(
      'Call list_pdf_elements with a linked documentId, or {} for a single linked PDF'
    )
    expect(prompt).toContain('call read_pdf_element with the exact elementRef returned by listing')
    expect(prompt).toContain(
      'read_library_pdf provides prose evidence, not verified table cells or images'
    )
    expect(prompt).toContain('{{cite:itemId}}')
    expect(prompt).toContain('{{bibliography}}')
    expect(prompt).toContain('format_citation_document')
    expect(prompt).toContain('format_references')
    expect(prompt).toContain('use the returned citation strings verbatim')
    expect(prompt).toContain('prepare_latex_bundle')
    expect(prompt).toContain('Zotero-compatible Word Fields')
    expect(prompt).toContain('complete reviewed corpus as itemIds plus candidateCount')
    expect(prompt).toContain('do not repeat metadataRevision')
    expect(prompt).toContain('derives searchedCount, fullTextCount, abstractOnlyCount')
    expect(prompt).toContain('collection-1')
    expect(prompt).toContain('TP53 evidence')
  })
})
