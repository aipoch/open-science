// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useResearchReplayLayout } from './use-research-replay-layout'

const options = {
  enabled: true,
  fullscreen: true,
  paneIds: ['conversation', 'notebook', 'project', 'results'],
  materialId: 'conversation',
  native: false,
  sourceKey: 'research-source'
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(cleanup)

describe('research replay layout storage', () => {
  it('uses persistent device storage for the client and session storage for the browser', () => {
    const native = renderHook(() => useResearchReplayLayout({ ...options, native: true }))
    act(() =>
      native.result.current.changePreferences({
        ...native.result.current.preferences,
        mode: 'columns',
        visiblePaneIds: options.paneIds
      })
    )
    expect(JSON.parse(localStorage.getItem('research-replay-layout:v1')!).mode).toBe('columns')
    expect(sessionStorage.length).toBe(0)
    native.unmount()

    const browser = renderHook(() => useResearchReplayLayout(options))
    expect(browser.result.current.layout.mode).toBe('split')
    act(() => browser.result.current.layout.onWidthsChange?.({ conversation: 42, notebook: 58 }))
    expect(
      JSON.parse(sessionStorage.getItem('research-replay-layout:v1:research-source')!)
        .widthsByLayout
    ).toEqual({ 'split:conversation,notebook': { conversation: 42, notebook: 58 } })
    expect(JSON.parse(localStorage.getItem('research-replay-layout:v1')!).mode).toBe('columns')
  })

  it('restores visibility and widths after a same-viewer remount, retaining preferences outside fullscreen', () => {
    const first = renderHook(() => useResearchReplayLayout(options))
    act(() =>
      first.result.current.changePreferences({
        ...first.result.current.preferences,
        mode: 'columns',
        visiblePaneIds: ['conversation', 'results']
      })
    )
    act(() => first.result.current.layout.onWidthsChange?.({ conversation: 30, results: 70 }))
    first.unmount()

    const restored = renderHook(
      (fullscreen: boolean) => useResearchReplayLayout({ ...options, fullscreen }),
      { initialProps: false }
    )
    expect(restored.result.current.layout.mode).toBe('tabs')
    expect(restored.result.current.layout.visiblePaneIds).toEqual(['conversation'])
    act(() => restored.result.current.layout.onWidthsChange?.({ conversation: 100 }))
    restored.rerender(true)
    expect(restored.result.current.layout).toMatchObject({
      mode: 'columns',
      visiblePaneIds: ['conversation', 'results'],
      widths: { conversation: 30, results: 70 }
    })
  })

  it('falls back from corrupt preferences and uses the currently selected right material', () => {
    sessionStorage.setItem('research-replay-layout:v1:research-source', '{broken')
    const view = renderHook(() => useResearchReplayLayout({ ...options, materialId: 'project' }))
    expect(view.result.current.layout).toMatchObject({
      mode: 'split',
      visiblePaneIds: ['conversation', 'project']
    })
    act(() => view.result.current.rememberMaterial('results'))
    expect(view.result.current.layout.visiblePaneIds).toEqual(['conversation', 'results'])
    act(() => view.result.current.rememberMaterial('conversation'))
    expect(view.result.current.layout.visiblePaneIds).toEqual(['conversation', 'results'])
  })
})
