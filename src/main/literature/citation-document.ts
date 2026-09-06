import { createHash } from 'node:crypto'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import type {
  ArtifactCitationInput,
  ArtifactLiteratureManifest,
  ArtifactLiteratureSidecar
} from '../../shared/artifact-literature'
import {
  artifactLiteratureManifestSchema,
  artifactLiteratureRequestSchema
} from '../../shared/artifact-literature'
import type {
  LiteratureCitationLocale,
  LiteratureCitationStyle,
  LiteratureItemView
} from '../../shared/literature'
import { toCslItem } from '../../shared/literature-csl'
import { LiteratureCitationFormatter } from './citation-formatter'

const DOCX_DOCUMENT_PATH = 'word/document.xml'
const CITATION_MARKER_PATTERN = /\{\{cite:([A-Za-z0-9._-]{1,512})\}\}/gu
const BIBLIOGRAPHY_MARKER = '{{bibliography}}'
const WORD_RUN_PATTERN = /<w:r\b([^>]*)>([\s\S]*?)<\/w:r>/gu
const WORD_TEXT_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu
const WORD_FIELD_PATTERN =
  /<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>\s*<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:instrText\b[^>]*>([^<]*)<\/w:instrText>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>\s*<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar\b[^>]*w:fldCharType="separate"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>([\s\S]*?)<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/gu
const MAX_DOCX_ENTRIES = 5_000
const MAX_DOCX_INFLATED_BYTES = 256 * 1024 * 1024

type CitationDocumentCatalog = Pick<
  { getMany(itemIds: readonly string[]): Promise<LiteratureItemView[]> },
  'getMany'
>

type FormatCitationDocumentRequest = Readonly<{
  content: Uint8Array
  styleId: LiteratureCitationStyle
  locale: LiteratureCitationLocale
}>

type FormattedCitationDocument = Readonly<{
  content: Uint8Array
  citationCount: number
  referenceCount: number
  literature: ArtifactLiteratureSidecar['literature']
  sidecar: ArtifactLiteratureSidecar
}>

type ReformatCitationDocumentRequest = Readonly<{
  content: Uint8Array
  literature: ArtifactLiteratureManifest
  styleId: LiteratureCitationStyle
  locale: LiteratureCitationLocale
}>

type ReformattedCitationDocument = Readonly<{
  content: Uint8Array
  citationCount: number
  referenceCount: number
  literature: ArtifactLiteratureManifest
}>

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const xmlUnescape = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')

const runProperties = (body: string): string => /<w:rPr\b[\s\S]*?<\/w:rPr>/u.exec(body)?.[0] ?? ''

const visibleRun = (text: string, properties = ''): string =>
  text ? `<w:r>${properties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>` : ''

const fieldRuns = (instruction: string, display: string, properties = ''): string =>
  [
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ${xmlEscape(instruction)} </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    visibleRun(display, properties),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  ].join('')

const zoteroCitationInstruction = (
  citation: ArtifactCitationInput,
  item: LiteratureItemView['item'],
  formattedCitation: string
): string =>
  `ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify({
    citationID: citation.citationId,
    properties: {
      formattedCitation,
      plainCitation: formattedCitation,
      noteIndex: 0
    },
    citationItems: [
      {
        id: citation.itemId,
        uris: [`https://open-science.local/literature/${encodeURIComponent(citation.itemId)}`],
        itemData: toCslItem(citation.itemId, item)
      }
    ],
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json'
  })}`

const bibliographyField = (references: readonly string[], properties = ''): string => {
  const rendered = references
    .map(
      (reference, index) =>
        `${index > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(reference)}</w:t>`
    )
    .join('')
  return [
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
    `<w:r><w:instrText xml:space="preserve"> ${xmlEscape(
      'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]}'
    )} CSL_BIBLIOGRAPHY </w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r>${properties}${rendered}</w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  ].join('')
}

const replaceRunText = (
  xml: string,
  replace: (text: string, properties: string) => string | undefined
): string =>
  xml.replace(WORD_RUN_PATTERN, (run, _attributes: string, body: string) => {
    const textNodes = [...body.matchAll(WORD_TEXT_PATTERN)]
    if (textNodes.length !== 1) return run
    const replacement = replace(xmlUnescape(textNodes[0]![1]!), runProperties(body))
    return replacement ?? run
  })

