// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

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

describe('decideCloseActivePaneAction', () => {
  it('collapses the pane only when it is open in the workspace', () => {
    expect(decideCloseActivePaneAction({ view: 'workspace', panelState: 'open' })).toBe(
      'collapse-pane'
    )
  })

  it('closes the window when the pane is collapsed', () => {
    expect(decideCloseActivePaneAction({ view: 'workspace', panelState: 'collapsed' })).toBe(
      'close-window'
    )
  })

  it('closes the window on the Home screen even if a stale panel state is open', () => {
    expect(decideCloseActivePaneAction({ view: 'home', panelState: 'open' })).toBe('close-window')
    expect(decideCloseActivePaneAction({ view: 'home', panelState: 'collapsed' })).toBe(
      'close-window'
    )
  })
})

describe('useCloseActivePaneShortcut', () => {
  let closeActivePane: (() => void) | undefined
  const close = vi.fn()

  beforeEach(() => {
    closeActivePane = undefined
    close.mockClear()
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
    usePreviewWorkbenchStore.getState().collapsePanel()
  })

  it('collapses the panel when it is open in the workspace', () => {
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
