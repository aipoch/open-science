import { useLiteratureHost } from '../renderer-host'
import type { LiteratureCitationStyle } from '@aipoch/literature-citations/contracts'
import { useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import {
  createLiteratureClient,
  createReferenceExporter,
  type ReferenceExportRequest
} from '@aipoch/literature-library/client'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'

type ReferenceExportFormat = ReferenceExportRequest['format']

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
  exportSelectedItems: (format: ReferenceExportFormat) => Promise<boolean>
  exportCurrentScope: (format: ReferenceExportFormat) => Promise<boolean>
} {
  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const [exportReferences] = useState(() => {
    const client = createLiteratureClient(hostApi.literature)
    return createReferenceExporter({
      format: (request) => hostApi.literature.formatReferences(request),
      readItems: async (itemIds) => {
        const page = await client.readLiteratureSelectionPage({
          scope: 'library',
          lifecycle: 'active',
          itemIds: [...itemIds],
          limit: itemIds.length,
          offset: 0
        })
        if (page.entries.length !== itemIds.length || page.nextOffset !== undefined)
          throw new Error('Literature metadata is incomplete.')
        const items: LiteratureItemView[] = []
        for (const entry of page.entries) {
          if (!('item' in entry)) throw new Error('Literature metadata is unavailable.')
          items.push(entry)
        }
        return items
      },
      save: (file) => hostApi.saveBlobFile(file)
    })
  })

  const exportReferenceIds = async (
    resolveItemIds: () => Promise<readonly string[]>,
    format: ReferenceExportFormat,
    filenameStem: string
  ): Promise<boolean> => {
    setError(undefined)
    try {
      const itemIds = await resolveItemIds()
      return await exportReferences({
        itemIds,
        format,
        filenameStem,
        styleId: citationStyleRef.current,
        locale: citationLocale
      })
    } catch (error) {
      setError(t('References could not be exported.'))
      throw error
    }
  }

  const exportSelectedItems = async (format: ReferenceExportFormat): Promise<boolean> =>
    exportReferenceIds(resolveSelectedItemIds, format, 'selected-references')

  const exportCurrentScope = async (format: ReferenceExportFormat): Promise<boolean> => {
    if (!selectedProject && !selectedCollection) return false
    return exportReferenceIds(
      async () => {
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
        return page.itemIds
      },
      format,
      `${selectedProject?.name ?? selectedCollection?.name ?? 'references'}-references`
    )
  }

  return { exportSelectedItems, exportCurrentScope }
}
