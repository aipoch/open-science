import { FileWarning, FlaskConical } from 'lucide-react'
import { Suspense, lazy } from 'react'

import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'

// Ketcher (react editor + standalone WASM Indigo backend) is heavy, so it is loaded only when a
// molecule preview actually mounts — mirrors how PdbPreview lazy-imports 3Dmol.
const KetcherCanvas = lazy(async () => {
  const [{ Editor }, { StandaloneStructServiceProvider }] = await Promise.all([
    import('ketcher-react'),
    import('ketcher-standalone')
  ])
  await import('ketcher-react/dist/index.css')

  const structServiceProvider = new StandaloneStructServiceProvider()

  const Canvas = ({ content }: { content: string }): React.JSX.Element => (
    <Editor
      staticResourcesUrl=""
      structServiceProvider={structServiceProvider}
      errorHandler={(message) => console.error('Ketcher preview error', message)}
      onInit={(ketcher) => {
        // Ketcher auto-detects the input format (ket JSON, molfile, rxn, SMILES) from the string.
        void ketcher.setMolecule(content)
      }}
    />
  )

  return { default: Canvas }
})

const KetcherPreviewViewer = ({
  content,
  name
}: {
  content: string
  name: string
}): React.JSX.Element => (
  <div className="flex size-full flex-col overflow-hidden bg-bg-10">
    <div className="flex shrink-0 items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
      <FlaskConical className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
      <span className="truncate" title={name}>
        Using Ketcher (Indigo) viewer
      </span>
    </div>
    <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-000" aria-label={`Structure preview of ${name}`}>
      <Suspense fallback={<PreviewLoadingContent />}>
        <KetcherCanvas content={content} />
      </Suspense>
    </div>
  </div>
)

export const KetcherPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        path={item.path}
        name={item.name}
        source={item.source}
        message="Structure file couldn't be read for preview"
      />
    )
  }

  return <KetcherPreviewViewer content={state.preview.content} name={item.name} />
}
