import { useEffect } from 'react'

import { useNavigationStore, type NavigationView } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore, type PreviewPanelState } from '@/stores/preview-workbench-store'

export type CloseActivePaneAction = 'collapse-pane' | 'close-window'

// Cmd+W / Ctrl+W closes the third-column preview panel when it is open in the workspace; otherwise it
// falls through to closing the window. Gating on the workspace view keeps a stale "open" panel state
// from swallowing the shortcut on the Home screen, where the panel is not rendered.
export const decideCloseActivePaneAction = (input: {
  view: NavigationView
  panelState: PreviewPanelState
}): CloseActivePaneAction =>
  input.view === 'workspace' && input.panelState === 'open' ? 'collapse-pane' : 'close-window'

// Wires the main-process close chord to the pane-vs-window decision. Store state is read imperatively
// so the subscription is installed once yet always sees the current view and panel state.
export const useCloseActivePaneShortcut = (): void => {
  useEffect(
    () =>
      window.api.window.onCloseActivePane(() => {
        const action = decideCloseActivePaneAction({
          view: useNavigationStore.getState().view,
          panelState: usePreviewWorkbenchStore.getState().panelState
        })

        if (action === 'collapse-pane') {
          usePreviewWorkbenchStore.getState().collapsePanel()
          return
        }

        void window.api.window.close()
      }),
    []
  )
}
