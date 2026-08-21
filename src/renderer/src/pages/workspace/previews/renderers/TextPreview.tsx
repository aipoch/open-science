import { useTranslation } from 'react-i18next'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

export const PreviewTextContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent({
    path,
    source,
    projectId,
    sessionId,
    managedFileId,
    selectedVersionId
  })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("File couldn't be read for preview")}
      />
    )
  }

  return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
}

export const TextPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewTextContent
    path={item.path}
    name={item.name}
    source={item.source}
    projectId={item.projectId}
    sessionId={item.sessionId}
    managedFileId={item.managedFileId}
    selectedVersionId={item.selectedVersionId}
  />
)
