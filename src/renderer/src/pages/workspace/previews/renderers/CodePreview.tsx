import { useTranslation } from 'react-i18next'

import { getFileExtension, PREVIEW_CODE_LANGUAGES } from '../../preview-support'
import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'

export const CodePreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const { item } = props
  const { t } = useTranslation()
  const state = usePreviewFileContent(item)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("Code couldn't be read for preview")}
      />
    )
  }

  return (
    <PreviewTextAnnotationSurface {...props}>
      <SourcePreviewContent
        content={state.preview.content}
        pagination={state.pagination}
        language={PREVIEW_CODE_LANGUAGES[getFileExtension(item.name)]}
      />
    </PreviewTextAnnotationSurface>
  )
}
