import { createHash } from 'node:crypto'

import { strToU8, zipSync } from 'fflate'

import {
  citationRequestSchema,
  type CitationInput,
  type CitationSidecar
} from './document-contracts.js'
import type { CitationDocumentRecord } from './document-contracts.js'
import { citationKey, LiteratureCitationFormatter } from './citation-formatter.js'

const CITATION_MARKER_PATTERN = /\{\{cite:([A-Za-z0-9._-]{1,512})\}\}/gu
const BIBLIOGRAPHY_MARKER = '{{bibliography}}'

type LatexBundleCatalog = Pick<
  { getMany(itemIds: readonly string[]): Promise<CitationDocumentRecord[]> },
  'getMany'
>

type PrepareLatexBundleRequest = Readonly<{
  content: string
  sourceName: string
}>

type PreparedLatexBundle = Readonly<{
  content: Uint8Array
  citationCount: number
  referenceCount: number
  sidecar: CitationSidecar
}>

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

const hasLatexCommand = (
  content: string,
  command: 'usepackage' | 'addbibresource',
  argument: string
): boolean => {
  const prefix = `\\${command}`
  const optionPrefix = new RegExp(String.raw`\\${command}[ \t\r\n\f]*\[`, 'u')
  // Literal argument ranges do not overlap, even in malformed input with nested braces.
  for (const match of content.matchAll(/\{([^{}]*)\}/gu)) {
    const value = match[1]!
    const matchesArgument =
      command === 'usepackage'
        ? value.split(',').some((name) => name.trim() === argument)
        : value === argument
    if (!matchesArgument) continue
    let start = match.index!
    while (start > 0 && /[ \t\r\n\f]/u.test(content[start - 1]!)) start--
    if (content[start - 1] !== ']') {
      if (content.endsWith(prefix, start)) return true
      continue
    }
    // Each closing bracket can precede only one argument. Searching back to the previous
    // closing bracket keeps option ranges disjoint, without caching parser positions.
    const previous = content.lastIndexOf(']', start - 2)
    if (optionPrefix.test(content.slice(previous + 1, start - 1))) return true
  }
  return false
}

class LiteratureLatexBundle {
  constructor(
    private readonly catalog: LatexBundleCatalog,
    private readonly formatter: Pick<
      LiteratureCitationFormatter,
      'exportReferences'
    > = new LiteratureCitationFormatter()
  ) {}

  async prepare(request: PrepareLatexBundleRequest): Promise<PreparedLatexBundle> {
    if (!/^[^/\\]+\.tex$/iu.test(request.sourceName)) {
      throw new Error('LaTeX source name must be a plain .tex filename.')
    }
    const markerItemIds = [...request.content.matchAll(CITATION_MARKER_PATTERN)].map(
      (match) => match[1]!
    )
    if (markerItemIds.length === 0) {
      throw new Error('LaTeX document contains no {{cite:itemId}} markers.')
    }
    if (markerItemIds.length > 200) {
      throw new Error('LaTeX document contains more than 200 citation markers.')
    }

    const uniqueItemIds = [...new Set(markerItemIds)]
    const items = await this.catalog.getMany(uniqueItemIds)
    const itemsById = new Map(items.map((item) => [item.id, item]))
    for (const itemId of uniqueItemIds) {
      if (!itemsById.has(itemId)) throw new Error(`Literature Item is unavailable: ${itemId}`)
    }

    const keysByItemId = new Map(
      uniqueItemIds.map((itemId) => [
        itemId,
        citationKey(`os${sha256(itemId).slice(0, 12)}`, itemsById.get(itemId)!.item)
      ])
    )
    if (new Set(keysByItemId.values()).size !== keysByItemId.size) {
      throw new Error('Selected Literature Items have duplicate citation keys.')
    }
    if (!hasLatexCommand(request.content, 'usepackage', 'biblatex')) {
      throw new Error('LaTeX document must load the biblatex package.')
    }
    if (!hasLatexCommand(request.content, 'addbibresource', 'references.bib')) {
      throw new Error('LaTeX document must add references.bib as its bibliography resource.')
    }

    const citations: CitationInput[] = []
    let citationIndex = 0
    let latex = request.content.replace(CITATION_MARKER_PATTERN, (_marker, itemId: string) => {
      citations.push({ citationId: `open-science-latex-${++citationIndex}`, itemId })
      return `\\cite{${keysByItemId.get(itemId)!}}`
    })
    if (latex.includes('{{cite:')) {
      throw new Error('LaTeX document contains an invalid citation marker.')
    }

    const bibliographyCount = latex.split(BIBLIOGRAPHY_MARKER).length - 1
    if (bibliographyCount > 1) {
      throw new Error('LaTeX document may contain only one {{bibliography}} marker.')
    }
    latex = latex.replace(BIBLIOGRAPHY_MARKER, '\\printbibliography')

    const references = uniqueItemIds.map((itemId) => ({
      id: keysByItemId.get(itemId)!,
      item: itemsById.get(itemId)!.item
    }))
    const bibtex = await this.formatter.exportReferences(references, 'bibtex')
    const bundleManifest = {
      schemaVersion: 1,
      citations: uniqueItemIds.map((itemId) => ({
        citationKey: keysByItemId.get(itemId)!,
        itemId,
        metadataRevision: itemsById.get(itemId)!.metadataRevision
      }))
    }
    const content = zipSync(
      {
        [request.sourceName]: strToU8(latex),
        'references.bib': strToU8(bibtex),
        '.open-science-literature.json': strToU8(`${JSON.stringify(bundleManifest, null, 2)}\n`)
      },
      { level: 6 }
    )
    const literature = citationRequestSchema.parse({
      styleId: 'biblatex',
      locale: 'en-US',
      citations
    })

    return {
      content,
      citationCount: citations.length,
      referenceCount: uniqueItemIds.length,
      sidecar: {
        schemaVersion: 1,
        contentChecksum: sha256(content),
        literature
      }
    }
  }
}

export { LiteratureLatexBundle }
export type { PrepareLatexBundleRequest, PreparedLatexBundle }