const sha256 = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex')

class LiteratureCitationDocument {
  constructor(
    private readonly catalog: CitationDocumentCatalog,
    private readonly formatter: Pick<
      LiteratureCitationFormatter,
      'formatReferences'
    > = new LiteratureCitationFormatter()
  ) {}

  async format(request: FormatCitationDocumentRequest): Promise<FormattedCitationDocument> {
    let archive: ReturnType<typeof unzipSync>
    try {
      let entryCount = 0
      let inflatedBytes = 0
      archive = unzipSync(request.content, {
        filter: (entry) => {
          entryCount += 1
          inflatedBytes += entry.originalSize
          if (entryCount > MAX_DOCX_ENTRIES || inflatedBytes > MAX_DOCX_INFLATED_BYTES) {
            throw new Error('Citation document exceeds the safe extraction limit.')
          }
          return true
        }
      })
    } catch (error) {
      throw new Error('Citation document must be a valid DOCX file.', { cause: error })
    }
    const document = archive[DOCX_DOCUMENT_PATH]
    if (!document) throw new Error('Citation document is missing word/document.xml.')
    const documentXml = strFromU8(document)
    const markerItemIds = [...documentXml.matchAll(CITATION_MARKER_PATTERN)].map(
      (match) => match[1]!
    )
    if (markerItemIds.length === 0) {
      throw new Error('Citation document contains no {{cite:itemId}} markers.')
    }
    const uniqueItemIds = [...new Set(markerItemIds)]
    const items = await this.catalog.getMany(uniqueItemIds)
    const itemsById = new Map(items.map((item) => [item.id, item]))
    for (const itemId of uniqueItemIds) {
      if (!itemsById.has(itemId)) throw new Error(`Literature Item is unavailable: ${itemId}`)
    }
    const formatted = await this.formatter.formatReferences(
      uniqueItemIds.map((id) => ({ id, item: itemsById.get(id)!.item })),
      request.styleId,
      request.locale
    )
    const formattedById = new Map(formatted.map((entry) => [entry.itemId, entry]))
    const citations: ArtifactCitationInput[] = []
    let citationIndex = 0
    let nextXml = replaceRunText(documentXml, (text, properties) => {
      if (!text.includes('{{cite:')) return undefined
      let cursor = 0
      let output = ''
      for (const marker of text.matchAll(CITATION_MARKER_PATTERN)) {
        const markerStart = marker.index
        const itemId = marker[1]!
        const item = itemsById.get(itemId)!
        const result = formattedById.get(itemId)!
        const citation: ArtifactCitationInput = {
          citationId: `open-science-${++citationIndex}`,
          itemId
        }
        citations.push(citation)
        output += visibleRun(text.slice(cursor, markerStart), properties)
        output += fieldRuns(
          zoteroCitationInstruction(citation, item.item, result.inText),
          result.inText,
          properties
        )
        cursor = markerStart + marker[0].length
      }
      output += visibleRun(text.slice(cursor), properties)
      return output
    })
    if (nextXml.includes('{{cite:')) {
      throw new Error('Each citation marker must stay inside one Word text run.')
    }
    const bibliographyCount = nextXml.split(BIBLIOGRAPHY_MARKER).length - 1
    if (bibliographyCount > 1) {
      throw new Error('Citation document may contain only one {{bibliography}} marker.')
    }
    if (bibliographyCount === 1) {
      nextXml = replaceRunText(nextXml, (text, properties) => {
        if (!text.includes(BIBLIOGRAPHY_MARKER)) return undefined
        const [before, after] = text.split(BIBLIOGRAPHY_MARKER)
        return [
          visibleRun(before ?? '', properties),
          bibliographyField(
            uniqueItemIds.map((itemId) => formattedById.get(itemId)!.reference),
            properties
          ),
          visibleRun(after ?? '', properties)
        ].join('')
      })
    }
    if (nextXml.includes(BIBLIOGRAPHY_MARKER)) {
      throw new Error('The bibliography marker must stay inside one Word text run.')
    }

    archive[DOCX_DOCUMENT_PATH] = strToU8(nextXml)
    const content = zipSync(archive, { level: 6 })
    const literature = artifactLiteratureRequestSchema.parse({
      styleId: request.styleId,
      locale: request.locale,
      citations
    })
    return {
      content,
      citationCount: citations.length,
      referenceCount: uniqueItemIds.length,
      literature,
      sidecar: {
        schemaVersion: 1,
        contentChecksum: sha256(content),
        literature
      }
    }
  }

