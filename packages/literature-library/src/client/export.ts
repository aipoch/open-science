import type {
  LiteratureFormatReferencesRequest,
  LiteratureFormatReferencesResult,
  LiteratureItemView
} from '../contracts.js'
import { referenceCsv } from './reference-csv.js'
export type ReferenceExportFormat = 'bibtex' | 'ris' | 'csv'
export type ReferenceExportRequest = {
  itemIds: readonly string[]
  format: ReferenceExportFormat
  filenameStem: string
  styleId: string
  locale: 'en-US' | 'zh-CN'
}
export type ReferenceExportFile = { suggestedName: string; mimeType: string; data: ArrayBuffer }
/** Own one export through formatting AND saving. A failed batch never publishes a partial file. */
export function createReferenceExporter(options: {
  format(request: LiteratureFormatReferencesRequest): Promise<LiteratureFormatReferencesResult>
  readItems?(itemIds: readonly string[]): Promise<readonly LiteratureItemView[]>
  save(file: ReferenceExportFile): Promise<{ saved: boolean }>
}) {
  let pending = false
  return async (request: ReferenceExportRequest): Promise<boolean> => {
    if (!request.itemIds.length || pending) return false
    pending = true
    try {
      const stem =
        request.filenameStem
          .normalize('NFKC')
          .trim()
          .replace(/[/:*?"<>|\\]/gu, '-')
          .replace(/\s+/gu, ' ')
          .slice(0, 80) || 'references'
      if (request.format === 'csv') {
        if (!options.readItems) throw new Error('Reference metadata reader is unavailable.')
        if (new Set(request.itemIds).size !== request.itemIds.length)
          throw new Error('Selected Literature Items contain duplicate ids.')
        const chunks: Uint8Array[] = [],
          encoder = new TextEncoder()
        for (let offset = 0; offset < request.itemIds.length; offset += 100) {
          const ids = request.itemIds.slice(offset, offset + 100)
          const items = await options.readItems(ids)
          const byId = new Map(items.map((item) => [item.id, item]))
          if (items.length !== ids.length || ids.some((id) => !byId.has(id)))
            throw new Error('The complete selection is unavailable for export.')
          chunks.push(
            encoder.encode(
              (offset === 0 ? '\uFEFF' : '') +
                referenceCsv(
                  ids.map((id) => byId.get(id)!),
                  offset === 0
                )
            )
          )
        }
        const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
        let position = 0
        for (const chunk of chunks) {
          data.set(chunk, position)
          position += chunk.byteLength
        }
        return (
          await options.save({
            suggestedName: `${stem}.csv`,
            mimeType: 'text/csv;charset=utf-8',
            data: data.buffer
          })
        ).saved
      }
      const chunks: string[] = [],
        keys = new Set<string>()
      for (let offset = 0; offset < request.itemIds.length; offset += 200) {
        const result = await options.format({
          itemIds: request.itemIds.slice(offset, offset + 200),
          styleId: request.styleId,
          locale: request.locale
        })
        if (request.format === 'bibtex')
          for (const match of result.exports.bibtex.matchAll(/^@[a-z]+\{([^,\r\n]+),/gimu)) {
            if (keys.has(match[1]!))
              throw new Error('Selected Literature Items have duplicate citation keys.')
            keys.add(match[1]!)
          }
        chunks.push(result.exports[request.format].trim())
      }
      const data = new TextEncoder().encode(`${chunks.filter(Boolean).join('\n\n')}\n`)
      return (
        await options.save({
          suggestedName: `${stem}.${request.format === 'bibtex' ? 'bib' : 'ris'}`,
          mimeType:
            request.format === 'bibtex'
              ? 'application/x-bibtex;charset=utf-8'
              : 'application/x-research-info-systems;charset=utf-8',
          data: data.buffer
        })
      ).saved
    } finally {
      pending = false
    }
  }
}
