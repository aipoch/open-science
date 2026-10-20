import { useLiteratureHost } from '../renderer-host'
import type { LiteratureCitationStyle } from '@aipoch/literature-citations/contracts'
import { useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { createReferenceExporter } from '@aipoch/literature-library/client'

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
  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const [exportReferences] = useState(() =>
    createReferenceExporter({
      format: (request) => hostApi.literature.formatReferences(request),
      save: (file) => hostApi.saveBlobFile(file)
    })
  )

  const exportReferenceIds = async (
    itemIds: readonly string[],
    format: 'bibtex' | 'ris',
    filenameStem: string
  ): Promise<boolean> => {
    return exportReferences({
      itemIds,
      format,
      filenameStem,
      styleId: citationStyleRef.current,
      locale: citationLocale
    })
  }

  const exportSelectedItems = async (format: 'bibtex' | 'ris'): Promise<boolean> => {
    setError(undefined)
    try {
      const itemIds = await resolveSelectedItemIds()
      return await exportReferenceIds(itemIds, format, 'selected-references')
    } catch (error) {
      setError(t('References could not be exported.'))
      throw error
    }
  }

  const exportCurrentScope = async (format: 'bibtex' | 'ris'): Promise<boolean> => {
    if (!selectedProject && !selectedCollection) return false
    setError(undefined)
    try {
      const page = await hostApi.literature.search({
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
