// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore,
  type PreviewItem
} from '@/stores/preview-workbench-store'

import {
  decideCloseActivePaneAction,
  useCloseActivePaneShortcut
} from './useCloseActivePaneShortcut'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Minimal renderHook harness (the repo does not depend on @testing-library/react).
const renderHook = (hook: () => void): { unmount: () => void } => {
  const container = document.createElement('div')
  const root = createRoot(container)

  const HookHarness = (): null => {
    hook()
    return null
  }

  act(() => {
    root.render(createElement(HookHarness))
  })

  return {
    unmount: () =>
      act(() => {
        root.unmount()
      })
  }
}

// Minimal previewable file tab; only identity fields matter for the close ladder.
const fileTab = (id: string): PreviewItem => ({
  id,
  sessionId: 'session',
  type: 'file',
  path: `/tmp/${id}`,
  format: 'text',
  name: id,
  title: id
})

describe('decideCloseActivePaneAction', () => {
  it('closes the active tab when the pane is open in the workspace with a tab', () => {
    expect(
      decideCloseActivePaneAction({ view: 'workspace', panelState: 'open', hasActiveTab: true })
    ).toBe('close-active-tab')
  })

  it('collapses the pane when it is open in the workspace but has no tab', () => {
    expect(
      decideCloseActivePaneAction({ view: 'workspace', panelState: 'open', hasActiveTab: false })
    ).toBe('collapse-pane')
  })

  it('closes the window when the pane is collapsed', () => {
    expect(
      decideCloseActivePaneAction({
        view: 'workspace',
        panelState: 'collapsed',
        hasActiveTab: true
      })
    ).toBe('close-window')
  })

  it('closes the window on the Home screen even if a stale panel state is open', () => {
    expect(
      decideCloseActivePaneAction({ view: 'home', panelState: 'open', hasActiveTab: true })
    ).toBe('close-window')
    expect(
      decideCloseActivePaneAction({ view: 'home', panelState: 'collapsed', hasActiveTab: false })
    ).toBe('close-window')
  })
})

describe('useCloseActivePaneShortcut', () => {
  let closeActivePane: (() => void) | undefined
  const close = vi.fn()

  beforeEach(() => {
    closeActivePane = undefined
    close.mockClear()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    ;(window as unknown as { api: unknown }).api = {
      window: {
        close,
        onCloseActivePane: (listener: () => void) => {
          closeActivePane = listener
          return () => {
            closeActivePane = undefined
          }
        }
      }
    }
  })

  afterEach(() => {
    useNavigationStore.setState({ view: 'home' })
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  })

  it('closes the active tab and keeps the panel open when other tabs remain', () => {
    useNavigationStore.setState({ view: 'workspace' })
    const preview = usePreviewWorkbenchStore.getState()
    preview.upsertAndActivateItem(fileTab('a'))
    preview.upsertItem(fileTab('b'))

    const { unmount } = renderHook(() => useCloseActivePaneShortcut())
    act(() => closeActivePane?.())

    const state = usePreviewWorkbenchStore.getState()
    expect(state.items.map((item) => item.id)).toEqual(['b'])
    expect(state.panelState).toBe('open')
    expect(close).not.toHaveBeenCalled()
    unmount()
  })

  it('collapses the panel in the same keypress when the last tab is closed', () => {
    useNavigationStore.setState({ view: 'workspace' })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(fileTab('only'))

    const { unmount } = renderHook(() => useCloseActivePaneShortcut())
    act(() => closeActivePane?.())

    const state = usePreviewWorkbenchStore.getState()
    expect(state.items).toHaveLength(0)
    expect(state.panelState).toBe('collapsed')
    expect(close).not.toHaveBeenCalled()
    unmount()
  })

  it('collapses the panel when it is open in the workspace but empty', () => {
    useNavigationStore.setState({ view: 'workspace' })
    usePreviewWorkbenchStore.getState().openPanel()

    const { unmount } = renderHook(() => useCloseActivePaneShortcut())
    act(() => closeActivePane?.())

    expect(usePreviewWorkbenchStore.getState().panelState).toBe('collapsed')
    expect(close).not.toHaveBeenCalled()
    unmount()
  })

  it('closes the window when no panel is open', () => {
    useNavigationStore.setState({ view: 'workspace' })
    usePreviewWorkbenchStore.getState().collapsePanel()

    const { unmount } = renderHook(() => useCloseActivePaneShortcut())
    act(() => closeActivePane?.())

    expect(close).toHaveBeenCalledTimes(1)
    unmount()
  })
})
