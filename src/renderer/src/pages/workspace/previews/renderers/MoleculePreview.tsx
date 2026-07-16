import { FlaskConical } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import { getFileExtension } from '../../preview-support'
import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'
import { buildReactionMarkup } from './reaction-markup'

type OclModule = typeof import('openchemlib')

// SMILES sources parse via fromSmiles; molfile/SDF via fromMolfile (which reads the first record).
const SMILES_EXTENSIONS = new Set(['smi', 'smiles'])
// MDL reaction files render as a laid-out row of component depictions instead of one molecule.
const REACTION_EXTENSIONS = new Set(['rxn'])

const MoleculePreviewCanvas = ({
  content,
  extension,
  name
}: {
  content: string
  extension: string
  name: string
}): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const oclRef = useRef<OclModule | undefined>(undefined)
  // OCL namespaces the SVG's internal ids with this string; useId() carries colons that are invalid there.
  const svgId = `mol-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const [error, setError] = useState<string | undefined>(undefined)

  // Renders the structure to an SVG sized to the current container, re-run on load and on resize.
  const renderStructure = useCallback((): void => {
    const ocl = oclRef.current
    const container = containerRef.current

    if (!ocl || !container) return
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return

    try {
      if (REACTION_EXTENSIONS.has(extension)) {
        // Each reaction component is bounded by the tile height so the row fits and scrolls if wide.
        const componentHeight = Math.max(80, Math.min(container.clientHeight - 24, 260))
        container.innerHTML = buildReactionMarkup(ocl, content, svgId, {
          width: Math.round(componentHeight * 1.2),
          height: componentHeight
        })
      } else {
        const molecule = SMILES_EXTENSIONS.has(extension)
          ? ocl.Molecule.fromSmiles(content)
          : ocl.Molecule.fromMolfile(content)
        container.innerHTML = molecule.toSVG(container.clientWidth, container.clientHeight, svgId, {
          autoCrop: true,
          autoCropMargin: 16
        })
      }

      setError(undefined)
    } catch (renderError) {
      container.replaceChildren()
      setError(renderError instanceof Error ? renderError.message : 'Could not render structure')
    }
  }, [content, extension, svgId])

  useEffect(() => {
    let canceled = false

    void import('openchemlib')
      .then((ocl) => {
        if (canceled) return
        oclRef.current = ocl
        renderStructure()
      })
      .catch((importError) => {
        console.error('Failed to load molecule renderer', importError)
        if (!canceled) setError('Molecule renderer failed to load')
      })

    return () => {
      canceled = true
    }
  }, [renderStructure])

  useEffect(() => {
    const container = containerRef.current

    if (!container || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => renderStructure())
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
    }
  }, [renderStructure])

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
        <FlaskConical className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        <span className="truncate" title={name}>
          Using OpenChemLib viewer
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-000">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-danger-000">
            Structure could not be rendered: {error}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className={cn(
            'absolute inset-0 flex items-center justify-center p-3 [&>svg]:max-h-full [&>svg]:max-w-full',
            error && 'opacity-20'
          )}
          aria-label={`Structure preview of ${name}`}
        />
      </div>
    </div>
  )
}

export const MoleculePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        path={item.path}
        name={item.name}
        source={item.source}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage="Structure file couldn't be read for preview"
      />
    )
  }

  // A bounded fragment may end mid-record, so keep large structures readable through source pages.
  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  return (
    <MoleculePreviewCanvas
      content={state.preview.content}
      extension={getFileExtension(item.name)}
      name={item.name}
    />
  )
}
