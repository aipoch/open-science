import { Box } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GLViewer } from '3dmol'

import { cn } from '@/lib/utils'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'
import { SourcePreviewContent } from './SourcePreview'

type ThreeDmolModule = typeof import('3dmol')
type PdbStyle = 'cartoon' | 'stick' | 'sphere' | 'surface' | 'line'

const PDB_STYLE_OPTIONS: { id: PdbStyle; label: string }[] = [
  { id: 'cartoon', label: 'Cartoon' },
  { id: 'stick', label: 'Stick' },
  { id: 'sphere', label: 'Sphere' },
  { id: 'surface', label: 'Surface' },
  { id: 'line', label: 'Line' }
]

const CARTOON_UNAVAILABLE_MESSAGE = 'Cartoon requires a protein or nucleic-acid backbone'

const PROTEIN_RESIDUE_NAMES = new Set([
  'ALA',
  'ARG',
  'ASN',
  'ASP',
  'CYS',
  'GLN',
  'GLU',
  'GLY',
  'HIS',
  'ILE',
  'LEU',
  'LYS',
  'MET',
  'PHE',
  'PRO',
  'SER',
  'THR',
  'TRP',
  'TYR',
  'VAL'
])

const NUCLEIC_ACID_RESIDUE_NAMES = new Set(['A', 'C', 'G', 'T', 'U', 'DA', 'DC', 'DG', 'DT'])

const PDB_STYLE_SPECS = {
  cartoon: {
    cartoon: { color: 'spectrum' },
    stick: { colorscheme: 'Jmol', opacity: 0.22, radius: 0.035 }
  },
  stick: { stick: { radius: 0.18, colorscheme: 'Jmol' } },
  sphere: { sphere: { scale: 0.32, colorscheme: 'Jmol' } },
  line: { line: { colorscheme: 'Jmol' } }
}

const countPdbAtoms = (content: string): number =>
  content.split(/\r?\n/).filter((line) => line.startsWith('ATOM') || line.startsWith('HETATM'))
    .length

const hasCartoonBackbone = (content: string): boolean => {
  const polymerResidues = new Set<string>()

  for (const line of content.split(/\r?\n/)) {
    if (line.slice(0, 6).trim() !== 'ATOM') continue

    const atomName = line.slice(12, 16).trim().toUpperCase()
    const residueName = line.slice(17, 20).trim().toUpperCase()
    const element = line.slice(76, 78).trim().toUpperCase()
    const residueKey = `${line.slice(21, 22)}:${line.slice(22, 27).trim()}:${residueName}`
    const isProteinBackbone =
      PROTEIN_RESIDUE_NAMES.has(residueName) &&
      atomName === 'CA' &&
      (element === '' || element === 'C')
    const isNucleicAcidBackbone = NUCLEIC_ACID_RESIDUE_NAMES.has(residueName) && atomName === 'P'

    if (isProteinBackbone || isNucleicAcidBackbone) polymerResidues.add(residueKey)

    if (polymerResidues.size >= 2) return true
  }

  return false
}

// Keeps the style switch isolated so changing buttons does not rebuild the 3D model.
const applyPdbStyle = (
  viewer: GLViewer,
  threeDmol: ThreeDmolModule,
  style: PdbStyle,
  shouldZoom: boolean,
  shouldRenderSurface?: () => boolean
): void => {
  viewer.removeAllSurfaces()

  if (style === 'surface') {
    viewer.setStyle(
      {},
      {
        cartoon: { color: 'spectrum', opacity: 0.32 },
        stick: { colorscheme: 'Jmol', opacity: 0.12, radius: 0.025 }
      }
    )
    const surface = viewer.addSurface(
      threeDmol.SurfaceType.VDW,
      { opacity: 0.72, colorscheme: 'Jmol' },
      {}
    )

    if (surface && typeof (surface as PromiseLike<unknown>).then === 'function') {
      void (surface as PromiseLike<unknown>).then(
        () => {
          if (!shouldRenderSurface || shouldRenderSurface()) viewer.render()
        },
        (error) => {
          console.error('Failed to render PDB surface', error)
        }
      )
    }
  } else {
    viewer.setStyle({}, PDB_STYLE_SPECS[style])
  }

  if (shouldZoom) viewer.zoomTo()

  viewer.render()
}

