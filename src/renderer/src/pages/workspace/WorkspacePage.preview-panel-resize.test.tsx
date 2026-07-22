// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'

const workspacePageHarness = vi.hoisted(() => ({
  previewSize: 0,
  previewPanelDefaultSize: undefined as string | undefined,
  previewPanelMinSize: undefined as string | undefined,
  previewOnResize: undefined as
    undefined | ((panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void),
  previewPanelHandle: {
    collapse: vi.fn(),
    expand: vi.fn(),
    getSize: vi.fn(() => ({
      asPercentage: workspacePageHarness.previewSize,
      inPixels: workspacePageHarness.previewSize * 10
    })),
    isCollapsed: vi.fn(() => true),
    resize: vi.fn((size: number | string) => {
      workspacePageHarness.previewSize = Number.parseFloat(String(size))
    })
  } as PanelImperativeHandle
}))

const motionHarness = vi.hoisted(() => ({
  animate: vi.fn(
    (
      from: number,
      to: number,
      options: { onUpdate?: (value: number) => void; onComplete?: () => void }
    ) => ({
      from,
      to,
      options,
      stop: vi.fn()
    })
  )
}))

vi.mock('motion', () => ({
  animate: motionHarness.animate
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  ),
  ResizableHandle: (): React.JSX.Element => <div data-testid="resize-handle" />
}))

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  useSessionPersistence: () => true
}))

vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({
    actionError: null,
    pendingPermissions: [],
    sendMessage: vi.fn(),
    cancelRun: vi.fn(),
    deleteRuntimeSession: vi.fn(),
    respondToPermission: vi.fn()
  })
}))

vi.mock('./WorkspaceSidebar', () => ({
  WorkspaceSidebar: (): React.JSX.Element => <aside />
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: ({
    isPreviewPanelCollapsed,
    onTogglePreviewPanel
  }: {
    isPreviewPanelCollapsed: boolean
    onTogglePreviewPanel: () => void
  }): React.JSX.Element => (
    <button
      type="button"
      data-testid="preview-toggle"
      data-collapsed={isPreviewPanelCollapsed ? 'true' : 'false'}
      onClick={onTogglePreviewPanel}
    >
      Toggle preview
    </button>
  )
}))

vi.mock('./PreviewPanel', () => ({
  PreviewPanel: ({
    panelRef,
    defaultSize,
    minSize,
    onResize
  }: {
    panelRef: React.Ref<PanelImperativeHandle>
    defaultSize: string
    minSize: string
    onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
  }): React.JSX.Element => {
    workspacePageHarness.previewPanelDefaultSize = defaultSize
    workspacePageHarness.previewPanelMinSize = minSize
    workspacePageHarness.previewOnResize = onResize

    if (typeof panelRef === 'function') {
      panelRef(workspacePageHarness.previewPanelHandle)
    } else if (panelRef) {
      ;(panelRef as { current: PanelImperativeHandle | null }).current =
        workspacePageHarness.previewPanelHandle
    }

    return <div data-testid="preview-panel" />
  }
}))

vi.mock('./RenameSessionDialog', () => ({
  RenameSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

describe('WorkspacePage preview panel resize sync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSessionStore.setState(createInitialSessionState())
    workspacePageHarness.previewSize = 0
    workspacePageHarness.previewPanelDefaultSize = undefined
    workspacePageHarness.previewPanelMinSize = undefined
    workspacePageHarness.previewOnResize = undefined
    vi.clearAllMocks()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    window.api = {
      notebook: {
        onAvailable: vi.fn(() => vi.fn()),
        getReference: vi.fn(() => Promise.resolve(null))
      },
      reviewer: {
        onUpdated: vi.fn(() => vi.fn()),
        onSuppressNextAutoReview: vi.fn(() => vi.fn()),
        onFixLoopStart: vi.fn(() => vi.fn()),
        onFixLoopEnd: vi.fn(() => vi.fn()),
        abortFixLoop: vi.fn(() => Promise.resolve())
      },
      compute: { enabledHostsSet: vi.fn(() => Promise.resolve()) }
    } as never
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    vi.restoreAllMocks()
    container.remove()
  })

  const renderPage = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspacePage isSessionPersistenceReady={true} />)
    })
  }

  it('syncs the initial collapsed preview size without running a close animation', async () => {
    workspacePageHarness.previewSize = 40

    await renderPage()

    expect(workspacePageHarness.previewPanelDefaultSize).toBe('0%')
    expect(workspacePageHarness.previewPanelHandle.resize).toHaveBeenCalledWith('0%')
    expect(motionHarness.animate).not.toHaveBeenCalled()
  })

  it('keeps an explicit open request when expand animation emits a near-zero resize', async () => {
    await renderPage()

    const toggleButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="preview-toggle"]'
    )
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')

    await act(async () => {
      workspacePageHarness.previewOnResize?.(
        { asPercentage: 0.05, inPixels: 0.5 },
        { asPercentage: 0, inPixels: 0 }
      )
    })

    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')

    await act(async () => {
      workspacePageHarness.previewOnResize?.(
        { asPercentage: 0, inPixels: 0 },
        { asPercentage: 1, inPixels: 12 }
      )
    })

    expect(usePreviewWorkbenchStore.getState().panelState).toBe('collapsed')
  })

  it('keeps an explicit collapse request when animation resize lacks a previous size', async () => {
    await renderPage()

    const toggleButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="preview-toggle"]'
    )
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const openAnimationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onUpdate?: (value: number) => void; onComplete?: () => void } | undefined
    await act(async () => {
      openAnimationOptions?.onComplete?.()
    })
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('collapsed')

    await act(async () => {
      workspacePageHarness.previewOnResize?.({ asPercentage: 40, inPixels: 400 }, undefined)
    })

    expect(usePreviewWorkbenchStore.getState().panelState).toBe('collapsed')
  })

  it('animates explicit preview open requests through panel percentage resize', async () => {
    await renderPage()

    const toggleButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="preview-toggle"]'
    )
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(motionHarness.animate).toHaveBeenCalledWith(
      0,
      40,
      expect.objectContaining({
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: expect.any(Function)
      })
    )

    const animationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onUpdate?: (value: number) => void; onComplete?: () => void } | undefined

    await act(async () => {
      animationOptions?.onUpdate?.(24)
    })

    expect(workspacePageHarness.previewPanelHandle.resize).toHaveBeenCalledWith('24%')
  })

  it('temporarily relaxes the preview min size while programmatic animation runs', async () => {
    await renderPage()

    expect(workspacePageHarness.previewPanelMinSize).toBe('30%')

    const toggleButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="preview-toggle"]'
    )
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(workspacePageHarness.previewPanelMinSize).toBe('0%')

    const animationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onUpdate?: (value: number) => void; onComplete?: () => void } | undefined

    await act(async () => {
      animationOptions?.onComplete?.()
    })

    expect(workspacePageHarness.previewPanelMinSize).toBe('30%')
  })
})
