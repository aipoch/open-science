import { useEffect } from 'react'

import { useNavigationStore, type NavigationView } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore, type PreviewPanelState } from '@/stores/preview-workbench-store'

export type CloseActivePaneAction = 'close-active-tab' | 'collapse-pane' | 'close-window'

// Cmd+W / Ctrl+W walks a three-level ladder inside the workspace: close the active preview tab, then
// collapse the (now empty) third-column panel, then fall through to closing the window. Gating on the
// workspace view keeps a stale "open" panel state from swallowing the shortcut on the Home screen,
// where the panel is not rendered.
export const decideCloseActivePaneAction = (input: {
  view: NavigationView
  panelState: PreviewPanelState
  hasActiveTab: boolean
}): CloseActivePaneAction => {
  if (input.view === 'workspace' && input.panelState === 'open') {
    return input.hasActiveTab ? 'close-active-tab' : 'collapse-pane'
  }

  return 'close-window'
}

// Wires the main-process close chord to the tab-vs-pane-vs-window decision. Store state is read
// imperatively so the subscription is installed once yet always sees the current view and panel state.
export const useCloseActivePaneShortcut = (): void => {
  useEffect(
    () =>
      window.api.window.onCloseActivePane(() => {
        const preview = usePreviewWorkbenchStore.getState()
        const activeItem = preview.items.find((item) => item.id === preview.activeItemId)

        const action = decideCloseActivePaneAction({
          view: useNavigationStore.getState().view,
          panelState: preview.panelState,
          hasActiveTab: activeItem !== undefined
        })

        if (action === 'close-active-tab' && activeItem) {
          // Closing the last remaining tab collapses the panel in the same keypress so the shortcut
          // never leaves the third column open on its empty state. `items` is the pre-removal
          // snapshot, so length 1 means this was the final tab.
          preview.removeItem(activeItem.id)
          if (preview.items.length <= 1) preview.collapsePanel()
          return
        }

        if (action === 'collapse-pane') {
          preview.collapsePanel()
          return
        }

        void window.api.window.close()
      }),
    []
  )
}
