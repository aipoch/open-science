import { useTranslation } from 'react-i18next'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'

export const PreviewTextContent = ({
  path,
  name,
  source = 'artifact',
  projectId,
  sessionId,
  managedFileId,
  selectedVersionId,
  annotationProps
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  managedFileId?: string
  selectedVersionId?: string
  annotationProps?: PreviewFileRendererProps
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

  const content = (
    <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  )
  return annotationProps ? (
    <PreviewTextAnnotationSurface {...annotationProps}>{content}</PreviewTextAnnotationSurface>
  ) : (
    content
  )
}

export const TextPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => (
  <PreviewTextContent
    path={props.item.path}
    name={props.item.name}
    source={props.item.source}
    projectId={props.item.projectId}
    sessionId={props.item.sessionId}
    managedFileId={props.item.managedFileId}
    selectedVersionId={props.item.selectedVersionId}
    annotationProps={props}
  />
)
