import { createHash } from 'node:crypto'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { artifactLiteratureSidecarSchema } from '../../shared/artifact-literature'
import type { LiteratureItemView } from '../../shared/literature'
import { LiteratureCitationDocument } from './citation-document'

const item = (id: string, title: string): LiteratureItemView => ({
  id,
  metadataRevision: 1,
  createdAt: 0,
  updatedAt: 0,
  projectIds: ['project-1'],
  collectionIds: [],
  attachments: [],
  item: {
    itemType: 'journalArticle',
    title,
    abstract: '',
    issuedText: '2024',
    issuedYear: 2024,
    containerTitle: 'Journal of Tests',
    shortTitle: '',
    language: 'en',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [
      { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' }
    ],
    identifiers: []
  }
})

const docx = (text: string | string[]): Uint8Array =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${(Array.isArray(text) ? text : [text]).map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`
    )
  })

describe('LiteratureCitationDocument', () => {
  it('distinguishes an extraction budget from corrupt DOCX input', async () => {
    const formatter = new LiteratureCitationDocument({ getMany: vi.fn() })
    const entries = Object.fromEntries(
      Array.from({ length: 5001 }, (_, i) => [`entry-${i}`, new Uint8Array()])
    )
    await expect(
      formatter.format({ content: zipSync(entries), styleId: 'apa', locale: 'en-US' })
    ).rejects.toThrow('extraction budget')
    await expect(
      formatter.format({ content: new Uint8Array([1, 2, 3]), styleId: 'apa', locale: 'en-US' })
    ).rejects.toThrow('valid DOCX')
  })

  it('turns semantic markers into Zotero-compatible Word fields and a bound sidecar', async () => {
    const first = item('item-1', 'First paper')
    const second = item('item-2', 'Second paper')
    const getMany = vi.fn(async () => [first, second])
    const formatReferences = vi.fn(async () => [
      { itemId: 'item-1', inText: '(Lovelace, 2024)', reference: 'Lovelace, A. First paper.' },
      { itemId: 'item-2', inText: '(Lovelace, 2024b)', reference: 'Lovelace, A. Second paper.' }
    ])
    const formatter = new LiteratureCitationDocument({ getMany }, { formatReferences })

    const result = await formatter.format({
      content: docx('Finding {{cite:item-1}} and {{cite:item-2}}. {{bibliography}}'),
      styleId: 'apa',
      locale: 'en-US'
    })

    const xml = strFromU8(unzipSync(result.content)['word/document.xml']!)
    expect(xml).toContain('ADDIN ZOTERO_ITEM CSL_CITATION')
    expect(xml).toContain('ADDIN ZOTERO_BIBL')
    expect(xml).toContain('CSL_BIBLIOGRAPHY')
    expect(xml).toContain('(Lovelace, 2024)')
    expect(xml).toContain('Lovelace, A. Second paper.')
    expect(xml).not.toContain('{{cite:')
    expect(xml).not.toContain('{{bibliography}}')
    expect(result.citationCount).toBe(2)
    expect(result.referenceCount).toBe(2)
    expect(result.literature.citations).toEqual([
      { citationId: 'open-science-1', itemId: 'item-1' },
      { citationId: 'open-science-2', itemId: 'item-2' }
    ])
    expect(artifactLiteratureSidecarSchema.parse(result.sidecar)).toEqual(result.sidecar)
    expect(result.sidecar.contentChecksum).toBe(
      createHash('sha256').update(result.content).digest('hex')
    )
  })

  it('formats one reference once when it is cited repeatedly', async () => {
    const reference = item('item-1', 'First paper')
    const formatReferences = vi.fn(async () => [
      { itemId: 'item-1', inText: '[1]', reference: '1. First paper.' }
    ])
    const formatter = new LiteratureCitationDocument(
      { getMany: async () => [reference] },
      { formatReferences }
    )

    const result = await formatter.format({
      content: docx('{{cite:item-1}} then {{cite:item-1}}'),
      styleId: 'vancouver',
      locale: 'en-US'
    })

    expect(result.citationCount).toBe(2)
    expect(result.referenceCount).toBe(1)
    expect(formatReferences).toHaveBeenCalledWith(
      [{ id: 'item-1', item: reference.item }],
      'vancouver',
      'en-US',
      'html'
    )
  })

  it('reformats recorded Zotero fields without requiring the original markers', async () => {
    const reference = item('item-1', 'First paper')
    const formatReferences = vi
      .fn()
      .mockResolvedValueOnce([
        { itemId: 'item-1', inText: '(Lovelace, 2024)', reference: 'Lovelace, A. First paper.' }
      ])
      .mockResolvedValueOnce([
        { itemId: 'item-1', inText: '[1]', reference: '1. Lovelace A. First paper.' }
      ])
      .mockResolvedValueOnce([
        { itemId: 'item-1', inText: '(Lovelace, 2024)', reference: 'Lovelace, A. First paper.' }
      ])
    const formatter = new LiteratureCitationDocument(
      { getMany: async () => [reference] },
      { formatReferences }
    )
    const first = await formatter.format({
      content: docx([
        'Introduction',
        'Finding &amp; evidence {{cite:item-1}}. ',
        'References: {{bibliography}}',
        'Conclusion'
      ]),
      styleId: 'apa',
      locale: 'en-US'
    })
    const literature = {
      schemaVersion: 1 as const,
      styleId: 'apa',
      locale: 'en-US',
      references: [
        { itemId: reference.id, metadataRevision: reference.metadataRevision, item: reference.item }
      ],
      citations: first.literature.citations.map((citation) => ({
        ...citation,
        metadataRevision: reference.metadataRevision
      }))
    }

    const result = await formatter.reformat({
      content: first.content,
      literature,
      styleId: 'vancouver',
      locale: 'en-US'
    })

    const xml = strFromU8(unzipSync(result.content)['word/document.xml']!)
    expect(xml).toContain('<w:t xml:space="preserve">Finding &amp; evidence </w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">. </w:t>')
    expect(xml).toContain('<w:t xml:space="preserve">References: </w:t>')
    expect(xml.match(/<w:p>/gu)).toHaveLength(4)
    expect(xml.match(/<\/w:p>/gu)).toHaveLength(4)
    expect(xml).toContain('<w:t>Introduction</w:t>')
    expect(xml).toContain('<w:t>Conclusion</w:t>')
    expect(xml).toContain('[1]')
    expect(xml).toContain('1. Lovelace A. First paper.')
    expect(xml).not.toContain('(Lovelace, 2024)')
    expect(result.literature).toMatchObject({ styleId: 'vancouver', locale: 'en-US' })

    const repeated = await formatter.reformat({
      content: result.content,
      literature: result.literature,
      styleId: 'apa',
      locale: 'en-US'
    })
    const repeatedXml = strFromU8(unzipSync(repeated.content)['word/document.xml']!)
    expect(repeatedXml).toContain('<w:t xml:space="preserve">Finding &amp; evidence </w:t>')
    expect(repeatedXml).toContain('<w:t xml:space="preserve">. </w:t>')
    expect(repeatedXml).toContain('(Lovelace, 2024)')
    expect(repeatedXml).toContain('Lovelace, A. First paper.')
    expect(repeatedXml).not.toContain('1. Lovelace A. First paper.')
  })

  it('rejects unknown Literature item ids before writing a document', async () => {
    const formatter = new LiteratureCitationDocument(
      { getMany: async () => [] },
      { formatReferences: vi.fn() }
    )

    await expect(
      formatter.format({
        content: docx('{{cite:missing-item}}'),
        styleId: 'apa',
        locale: 'en-US'
      })
    ).rejects.toThrow('Literature Item is unavailable: missing-item')
  })
})
