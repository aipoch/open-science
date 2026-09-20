import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { createEngine } from 'citeme-engine-wasm'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type { ArtifactLiteratureManifest } from '../../shared/artifact-literature'
import type { LiteratureItemView } from '../../shared/literature'
import { toCslItem } from '../../shared/literature-csl'
import { LiteratureCitationDocument } from './citation-document'
import { LiteratureCitationFormatter } from './citation-formatter'
import { citationResourceDirectory } from './citation-style-library'
import { LiteratureLatexBundle } from './latex-bundle'

const record = (id = 'library-id', author = 'Alpha'): LiteratureItemView => ({
  id,
  metadataRevision: 1,
  createdAt: 0,
  updatedAt: 0,
  projectIds: [],
  collectionIds: [],
  attachments: [],
  item: {
    itemType: 'journalArticle',
    title: `${author} paper`,
    abstract: '',
    issuedText: '2024',
    issuedYear: 2024,
    containerTitle: 'Journal of Tests',
    shortTitle: '',
    language: 'en',
    rights: '',
    url: '',
    extra: '',
    typeFields: { volume: '12', pages: '10-20' },
    creators: [{ nameMode: 'person', givenName: 'Ada', familyName: author, creatorType: 'author' }],
    identifiers: []
  }
})
const docx = (body: string): Uint8Array =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
    )
  })