  async reformat(request: ReformatCitationDocumentRequest): Promise<ReformattedCitationDocument> {
    const literature = artifactLiteratureManifestSchema.parse(request.literature)
    const archive = this.openDocument(request.content)
    const documentXml = strFromU8(archive[DOCX_DOCUMENT_PATH]!)
    const referencesById = new Map(
      literature.references.map((reference) => [reference.itemId, reference])
    )
    const formatted = await this.formatter.formatReferences(
      literature.references.map((reference) => ({ id: reference.itemId, item: reference.item })),
      request.styleId,
      request.locale
    )
    const formattedById = new Map(formatted.map((entry) => [entry.itemId, entry]))
    const citationsById = new Map(
      literature.citations.map((citation) => [citation.citationId, citation])
    )
    const replacedCitationIds = new Set<string>()
    let bibliographyCount = 0

    const nextXml = documentXml.replace(
      WORD_FIELD_PATTERN,
      (field, encodedInstruction: string, displayRuns: string) => {
        const instruction = xmlUnescape(encodedInstruction).trim()
        if (instruction.startsWith('ADDIN ZOTERO_BIBL ')) {
          bibliographyCount += 1
          return bibliographyField(
            literature.references.map(
              (reference) => formattedById.get(reference.itemId)!.reference
            ),
            runProperties(displayRuns)
          )
        }
        const marker = /^ADDIN ZOTERO_ITEM CSL_CITATION (\{[\s\S]*\})$/u.exec(instruction)
        if (!marker) return field
        let citationId: string | undefined
        try {
          const parsed = JSON.parse(marker[1]!) as { citationID?: unknown }
          citationId = typeof parsed.citationID === 'string' ? parsed.citationID : undefined
        } catch {
          throw new Error('Citation document contains an invalid Zotero citation field.')
        }
        const citation = citationId ? citationsById.get(citationId) : undefined
        if (!citation || replacedCitationIds.has(citation.citationId)) {
          throw new Error('Citation document does not match its Literature manifest.')
        }
        const reference = referencesById.get(citation.itemId)
        const result = formattedById.get(citation.itemId)
        if (!reference || !result) {
          throw new Error(`Literature Item is unavailable: ${citation.itemId}`)
        }
        replacedCitationIds.add(citation.citationId)
        return fieldRuns(
          zoteroCitationInstruction(citation, reference.item, result.inText),
          result.inText,
          runProperties(displayRuns)
        )
      }
    )
    if (replacedCitationIds.size !== literature.citations.length) {
      throw new Error('Citation document does not contain every recorded Zotero citation field.')
    }
    if (bibliographyCount > 1) {
      throw new Error('Citation document may contain only one Zotero bibliography field.')
    }

    archive[DOCX_DOCUMENT_PATH] = strToU8(nextXml)
    return {
      content: zipSync(archive, { level: 6 }),
      citationCount: literature.citations.length,
      referenceCount: literature.references.length,
      literature: artifactLiteratureManifestSchema.parse({
        ...literature,
        styleId: request.styleId,
        locale: request.locale
      })
    }
  }

  private openDocument(content: Uint8Array): ReturnType<typeof unzipSync> {
    let archive: ReturnType<typeof unzipSync>
    try {
      let entryCount = 0
      let inflatedBytes = 0
      archive = unzipSync(content, {
        filter: (entry) => {
          entryCount += 1
          inflatedBytes += entry.originalSize
          if (entryCount > MAX_DOCX_ENTRIES || inflatedBytes > MAX_DOCX_INFLATED_BYTES) {
            throw new Error('Citation document exceeds the safe extraction limit.')
          }
          return true
        }
      })
    } catch (error) {
      throw new Error('Citation document must be a valid DOCX file.', { cause: error })
    }
    if (!archive[DOCX_DOCUMENT_PATH]) {
      throw new Error('Citation document is missing word/document.xml.')
    }
    return archive
  }
}

export { BIBLIOGRAPHY_MARKER, LiteratureCitationDocument }
export type {
  FormatCitationDocumentRequest,
  FormattedCitationDocument,
  ReformatCitationDocumentRequest,
  ReformattedCitationDocument
}
