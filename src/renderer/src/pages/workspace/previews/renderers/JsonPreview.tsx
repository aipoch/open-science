import { useTranslation } from 'react-i18next'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

// `unknownErrorText` is passed in because this runs outside React and can't call the t() hook; the
// caller supplies the localized wording for a thrown value that isn't an Error.
const formatJsonPreview = (
  content: string,
  unknownErrorText: string
): { formatted: string; error?: string } => {
  try {
    return { formatted: JSON.stringify(JSON.parse(content), null, 2) }
  } catch (error) {
    return {
      formatted: content,
      error: error instanceof Error ? error.message : unknownErrorText
    }
  }
}

export const JsonPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent(item)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("JSON couldn't be read for preview")}
      />
    )
  }

  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  const { formatted, error } = formatJsonPreview(state.preview.content, t('Invalid JSON'))

  const errorContent = error ? (
    <div className="shrink-0 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-danger-000">
      {t('Invalid JSON: {{error}}', { error })}
    </div>
  ) : undefined

  return <SourcePreviewContent content={formatted} topContent={errorContent} />
}
