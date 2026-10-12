import type {
  LiteratureFormatReferencesRequest,
  LiteratureFormatReferencesResult
} from '../contracts.js'
export type ReferenceExportRequest = {
  itemIds: readonly string[]
  format: 'bibtex' | 'ris'
  filenameStem: string
  styleId: string
  locale: 'en-US' | 'zh-CN'
}
export type ReferenceExportFile = { suggestedName: string; mimeType: string; data: ArrayBuffer }
/** Own one export through formatting AND saving. A failed batch never publishes a partial file. */
export function createReferenceExporter(options: {
  format(request: LiteratureFormatReferencesRequest): Promise<LiteratureFormatReferencesResult>
  save(file: ReferenceExportFile): Promise<{ saved: boolean }>
}) {
  let pending = false
  return async (request: ReferenceExportRequest): Promise<boolean> => {
    if (!request.itemIds.length || pending) return false
    pending = true
    try {
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
      const stem =
        request.filenameStem
          .normalize('NFKC')
          .trim()
          .replace(/[/:*?"<>|\\]/gu, '-')
          .replace(/\s+/gu, ' ')
          .slice(0, 80) || 'references'
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
