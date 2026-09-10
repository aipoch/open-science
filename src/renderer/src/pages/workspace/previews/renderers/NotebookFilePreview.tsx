import { useTranslation } from 'react-i18next'
import { FileWarning } from 'lucide-react'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { NotebookCodeBlock } from '../../notebook-code'
import { PreviewErrorCard, PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { usePreviewFileContent } from '../usePreviewFileContent'
import type { PreviewFileRendererProps } from '../preview-types'
import { notebookOutputText, parseNotebookDocument } from './notebook-document'

export const NotebookFilePreview = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent({ ...item, maxBytes: 10 * 1024 * 1024 })
  if (state.status === 'loading') return <PreviewLoadingContent />
  if (state.status === 'ready' && state.preview.truncated)
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        name={item.name}
        message={t('This Notebook exceeds the 10 MB preview limit.')}
      />
    )
  let notebook: ReturnType<typeof parseNotebookDocument> | undefined
  if (state.status === 'ready' && state.preview.encoding === 'utf8' && !state.preview.truncated) {
    try {
      notebook = parseNotebookDocument(state.preview.content)
    } catch {
      /* The standard preview error preserves access to the original file. */
    }
  }
  if (!notebook)
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("Notebook couldn't be read for preview")}
      />
    )
  return (
    <div className="saved-notebook-preview space-y-4" data-testid="saved-notebook-preview">
      {notebook.cells.slice(0, 100).map((cell, index) => (
        <section key={index} className="min-w-0">
          {cell.cell_type === 'markdown' ? (
            <AgentMarkdown content={cell.source} />
          ) : (
            <>
              <div className="mb-1 text-[10px] text-muted-foreground">
                {t('Cell {{number}}', { number: cell.execution_count ?? index + 1 })}
              </div>
              <NotebookCodeBlock
                code={cell.source}
                language={notebook.metadata?.language_info?.name}
              />
            </>
          )}
          {cell.outputs?.map((output, outputIndex) => {
            const image = notebookOutputText(output.data?.['image/png'])
            const text =
              output.text ??
              (notebookOutputText(output.data?.['text/plain']) ||
                output.traceback?.join('\n') ||
                [output.ename, output.evalue].filter(Boolean).join(': '))
            return (
              <div key={outputIndex} className="mt-2">
                {image && /^[\sA-Za-z0-9+/=]+$/.test(image) ? (
                  <img
                    src={`data:image/png;base64,${image.replace(/\s/g, '')}`}
                    alt={t('Output')}
                    className="h-auto max-w-full"
                  />
                ) : text ? (
                  <pre className="whitespace-pre-wrap break-words text-xs">{text}</pre>
                ) : null}
              </div>
            )
          })}
        </section>
      ))}
      {notebook.cells.length > 100 && (
        <p className="text-xs text-muted-foreground">
          {t('Showing {{shown}} of {{total}} cells', { shown: 100, total: notebook.cells.length })}
        </p>
      )}
    </div>
  )
}
