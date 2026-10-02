import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  PrepareManuscriptRequest,
  PrepareManuscriptResult
} from '../../../../../../shared/manuscripts'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { PreviewTextAnnotationSurface } from '../PreviewTextAnnotationSurface'
import { SourcePreviewContent } from './SourcePreview'

type PrepareState =
  | { request: undefined; status: 'loading' }
  | { request: PrepareManuscriptRequest; status: 'error'; error: unknown }
  | { request: PrepareManuscriptRequest; status: 'ready'; value: PrepareManuscriptResult }

export const ManuscriptPreviewRenderer = (props: PreviewFileRendererProps): React.JSX.Element => {
  const { item } = props
  const { t } = useTranslation()
  const previewState = usePreviewFileContent(item)
  const [prepareState, setPrepareState] = useState<PrepareState>({
    request: undefined,
    status: 'loading'
  })
  const previewContent =
    previewState.status === 'ready' && previewState.preview.encoding === 'utf8'
      ? previewState.preview.content
      : undefined
  const previewTruncated = previewState.status === 'ready' && previewState.preview.truncated
  const prepareRequest = useMemo<PrepareManuscriptRequest | undefined>(() => {
    if (previewContent === undefined || previewTruncated) return undefined
    return {
      projectId: item.projectId ?? 'default-project',
      appSessionId: item.sessionId,
      content: previewContent
    }
  }, [item.projectId, item.sessionId, previewContent, previewTruncated])

  useEffect(() => {
    if (prepareRequest === undefined) return
    let canceled = false
    void window.api.manuscripts
      .prepare(prepareRequest)
      .then((value) => {
        if (!canceled) setPrepareState({ request: prepareRequest, status: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!canceled) setPrepareState({ request: prepareRequest, status: 'error', error })
      })
    return () => {
      canceled = true
    }
  }, [prepareRequest])

  const activePrepareState =
    prepareState.request === prepareRequest ? prepareState : ({ status: 'loading' } as const)

  if (previewState.status === 'loading') return <PreviewLoadingContent />

  if (previewState.status === 'error' || previewState.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={previewState.status === 'error' ? previewState.error : undefined}
        fallbackMessage={t("Markdown couldn't be read for preview")}
      />
    )
  }

  if (previewState.preview.truncated || previewState.pagination.pageNumber > 1) {
    return (
      <PreviewTextAnnotationSurface {...props}>
        <SourcePreviewContent
          content={previewState.preview.content}
          pagination={previewState.pagination}
        />
      </PreviewTextAnnotationSurface>
    )
  }

  if (activePrepareState.status === 'loading') return <PreviewLoadingContent />
  if (activePrepareState.status === 'error') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={activePrepareState.error}
        fallbackMessage={
          activePrepareState.error instanceof Error
            ? activePrepareState.error.message
            : String(activePrepareState.error)
        }
      />
    )
  }

  return (
    <PreviewTextAnnotationSurface {...props}>
      <div
        className={
          props.presentation === 'search' ? 'w-full' : 'size-full overflow-auto bg-bg-10 p-4'
        }
      >
        <AgentMarkdown content={activePrepareState.value.markdown} />
      </div>
    </PreviewTextAnnotationSurface>
  )
}
