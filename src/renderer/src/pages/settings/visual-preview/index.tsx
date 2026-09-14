// Preview root for the settings visual preview. Mounted by SettingsPage (only when the preview
// flag is active) and owns the change tour: selection state, activation of each scenario, the
// floating toolbar, and the red-frame markers.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { SettingsPanelId } from '../settings-navigation'
import { SETTINGS_VISUAL_CHANGES } from './changes'
import { VISUAL_PREVIEW_COPY as COPY } from './copy'
import { exitSettingsVisualPreview, resetSettingsPreviewState } from './preview-store'
import { VisualPreviewMarkers } from './VisualPreviewMarkers'
import { VisualPreviewToolbar } from './VisualPreviewToolbar'

type SettingsVisualPreviewRootProps = {
  navigatePanel: (panel: SettingsPanelId) => void
}

export const SettingsVisualPreviewRoot = ({
  navigatePanel
}: SettingsVisualPreviewRootProps): React.JSX.Element => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [markersVisible, setMarkersVisible] = useState(true)
  const [unreachableId, setUnreachableId] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const activationSequence = useRef(0)

  const activate = useCallback(
    async (index: number): Promise<void> => {
      const change = SETTINGS_VISUAL_CHANGES[index]
      if (!change) return
      const sequence = ++activationSequence.current
      setUnreachableId(null)
      const reached = await change.activate({ navigatePanel })
      // A newer activation superseded this one while it polled; keep its outcome.
      if (sequence !== activationSequence.current) return
      if (reached) {
        setSelectedIndex(index)
      } else {
        // Keep the previous selection; only report which target could not be reached.
        setUnreachableId(change.id)
      }
    },
    [navigatePanel]
  )

  // Choose the first item on entry (deferred so no setState runs synchronously in the effect
  // body). Fixtures reset on unmount so a later preview session (or a normal one) never inherits
  // tour mutations.
  useEffect(() => {
    const entryActivation = window.setTimeout(() => void activate(0), 0)
    return () => {
      window.clearTimeout(entryActivation)
      resetSettingsPreviewState()
    }
    // Mount-only entry activation; `activate` is stable for the lifetime of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (exited) {
    return createPortal(
      <div className="pointer-events-auto fixed bottom-4 right-4 z-[120] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-dialog">
        {COPY.exitHint}
      </div>,
      document.body
    )
  }

  return (
    <>
      <VisualPreviewMarkers visible={markersVisible} chipLabel={COPY.changeChip} />
      <VisualPreviewToolbar
        selectedIndex={selectedIndex}
        unreachableId={unreachableId}
        markersVisible={markersVisible}
        onSelect={(index) => void activate(index)}
        onMarkersVisibleChange={setMarkersVisible}
        onExit={() => {
          exitSettingsVisualPreview()
          resetSettingsPreviewState()
          setExited(true)
        }}
      />
    </>
  )
}
