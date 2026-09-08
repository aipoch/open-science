import { createHash } from 'node:crypto'

import { strToU8, zipSync } from 'fflate'

import {
  artifactLiteratureRequestSchema,
  type ArtifactCitationInput,
  type ArtifactLiteratureSidecar
} from '../../shared/artifact-literature'
import type { LiteratureItemView } from '../../shared/literature'
import { citationKey, LiteratureCitationFormatter } from './citation-formatter'

const CITATION_MARKER_PATTERN = /\{\{cite:([A-Za-z0-9._-]{1,512})\}\}/gu
const BIBLIOGRAPHY_MARKER = '{{bibliography}}'

type LatexBundleCatalog = Pick<
  { getMany(itemIds: readonly string[]): Promise<LiteratureItemView[]> },
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
  sidecar: ArtifactLiteratureSidecar
}>

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex')

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
    if (!/\\usepackage(?:\[[^\]]*\])?\{biblatex\}/u.test(request.content)) {
      throw new Error('LaTeX document must load the biblatex package.')
    }
    if (!/\\addbibresource(?:\[[^\]]*\])?\{references\.bib\}/u.test(request.content)) {
      throw new Error('LaTeX document must add references.bib as its bibliography resource.')
    }

    const citations: ArtifactCitationInput[] = []
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
    const literature = artifactLiteratureRequestSchema.parse({
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