const PdbPreviewViewer = ({
  content,
  name
}: {
  content: string
  name: string
}): React.JSX.Element => {
  const viewerElementRef = useRef<HTMLDivElement | null>(null)
  const viewerStateRef = useRef<{ viewer: GLViewer; threeDmol: ThreeDmolModule } | undefined>(
    undefined
  )
  const styleRef = useRef<PdbStyle>('cartoon')
  const pendingRenderRef = useRef(false)
  const pendingZoomRef = useRef(false)
  const cartoonUnavailableDescriptionId = useId()
  const [selectedStyle, setSelectedStyle] = useState<PdbStyle | undefined>(undefined)
  const [viewerError, setViewerError] = useState<string | undefined>(undefined)
  const atomCount = useMemo(() => countPdbAtoms(content), [content])
  const supportsCartoon = useMemo(() => hasCartoonBackbone(content), [content])
  const defaultStyle: PdbStyle = supportsCartoon ? 'cartoon' : 'stick'
  const style =
    selectedStyle && (supportsCartoon || selectedStyle !== 'cartoon') ? selectedStyle : defaultStyle

  const renderCurrentStyle = useCallback((shouldZoom: boolean): boolean => {
    const viewerState = viewerStateRef.current
    const viewerElement = viewerElementRef.current

    if (
      !viewerState ||
      !viewerElement ||
      viewerElement.clientWidth <= 0 ||
      viewerElement.clientHeight <= 0
    ) {
      return false
    }

    viewerState.viewer.resize()
    applyPdbStyle(
      viewerState.viewer,
      viewerState.threeDmol,
      styleRef.current,
      shouldZoom,
      () => viewerStateRef.current?.viewer === viewerState.viewer && styleRef.current === 'surface'
    )
    pendingRenderRef.current = false
    if (shouldZoom) pendingZoomRef.current = false

    return true
  }, [])

  useEffect(() => {
    styleRef.current = style
    pendingRenderRef.current = true
    renderCurrentStyle(false)
  }, [renderCurrentStyle, style])

  useEffect(() => {
    let canceled = false
    const viewerElement = viewerElementRef.current

    if (!viewerElement) return

    setViewerError(undefined)
    pendingRenderRef.current = true
    pendingZoomRef.current = true
    viewerElement.replaceChildren()

    void import('3dmol')
      .then((threeDmol) => {
        if (canceled) return

        const viewer = threeDmol.createViewer(viewerElement, { backgroundColor: 'white' })
        viewer.addModel(content, 'pdb', {
          assignBonds: true,
          noComputeSecondaryStructure: false
        })
        viewerStateRef.current = { viewer, threeDmol }
        renderCurrentStyle(true)
      })
      .catch((error) => {
        console.error('Failed to initialize PDB preview', error)
        if (!canceled) setViewerError(error instanceof Error ? error.message : 'Viewer failed')
      })

    return () => {
      canceled = true
      pendingRenderRef.current = false
      pendingZoomRef.current = false
      viewerStateRef.current?.viewer.clear()
      viewerStateRef.current = undefined
      viewerElement.replaceChildren()
    }
  }, [content, renderCurrentStyle])

  useEffect(() => {
    const viewerElement = viewerElementRef.current

    if (!viewerElement || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      const viewerState = viewerStateRef.current

      if (!viewerState) return
      if (viewerElement.clientWidth <= 0 || viewerElement.clientHeight <= 0) return

      if (pendingRenderRef.current || pendingZoomRef.current) {
        renderCurrentStyle(pendingZoomRef.current)
        return
      }

      viewerState.viewer.resize()
      viewerState.viewer.render()
    })
    resizeObserver.observe(viewerElement)

    return () => {
      resizeObserver.disconnect()
    }
  }, [renderCurrentStyle])

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-300 bg-bg-000 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-text-300">
          <Box className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
          <span className="truncate" title={name}>
            Using 3Dmol.js viewer
          </span>
        </div>
        <div className="shrink-0 text-[12px] text-text-300">{atomCount.toLocaleString()} atoms</div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2">
        <span className="text-[12px] text-text-300">Style:</span>
        {!supportsCartoon ? (
          <span id={cartoonUnavailableDescriptionId} className="sr-only">
            {CARTOON_UNAVAILABLE_MESSAGE}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {PDB_STYLE_OPTIONS.map((option) => {
            const isActive = style === option.id
            const isDisabled = option.id === 'cartoon' && !supportsCartoon

            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={isActive}
                aria-disabled={isDisabled || undefined}
                aria-describedby={isDisabled ? cartoonUnavailableDescriptionId : undefined}
                title={isDisabled ? CARTOON_UNAVAILABLE_MESSAGE : option.label}
                className={cn(
                  'h-6 rounded-md px-2.5 text-[12px] text-text-300 transition-colors hover:bg-bg-300 hover:text-text-000',
                  isActive &&
                    'bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground',
                  isDisabled &&
                    'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-text-300'
                )}
                onClick={() => {
                  if (isDisabled) return
                  setSelectedStyle(option.id)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-000">
        {viewerError ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-danger-000">
            PDB viewer could not be initialized: {viewerError}
          </div>
        ) : null}
        <div
          ref={viewerElementRef}
          className={cn('absolute inset-0', viewerError && 'opacity-20')}
          aria-label={`3D preview of ${name}`}
        />
      </div>
      <div className="flex shrink-0 items-center border-t border-border-300 bg-bg-000 px-3 py-1.5 text-[11px] leading-4 text-text-300">
        Drag to rotate · Scroll to zoom · Shift + drag to pan
      </div>
    </div>
  )
}

export const PdbPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const state = usePreviewFileContent({ path: item.path, source: item.source })

  if (state.status === 'loading') return <PreviewLoadingContent />

  if (state.status === 'error' || state.preview.encoding !== 'utf8') {
    return (
      <PreviewErrorCard
        name={item.name}
        error={state.status === 'error' ? state.error : undefined}
        fallbackMessage="PDB couldn't be read for preview"
      />
    )
  }

  if (state.preview.truncated || state.pagination.pageNumber > 1) {
    return <SourcePreviewContent content={state.preview.content} pagination={state.pagination} />
  }

  return <PdbPreviewViewer content={state.preview.content} name={item.name} />
}
