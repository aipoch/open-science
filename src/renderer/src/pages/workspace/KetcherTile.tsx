import { FlaskConical } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import type { Ketcher } from 'ketcher-core'

import type { PreviewToolItem } from '@/stores/preview-workbench-store'

import { PreviewLoadingContent } from './previews/PreviewFallback'
import {
  registerKetcherTile,
  unregisterKetcherTile,
  type KetcherTileHandle
} from './ketcher-tile-bridge'
import type {
  KetcherHighlightPayload,
  KetcherSetPayload,
  KetcherStructureFormat
} from '../../../../shared/ketcher'

export type KetcherPreviewItem = PreviewToolItem & {
  toolKind: 'ketcher'
  ketcher: NonNullable<PreviewToolItem['ketcher']>
}

// Throttle window for persisting canvas edits back to the .ket artifact — long enough to coalesce a
// burst of drawing actions, short enough that a read-back after editing sees the latest structure.
const SAVE_THROTTLE_MS = 800

// Loads the Ketcher react editor + standalone WASM Indigo backend only when a sketcher tile mounts,
// mirroring KetcherPreview's lazy import so the heavy bundle never enters the main chunk.
const KetcherEditor = lazy(async () => {
  const [{ Editor }, { StandaloneStructServiceProvider }] = await Promise.all([
    import('ketcher-react'),
    import('ketcher-standalone')
  ])
  await import('ketcher-react/dist/index.css')

  const structServiceProvider = new StandaloneStructServiceProvider()

  const Canvas = ({
    content,
    onReady
  }: {
    content: string
    onReady: (ketcher: Ketcher) => void
  }): React.JSX.Element => (
    <Editor
      staticResourcesUrl=""
      structServiceProvider={structServiceProvider}
      errorHandler={(message) => console.error('Ketcher tile error', message)}
      onInit={(ketcher) => {
        // Seed the canvas from the artifact; Ketcher auto-detects ket/molfile/rxn/SMILES from the text.
        if (content.trim().length > 0) void ketcher.setMolecule(content)
        onReady(ketcher)
      }}
    />
  )

  return { default: Canvas }
})

// The Ketcher public type exposes the micro-editor as an opaque `editor`; these are the loosely-typed
// internals (canvas render tree, action dispatch, change stream) the tile needs to drive and observe it.
type MicroEditor = {
  render: { ctab: unknown }
  update: (action: unknown) => void
  subscribe: (event: string, handler: () => void) => unknown
  unsubscribe: (event: string, handler: unknown) => void
}

const microEditor = (ketcher: Ketcher): MicroEditor => ketcher.editor as unknown as MicroEditor

// Renders one atom/bond highlight on the mounted canvas via Ketcher's editor action.
const applyHighlight = async (
  ketcher: Ketcher,
  payload: KetcherHighlightPayload
): Promise<void> => {
  const { fromHighlightCreate } = await import('ketcher-core')
  const editor = microEditor(ketcher)
  const action = fromHighlightCreate(editor.render.ctab as never, [
    {
      atoms: payload.atoms ?? [],
      bonds: payload.bonds ?? [],
      rgroupAttachmentPoints: [],
      color: payload.color ?? '#faa'
    }
  ])
  editor.update(action)
}

// Reads the current structure back from the canvas in the requested serialization.
const readStructure = (ketcher: Ketcher, format: KetcherStructureFormat): Promise<string> => {
  if (format === 'molfile') return ketcher.getMolfile()
  if (format === 'smiles') return ketcher.getSmiles()
  return ketcher.getKet()
}

// A live, editable sketcher tile: it registers with the tool-host bridge on mount so open/set/highlight/
// get commands can target it, and throttles canvas edits back to the artifact so they survive a reload.
export const KetcherTile = ({ item }: { item: KetcherPreviewItem }): React.JSX.Element => {
  const { artifactId, content, name } = item.ketcher
  const ketcherRef = useRef<Ketcher | null>(null)
  const [ready, setReady] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Persist the current canvas as ket, coalescing rapid edits into one write per throttle window.
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) return

    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const ketcher = ketcherRef.current
      if (!ketcher) return

      void ketcher
        .getKet()
        .then((ket) => window.api.ketcher.save({ artifactId, ket }))
        .catch((error: unknown) => console.error('Ketcher tile save failed', error))
    }, SAVE_THROTTLE_MS)
  }, [artifactId])

  const handleReady = useCallback((ketcher: Ketcher): void => {
    ketcherRef.current = ketcher
    setReady(true)
  }, [])

  // Register the imperative handle once the editor is live, and mirror edits back to the artifact.
  useEffect(() => {
    const ketcher = ketcherRef.current
    if (!ready || !ketcher) return

    const handle: KetcherTileHandle = {
      setStructure: async (payload: KetcherSetPayload) => {
        const structure = payload.ket ?? payload.molfile ?? payload.smiles ?? ''
        await ketcher.setMolecule(structure)
        scheduleSave()
      },
      highlight: (payload) => applyHighlight(ketcher, payload),
      getStructure: (format) => readStructure(ketcher, format)
    }

    registerKetcherTile(artifactId, handle)
    const editor = microEditor(ketcher)
    const changeHandler = (): void => scheduleSave()
    const subscriber = editor.subscribe('change', changeHandler)

    return () => {
      editor.unsubscribe('change', subscriber)
      unregisterKetcherTile(artifactId)
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [ready, artifactId, scheduleSave])

  return (
    <div className="flex size-full flex-col overflow-hidden bg-bg-10">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 bg-bg-000 px-3 py-2 text-[12px] text-text-300">
        <FlaskConical className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        <span className="truncate" title={name}>
          Ketcher sketcher · {name}
        </span>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-bg-000"
        aria-label={`Molecule sketcher for ${name}`}
      >
        <Suspense fallback={<PreviewLoadingContent />}>
          <KetcherEditor content={content} onReady={handleReady} />
        </Suspense>
      </div>
    </div>
  )
}