const xmlOf = (content: Uint8Array): string => strFromU8(unzipSync(content)['word/document.xml']!)
const unescapeXml = (text: string): string =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
const visibleText = (xml: string): string =>
  [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
    .map((match) => unescapeXml(match[1]!))
    .join('')
const manifest = (
  items: LiteratureItemView[],
  citations: ArtifactLiteratureManifest['citations']
): ArtifactLiteratureManifest => ({
  schemaVersion: 1,
  styleId: 'apa',
  locale: 'en-US',
  citations,
  references: items.map(({ id, item, metadataRevision }) => ({
    itemId: id,
    item,
    metadataRevision
  }))
})

describe('Citation fidelity through document and export boundaries', () => {
  it.each(['manifest and field', 'field only'] as const)(
    'rejects reformatting rather than losing per-occurrence semantics in %s',
    async (location) => {
      const item = record()
      const citation = {
        citationId: 'citation-1',
        itemId: item.id,
        metadataRevision: 1,
        locator: { label: 'page' as const, value: '17' },
        prefix: 'See ',
        suffix: ' for details',
        suppressAuthor: true
      }
      const instruction = JSON.stringify({
        citationID: citation.citationId,
        properties: {
          formattedCitation: 'See 2024, p. 17 for details',
          plainCitation: 'See 2024, p. 17 for details',
          noteIndex: 0
        },
        citationItems: [
          {
            id: item.id,
            uris: [`https://open-science.local/literature/${item.id}`],
            itemData: toCslItem(item.id, item.item),
            locator: '17',
            label: 'page',
            prefix: 'See ',
            suffix: ' for details',
            'suppress-author': true
          }
        ]
      })
      const content = docx(
        `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION ${instruction.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>See 2024, p. 17 for details</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
      )
      await expect(
        new LiteratureCitationDocument({ getMany: async () => [item] }).reformat({
          content,
          literature: manifest(
            [item],
            [
              location === 'field only'
                ? { citationId: citation.citationId, itemId: item.id, metadataRevision: 1 }
                : citation
            ]
          ),
          styleId: 'mla',
          locale: 'en-US'
        })
      ).rejects.toThrow('Cannot reformat citations with locators, affixes, or suppressed authors.')
    }
  )

  it('preserves tabs and line breaks around a citation in the same bold run', async () => {
    const item = record()
    const result = await new LiteratureCitationDocument({ getMany: async () => [item] }).format({
      content: docx(
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:tab/><w:t>Before {{cite:library-id}} after</w:t><w:br/></w:r></w:p>'
      ),
      styleId: 'apa',
      locale: 'en-US'
    })
    const xml = xmlOf(result.content)
    expect(visibleText(xml)).toBe('Before (Alpha, 2024) after')
    expect(xml).toContain('<w:b/>')
    expect.soft(xml).toContain('<w:tab/>')
    expect.soft(xml).toContain('<w:br/>')
    expect.soft(xml.indexOf('<w:tab/>')).toBeLessThan(xml.indexOf('Before '))
    expect.soft(xml.indexOf('<w:br/>')).toBeGreaterThan(xml.indexOf(' after'))
  })

  it('keeps the stored BibTeX key consistently with LaTeX bundle export', async () => {
    const item = record()
    item.item = { ...item.item, citationKey: 'Alpha2024' }
    const formatter = new LiteratureCitationFormatter()
    const bundle = await new LiteratureLatexBundle({ getMany: async () => [item] }).prepare({
      sourceName: 'paper.tex',
      content:
        '\\usepackage{biblatex}\n\\addbibresource{references.bib}\n{{cite:library-id}}\n{{bibliography}}'
    })
    const files = unzipSync(bundle.content)
    expect(strFromU8(files['references.bib']!)).toContain('@article{Alpha2024,')
    expect(strFromU8(files['paper.tex']!)).toContain('\\cite{Alpha2024}')
    const exported = await formatter.exportReferences([{ id: item.id, item: item.item }], 'bibtex')
    expect.soft(exported).toContain('@article{Alpha2024,')
    expect.soft((await formatter.parseReferences(exported)).items[0]?.citationKey).toBe('Alpha2024')
  })

  it.each([2024, undefined])(
    'preserves the complete publication date through RIS with issuedYear=%s',
    async (issuedYear) => {
      const item = { ...record().item, issuedText: '2024-03-12', issuedYear }
      const formatter = new LiteratureCitationFormatter()
      const exported = await formatter.exportReferences([{ id: 'dated', item }], 'ris')
      const parsed = await formatter.parseReferences(exported)
      expect(parsed.errors).toEqual([])
      expect(parsed.items).toHaveLength(1)
      expect(toCslItem('dated', parsed.items[0]!).issued).toEqual({ 'date-parts': [[2024, 3, 12]] })
    }
  )

  it('preserves the local italics emitted by APA in the DOCX bibliography', async () => {
    const item = record()
    const require = createRequire(import.meta.url)
    const engine = await createEngine(
      await readFile(require.resolve('citeme-engine-wasm/pkg/citeme_engine_wasm_bg.wasm'))
    )
    try {
      engine.loadStyle('apa', await readFile(join(citationResourceDirectory(), 'apa.csl'), 'utf8'))
      engine.loadLocale(
        'en-US',
        await readFile(join(citationResourceDirectory(), 'locales-en-US.xml'), 'utf8')
      )
      const html = JSON.parse(
        engine.formatOneWithOutput(
          JSON.stringify(toCslItem(item.id, item.item)),
          'apa',
          'en-US',
          false,
          'html',
          false
        )
      ) as { reference: string }
      expect(html.reference).toMatch(/font-style:\s*italic/u)
      expect(html.reference).toContain('Journal of Tests')
      const result = await new LiteratureCitationDocument({ getMany: async () => [item] }).format({
        content: docx(
          '<w:p><w:r><w:t>{{cite:library-id}}</w:t></w:r></w:p><w:p><w:r><w:t>{{bibliography}}</w:t></w:r></w:p>'
        ),
        styleId: 'apa',
        locale: 'en-US'
      })
      const xml = xmlOf(result.content).split('CSL_BIBLIOGRAPHY')[1]!
      expect(visibleText(xml)).toContain('Journal of Tests')
      const runs = [...xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gu)].map((match) => match[1]!)
      expect(
        runs.some(
          (run) => /<w:i(?:\s|\/|>)/u.test(run) && visibleText(run).includes('Journal of Tests')
        )
      ).toBe(true)
      expect(
        runs.some(
          (run) => !/<w:i(?:\s|\/|>)/u.test(run) && visibleText(run).includes('Alpha paper')
        )
      ).toBe(true)
    } finally {
      engine.free()
    }
  })
  it('keeps inline emphasis separate from base formatting when changing styles again', async () => {
    const item = record()
    const service = new LiteratureCitationDocument({ getMany: async () => [item] })
    const first = await service.format({
      content: docx(
        '<w:p><w:r><w:t>{{cite:library-id}}</w:t></w:r></w:p><w:p><w:r><w:t>{{bibliography}}</w:t></w:r></w:p>'
      ),
      styleId: 'nature',
      locale: 'en-US'
    })
    expect(xmlOf(first.content)).toContain('w:val="superscript"')
    const result = await service.reformat({
      content: first.content,
      literature: {
        ...manifest(
          [item],
          first.literature.citations.map((citation) => ({ ...citation, metadataRevision: 1 }))
        ),
        styleId: 'nature'
      },
      styleId: 'apa',
      locale: 'en-US'
    })
    const xml = xmlOf(result.content)
    expect(xml).not.toContain('w:val="superscript"')
    expect(xml).not.toMatch(/<w:b\b/u)
    const runs = [...xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gu)].map((match) => match[1]!)
    expect(
      runs.some((run) => visibleText(run).includes('Alpha paper') && !/<w:i\b/u.test(run))
    ).toBe(true)
    expect(
      runs.some((run) => visibleText(run).includes('Journal of Tests') && /<w:i\b/u.test(run))
    ).toBe(true)
  })
})
