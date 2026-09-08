import { FlaskConical } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { getFileExtension, getMoleculeFormat } from '../../preview-support'
import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'
import { buildReactionMarkup } from './reaction-markup'

type OclModule = typeof import('openchemlib')

const MoleculePreviewCanvas = ({
  content,
  format,
  name,
  presentation
}: {
  content: string
  format: ReturnType<typeof getMoleculeFormat>
  name: string
  presentation?: PreviewFileRendererProps['presentation']
}): React.JSX.Element => {
  const { t } = useTranslation()
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
      if (format === 'rxn') {
        // Each reaction component is bounded by the tile height so the row fits and scrolls if wide.
        const componentHeight = Math.max(80, Math.min(container.clientHeight - 24, 260))
        container.innerHTML = buildReactionMarkup(ocl, content, svgId, {
          width: Math.round(componentHeight * 1.2),
          height: componentHeight
        })
      } else {
        const molecule =
          format === 'smiles'
            ? ocl.Molecule.fromSmiles(
                content
                  .split(/\r?\n/)
                  .find((line) => line.trim())
                  ?.trim() ?? ''
              )
            : ocl.Molecule.fromMolfile(content)
        if (molecule.getAllAtoms() === 0) throw new Error(t('No atoms found'))
        container.innerHTML = molecule.toSVG(container.clientWidth, container.clientHeight, svgId, {
          autoCrop: true,
          autoCropMargin: 16
        })
      }

      setError(undefined)
    } catch (renderError) {
      container.replaceChildren()
      setError(renderError instanceof Error ? renderError.message : t('Could not render structure'))
    }
  }, [content, format, svgId, t])

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
        if (!canceled) setError(t('Molecule renderer failed to load'))
      })

    return () => {
      canceled = true
    }
  }, [renderStructure, t])

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
      {presentation !== 'search' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
          <FlaskConical className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
          <span className="truncate" title={name}>
            {t('Using OpenChemLib viewer')}
          </span>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-000">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-danger-000">
            {t('Structure could not be rendered: {{error}}', { error })}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className={cn(
            'absolute inset-0 flex items-center justify-center p-3 [&>svg]:max-h-full [&>svg]:max-w-full',
            error && 'opacity-20'
          )}
          aria-label={t('Structure preview of {{name}}', { name })}
        />
      </div>
    </div>
  )
}

export const MoleculePreviewRenderer = ({
  item,
  presentation
}: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useTranslation()
  const state = usePreviewFileContent(item)
  const [showSource, setShowSource] = useState(false)

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage={t("Structure file couldn't be read for preview")}
      />
    )
  }

  // A bounded fragment may end mid-record, so keep large structures readable through source pages.
  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  const format = getMoleculeFormat(getFileExtension(item.name), item.mimeType)
  return (
    <div className="flex size-full flex-col overflow-hidden">
      {presentation !== 'search' && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-300 px-3 py-2 text-[12px] text-text-300">
          <span>
            {!showSource && format !== 'rxn' ? t('Only the first record is previewed.') : null}
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-bg-200"
            aria-pressed={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? t('Preview') : t('Source')}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {showSource ? (
          <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
        ) : (
          <MoleculePreviewCanvas
            content={state.preview.content}
            format={format}
            name={item.name}
            presentation={presentation}
          />
        )}
      </div>
    </div>
  )
}
