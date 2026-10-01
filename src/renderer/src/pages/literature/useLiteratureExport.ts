import { useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCitationStyle } from '../../../../shared/literature'

const LITERATURE_BATCH_COMMAND_SIZE = 200

export function useLiteratureExport({
  citationStyle: citationStyleRef,
  locale: citationLocale,
  selectedProject,
  selectedCollection,
  resolveSelectedItemIds,
  onError: setError
}: {
  citationStyle: RefObject<LiteratureCitationStyle>
  locale: 'en-US' | 'zh-CN'
  selectedProject?: { id: string; name: string }
  selectedCollection?: { id: string; name: string }
  resolveSelectedItemIds: () => Promise<string[]>
  onError: (message: string | undefined) => void
}): {
  exportSelectedItems: (format: 'bibtex' | 'ris') => Promise<boolean>
  exportCurrentScope: (format: 'bibtex' | 'ris') => Promise<boolean>
} {
  const { t } = useTranslation()
  const exportInFlightRef = useRef(false)

  const exportReferenceIds = async (
    itemIds: readonly string[],
    format: 'bibtex' | 'ris',
    filenameStem: string
  ): Promise<boolean> => {
    if (itemIds.length === 0 || exportInFlightRef.current) return false
    exportInFlightRef.current = true
    setError(undefined)
    try {
      const chunks: string[] = []
      const citationKeys = new Set<string>()
      for (let offset = 0; offset < itemIds.length; offset += LITERATURE_BATCH_COMMAND_SIZE) {
        const result = await window.api.literature.formatReferences({
          itemIds: itemIds.slice(offset, offset + LITERATURE_BATCH_COMMAND_SIZE),
          styleId: citationStyleRef.current,
          locale: citationLocale
        })
        if (format === 'bibtex') {
          // These headers come from our BibTeX exporter, whose keys are validated before emission.
          for (const match of result.exports.bibtex.matchAll(/^@[a-z]+\{([^,\r\n]+),/gimu)) {
            const key = match[1]!
            if (citationKeys.has(key))
              throw new Error('Selected Literature Items have duplicate citation keys.')
            citationKeys.add(key)
          }
        }
        chunks.push(result.exports[format].trim())
      }
      const content = `${chunks.filter(Boolean).join('\n\n')}\n`
      const encoded = new TextEncoder().encode(content)
      const safeStem =
        filenameStem
          .normalize('NFKC')
          .trim()
          .replace(/[/:*?"<>|\\]/gu, '-')
          .replace(/\s+/gu, ' ')
          .slice(0, 80) || 'references'
      const result = await window.api.saveBlobFile({
        suggestedName: `${safeStem}.${format === 'bibtex' ? 'bib' : 'ris'}`,
        mimeType:
          format === 'bibtex'
            ? 'application/x-bibtex;charset=utf-8'
            : 'application/x-research-info-systems;charset=utf-8',
        data: encoded.buffer
      })
      return result.saved
    } catch (exportError) {
      setError(t('References could not be exported.'))
      throw exportError
    } finally {
      exportInFlightRef.current = false
    }
  }

  const exportSelectedItems = async (format: 'bibtex' | 'ris'): Promise<boolean> =>
    exportReferenceIds(await resolveSelectedItemIds(), format, 'selected-references')

  const exportCurrentScope = async (format: 'bibtex' | 'ris'): Promise<boolean> => {
    if (!selectedProject && !selectedCollection) return false
    try {
      const page = await window.api.literature.search({
        scope: 'library',
        ...(selectedProject ? { projectId: selectedProject.id } : {}),
        ...(selectedCollection ? { collectionId: selectedCollection.id } : {}),
        lifecycle: 'active',
        sortBy: 'title',
        sortDirection: 'asc',
        allItemIds: true
      })
      if (!page.itemIds) throw new Error('Literature membership is unavailable.')
      return await exportReferenceIds(
        page.itemIds,
        format,
        `${selectedProject?.name ?? selectedCollection?.name ?? 'references'}-references`
      )
    } catch (error) {
      setError(t('References could not be exported.'))
      throw error
    }
  }

  return { exportSelectedItems, exportCurrentScope }
}
