import { FileWarning } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'

import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

type HtmlPreviewMode = 'render' | 'source'

const HTML_PREVIEW_MODES: { id: HtmlPreviewMode; label: string; ariaLabel: string }[] = [
  { id: 'render', label: 'Render', ariaLabel: 'Show rendered HTML' },
  { id: 'source', label: 'Source', ariaLabel: 'Show HTML source' }
]

const createSandboxedHtmlDocument = (content: string): string => {
  const csp =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base href="about:srcdoc"></head><body>${content}</body></html>`
}

export const HtmlPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const [mode, setMode] = useState<HtmlPreviewMode>('render')
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        path={item.path}
        name={item.name}
        source={item.source}
        message="HTML couldn't be read for preview"
      />
    )
  }

  const modeToggle = (
    <div className="flex shrink-0 items-center justify-between border-b border-border-300 bg-bg-000 px-3 py-2">
      <div className="flex items-center gap-1 rounded-md bg-bg-200 p-0.5">
        {HTML_PREVIEW_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={option.ariaLabel}
            aria-pressed={mode === option.id}
            className={cn(
              'h-6 rounded px-2 text-[12px] text-text-300 transition-colors hover:bg-bg-000 hover:text-text-000',
              mode === option.id && 'bg-bg-000 text-text-000 shadow-sm'
            )}
            onClick={() => setMode(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )

  if (mode === 'source') {
    return (
      <SourcePreviewContent
        content={state.preview.content}
        truncated={state.preview.truncated}
        topContent={modeToggle}
      />
    )
  }

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      {modeToggle}
      {state.preview.truncated ? (
        <div className="shrink-0 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
          Preview truncated because the file is large
        </div>
      ) : null}
      <iframe
        title={`Preview of ${item.name}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={createSandboxedHtmlDocument(state.preview.content)}
        className="min-h-0 flex-1 border-0 bg-bg-000"
      />
    </div>
  )
}
