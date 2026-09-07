// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'
import type { NotebookSessionReference } from '../../../../shared/notebook'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'

const workspacePageHarness = vi.hoisted(() => ({
  isMobile: false,
  sidebarSize: 16,
  sidebarPanelDefaultSize: undefined as string | undefined,
  sidebarPanelMinSize: undefined as string | undefined,
  sidebarOnResize: undefined as
    | ((
        panelSize: PanelSize,
        panelId: string | number | undefined,
        previousPanelSize: PanelSize | undefined
      ) => void)
    | undefined,
  sidebarPanelRef: undefined as undefined | { current: PanelImperativeHandle | null },
  sidebarPanelHandle: {
    collapse: vi.fn(),
    expand: vi.fn(),
    getSize: vi.fn(() => ({
      asPercentage: workspacePageHarness.sidebarSize,
      inPixels: workspacePageHarness.sidebarSize * 10
    })),
    isCollapsed: vi.fn(() => false),
    resize: vi.fn((size: number | string) => {
      workspacePageHarness.sidebarSize = Number.parseFloat(String(size))
    })
  } as PanelImperativeHandle,
  previewSize: 0,
  previewPanelDefaultSize: undefined as string | undefined,
  previewPanelMinSize: undefined as string | undefined,
  previewOnResize: undefined as
    undefined | ((panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void),
  previewPanelRef: undefined as undefined | { current: PanelImperativeHandle | null },
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

const filePreviewDialogHarness = vi.hoisted(() => ({
  item: undefined as PreviewFileItem | undefined
}))

vi.mock('motion', () => ({
  animate: motionHarness.animate
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({
    id,
    children,
    panelRef,
    defaultSize,
    minSize,
    onResize
  }: {
    id?: string
    children: React.ReactNode
    panelRef?: React.Ref<PanelImperativeHandle>
    defaultSize?: string
    minSize?: string
    onResize?: (
      panelSize: PanelSize,
      panelId: string | number | undefined,
      previousPanelSize: PanelSize | undefined
    ) => void
  }): React.JSX.Element => {
    if (id === 'left-panel') {
      workspacePageHarness.sidebarPanelDefaultSize = defaultSize
      workspacePageHarness.sidebarPanelMinSize = minSize
      workspacePageHarness.sidebarOnResize = onResize

      if (typeof panelRef === 'function') {
        panelRef(workspacePageHarness.sidebarPanelHandle)
      } else if (panelRef) {
        workspacePageHarness.sidebarPanelRef = panelRef as {
          current: PanelImperativeHandle | null
        }
        workspacePageHarness.sidebarPanelRef.current = workspacePageHarness.sidebarPanelHandle
      }
    }

    return <div data-testid={id ?? 'resizable-panel'}>{children}</div>
  },
  ResizablePanelGroup: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element => <div {...props}>{children}</div>,
  ResizableHandle: ({
    elementRef,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    elementRef?: React.Ref<HTMLDivElement>
  }): React.JSX.Element => (
    <div
      ref={elementRef}
      data-testid="resize-handle"
      tabIndex={0}
      className={className}
      {...props}
    />
  )
}))

vi.mock('@/lib/preview-persistence/preview-persistence', () => ({
  usePreviewPersistence: vi.fn()
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
  WorkspaceSidebar: ({
    isMobileOpen,
    sidebarToggle,
    sidebarToggleButtonRef,
    onMobileClose
  }: {
    isMobileOpen?: boolean
    sidebarToggle?: {
      state: 'open' | 'collapsed'
      onToggle: () => void
    }
    sidebarToggleButtonRef?: React.Ref<HTMLButtonElement>
    onMobileClose?: () => void
  }): React.JSX.Element => (
    <aside
      aria-hidden={isMobileOpen === false ? true : undefined}
      inert={isMobileOpen === false ? true : undefined}
      data-mobile-open={isMobileOpen ? 'true' : 'false'}
    >
      {isMobileOpen !== undefined ? (
        <button type="button" data-testid="mobile-sidebar-action" onClick={onMobileClose}>
          Close navigation
        </button>
      ) : null}
      {sidebarToggle && sidebarToggle.state !== 'collapsed' ? (
        // Structural stand-in only: style-class coverage lives in WorkspaceSidebar.render.test
        // against the real component, so this mock deliberately does not replicate the styles.
        <button
          ref={sidebarToggleButtonRef}
          type="button"
          data-testid="workspace-sidebar-toggle"
          aria-expanded="true"
          onClick={sidebarToggle.onToggle}
        />
      ) : null}
    </aside>
  )
}))

vi.mock('./ConversationPanel', () => ({
  ConversationPanel: ({
    layout: { isPreviewPanelCollapsed, togglePreviewPanel, openSidebar }
  }: {
    layout: {
      isPreviewPanelCollapsed: boolean
      togglePreviewPanel: () => void
      openSidebar: () => void
    }
  }): React.JSX.Element => (
    <section data-testid="conversation-panel">
      <button
        type="button"
        data-testid="preview-toggle"
        data-collapsed={isPreviewPanelCollapsed ? 'true' : 'false'}
        onClick={togglePreviewPanel}
      >
        Toggle preview
      </button>
      <button type="button" data-testid="navigation-toggle" onClick={openSidebar}>
        Toggle navigation
      </button>
    </section>
  )
}))

vi.mock('./MobilePreviewSheet', () => ({
  MobilePreviewSheet: ({ open }: { open: boolean }): React.JSX.Element => (
    <div data-testid="mobile-preview-sheet" data-open={open ? 'true' : 'false'} />
  )
}))

vi.mock('./FilePreviewDialog', () => ({
  FilePreviewDialog: ({ item }: { item: PreviewFileItem | undefined }): React.JSX.Element => {
    filePreviewDialogHarness.item = item
    return <div data-testid="file-preview-dialog" data-open={item ? 'true' : 'false'} />
  }
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
      workspacePageHarness.previewPanelRef = panelRef as {
        current: PanelImperativeHandle | null
      }
      workspacePageHarness.previewPanelRef.current = workspacePageHarness.previewPanelHandle
    }

    return <div data-testid="preview-panel" />
  }
}))

vi.mock('./EditSessionDialog', () => ({
  EditSessionDialog: (): React.JSX.Element => <div />
}))

vi.mock('./DeleteSessionDialog', () => ({
  DeleteSessionDialog: (): React.JSX.Element => <div />
}))

const { WorkspacePage } = await import('./WorkspacePage')

describe('WorkspacePage preview panel resize sync', () => {
  let container: HTMLDivElement
  let root: Root
  let notebookAvailableListener: ((notebook: NotebookSessionReference) => void) | undefined

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    previewLeaveGuards.clear()
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    useSessionStore.setState(createInitialSessionState())
    workspacePageHarness.sidebarSize = 16
    workspacePageHarness.sidebarPanelDefaultSize = undefined
    workspacePageHarness.sidebarPanelMinSize = undefined
    workspacePageHarness.sidebarOnResize = undefined
    workspacePageHarness.sidebarPanelRef = undefined
    workspacePageHarness.previewSize = 0
    workspacePageHarness.isMobile = false
    workspacePageHarness.previewPanelDefaultSize = undefined
    workspacePageHarness.previewPanelMinSize = undefined
    workspacePageHarness.previewOnResize = undefined
    workspacePageHarness.previewPanelRef = undefined
    filePreviewDialogHarness.item = undefined
    notebookAvailableListener = undefined
    vi.clearAllMocks()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)' ? workspacePageHarness.isMobile : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
    window.api = {
      platform: 'linux',
      notebook: {
        onAvailable: vi.fn((listener: (notebook: NotebookSessionReference) => void) => {
          notebookAvailableListener = listener
          return vi.fn()
        }),
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
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderPage = async (withPreview = true): Promise<void> => {
    if (withPreview) {
      usePreviewWorkbenchStore.getState().upsertItem({
        id: 'file:session-1:/workspace/project/report.md',
        sessionId: 'session-1',
        type: 'file',
        title: 'report.md',
        path: '/workspace/project/report.md',
        format: 'markdown',
        name: 'report.md'
      })
    }

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspacePage
          isSessionPersistenceHydrated={true}
          isSessionPersistenceReady={true}
          canDeleteConversations={true}
        />
      )
    })
  }

  const selectSession = (sessionId: string, projectId: string): void => {
    const now = Date.now()
    const session: ChatSession = {
      id: sessionId,
      projectId,
      title: 'Session',
      cwd: `/workspace/${projectId}`,
      status: 'idle',
      messages: [],
      createdAt: now,
      updatedAt: now
    }
    useNavigationStore.setState({ view: 'workspace', activeProjectId: projectId })
    useSessionStore.setState({ sessions: [session], selectedSessionId: sessionId })
    usePreviewWorkbenchStore.getState().activateProject(projectId)
  }

  const getPreviewToggle = (): HTMLButtonElement => {
    const toggleButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-preview-toggle"]'
    )
    if (!toggleButton) throw new Error('workspace preview toggle not found')
    return toggleButton
  }

  const getSidebarToggle = (): HTMLButtonElement => {
    const toggleButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-sidebar-toggle"]'
    )
    if (!toggleButton) throw new Error('workspace sidebar toggle not found')
    return toggleButton
  }

  it('hosts the sidebar toggle inside the expanded sidebar header', async () => {
    await renderPage()

    const toggleButton = getSidebarToggle()
    const sidebarPanel = container.querySelector('[data-testid="left-panel"]')
    const resizeHandle = container.querySelector('[data-testid="resize-handle"]')

    expect(sidebarPanel?.contains(toggleButton)).toBe(true)
    expect(toggleButton.getAttribute('aria-expanded')).toBe('true')
    expect(toggleButton.className).not.toContain('absolute')
    expect(resizeHandle?.className).toContain('transition-opacity')
  })

  it('falls back to the floating sidebar toggle while the sidebar is collapsed', async () => {
    await renderPage()

    await act(async () => {
      getSidebarToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const toggleButton = getSidebarToggle()
    const sidebarPanel = container.querySelector('[data-testid="left-panel"]')

    // Exactly one toggle instance at a time: the floating fallback replaces the header one.
    expect(container.querySelectorAll('[data-testid="workspace-sidebar-toggle"]')).toHaveLength(1)
    expect(sidebarPanel?.contains(toggleButton)).toBe(false)
    expect(toggleButton.getAttribute('aria-expanded')).toBe('false')
    expect(toggleButton.getAttribute('aria-controls')).toBe('left-panel')
    expect(toggleButton.getAttribute('aria-keyshortcuts')).toBe('Control+B')
    expect(toggleButton.className).toContain('absolute')
    expect(toggleButton.className.split(' ')).toContain('top-0')
    expect(toggleButton.className).not.toContain('-top-1')
    expect(toggleButton.className).not.toContain('top-3')
    expect(toggleButton.className).toContain('cursor-pointer')
    expect(toggleButton.className).toContain('bg-transparent')
    expect(toggleButton.className).toContain('hover:bg-surface-control-hover')
    expect(toggleButton.className).not.toContain('bg-primary/20')
    // Collapsing hands keyboard focus to the surviving floating instance.
    expect(document.activeElement).toBe(toggleButton)

    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const expandedToggle = getSidebarToggle()
    expect(container.querySelectorAll('[data-testid="workspace-sidebar-toggle"]')).toHaveLength(1)
    expect(sidebarPanel?.contains(expandedToggle)).toBe(true)
    expect(expandedToggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(expandedToggle)
  })

  it.each([
    { platform: 'darwin', modifier: { metaKey: true }, wrongModifier: { ctrlKey: true } },
    { platform: 'win32', modifier: { ctrlKey: true }, wrongModifier: { metaKey: true } },
    { platform: 'linux', modifier: { ctrlKey: true }, wrongModifier: { metaKey: true } }
  ])(
    'toggles the desktop sidebar with the platform shortcut on $platform',
    async ({ platform, modifier, wrongModifier }) => {
      window.api.platform = platform
      await renderPage()

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            ...wrongModifier,
            bubbles: true,
            cancelable: true
          })
        )
      })
      expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('true')

      const collapseEvent = new KeyboardEvent('keydown', {
        key: 'b',
        ...modifier,
        bubbles: true,
        cancelable: true
      })
      await act(async () => window.dispatchEvent(collapseEvent))
      expect(collapseEvent.defaultPrevented).toBe(true)

      // The collapsed fallback is the floating button, which owns the shortcut hint.
      const collapsedToggle = getSidebarToggle()
      expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false')
      expect(collapsedToggle.className).toContain('absolute')
      expect(collapsedToggle.getAttribute('aria-keyshortcuts')).toBe(
        platform === 'darwin' ? 'Meta+B' : 'Control+B'
      )
      // Focus stays in the composer: the handoff guard must not steal it for the fallback.
      expect(document.activeElement).toBe(input)

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            ...modifier,
            bubbles: true,
            cancelable: true
          })
        )
      })
      expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('true')
      expect(document.activeElement).toBe(input)
      input.remove()
    }
  )

  it('leaves the sidebar unchanged while a modal dialog is open', async () => {
    await renderPage()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)

    try {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
          })
        )
      })
      expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('true')
    } finally {
      dialog.remove()
    }
  })

  // Right preview edge keeps its resting border; pointer geometry is covered in Electron E2E.
  it('keeps the always-on border divider on the right preview resize handle', async () => {
    await renderPage()

    const rightHandle = container.querySelector('[aria-label="Resize right panel"]')
    const leftHandle = container.querySelector('[aria-label="Resize left panel"]')

    expect(rightHandle?.className).toContain('bg-border')
    expect(rightHandle?.className).toContain('shadow-[1px_0_3px_rgba(30,28,24,0.08)]')
    expect(leftHandle?.className).not.toContain('bg-border')
    expect(leftHandle?.className).not.toContain('shadow-[1px_0_3px_rgba(30,28,24,0.08)]')
  })

  it('animates the sidebar to zero and restores its last open size', async () => {
    await renderPage()

    await act(async () => {
      getSidebarToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The floating fallback mounts at the last known open position until resize events track it.
    const toggleButton = getSidebarToggle()
    expect(toggleButton.getAttribute('aria-expanded')).toBe('false')
    expect(toggleButton.style.left).toBe('calc(16% - 38px)')
    expect(motionHarness.animate).toHaveBeenCalledWith(
      16,
      0,
      expect.objectContaining({
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: expect.any(Function)
      })
    )

    const closeAnimationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onComplete?: () => void } | undefined
    await act(async () => {
      workspacePageHarness.sidebarOnResize?.({ asPercentage: 8, inPixels: 80 }, 'left-panel', {
        asPercentage: 16,
        inPixels: 160
      })
    })
    expect(toggleButton.style.left).toBe('42px')

    await act(async () => {
      workspacePageHarness.sidebarOnResize?.({ asPercentage: 0, inPixels: 0 }, 'left-panel', {
        asPercentage: 8,
        inPixels: 80
      })
    })
    expect(toggleButton.style.left).toBe('0px')

    await act(async () => {
      closeAnimationOptions?.onComplete?.()
    })
    expect(workspacePageHarness.sidebarPanelHandle.resize).toHaveBeenCalledWith('0%')

    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('true')
    expect(motionHarness.animate).toHaveBeenLastCalledWith(
      0,
      16,
      expect.objectContaining({
        duration: 0.22,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: expect.any(Function)
      })
    )
  })

  it('keeps the preview toggle floating outside the sidebar, expanded or collapsed', async () => {
    await renderPage()

    const toggleButton = getPreviewToggle()
    const sidebarPanel = container.querySelector('[data-testid="left-panel"]')
    const previewPanel = container.querySelector('[data-testid="preview-panel"]')

    expect(toggleButton.getAttribute('aria-expanded')).toBe('false')
    expect(sidebarPanel?.contains(toggleButton)).toBe(false)
    expect(previewPanel?.contains(toggleButton)).toBe(false)
    expect(toggleButton.className).toContain('absolute')
    expect(toggleButton.className).toContain('right-2')

    // Collapsing the sidebar leaves the same floating instance mounted.
    await act(async () => {
      getSidebarToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('false')
    expect(getPreviewToggle()).toBe(toggleButton)
    expect(sidebarPanel?.contains(toggleButton)).toBe(false)

    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')
  })

  it('hides the preview toggle and keeps the panel collapsed when there are no preview items', async () => {
    await renderPage(false)

    expect(container.querySelector('[data-testid="workspace-preview-toggle"]')).toBeNull()
    expect(workspacePageHarness.previewPanelDefaultSize).toBe('0%')
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('collapsed')
  })

  it('opens and activates the notebook preview when its entry first becomes available', async () => {
    selectSession('session-1', 'project-1')
    await renderPage(false)

    const notebook: NotebookSessionReference = {
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace/project-1',
      notebookSessionRoot: '/notebooks/project-1/session-1',
      dataRoot: '/notebooks/project-1/session-1/data',
      runtimeRoot: '/notebooks/project-1/session-1/runtime',
      runJsonPath: '/notebooks/project-1/session-1/run.json'
    }

    await act(async () => {
      notebookAvailableListener?.(notebook)
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'tool:session-1:notebook',
      panelState: 'open',
      items: [
        expect.objectContaining({
          id: 'tool:session-1:notebook',
          toolKind: 'notebook',
          notebook
        })
      ]
    })
  })

  it.each([
    ['another session', 'project-1', 'session-2'],
    ['another project', 'project-2', 'session-1']
  ])('does not open the notebook preview for %s', async (_label, projectId, sessionId) => {
    selectSession('session-1', 'project-1')
    await renderPage(false)

    await act(async () => {
      notebookAvailableListener?.({
        projectId,
        sessionId,
        workspaceCwd: `/workspace/${projectId}`,
        notebookSessionRoot: `/notebooks/${projectId}/${sessionId}`,
        dataRoot: `/notebooks/${projectId}/${sessionId}/data`,
        runtimeRoot: `/notebooks/${projectId}/${sessionId}/runtime`,
        runJsonPath: `/notebooks/${projectId}/${sessionId}/run.json`
      })
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: undefined,
      panelState: 'collapsed',
      items: []
    })
  })

  it('waits for the target project preview slice before opening the notebook', async () => {
    selectSession('session-1', 'project-1')
    await renderPage(false)
    act(() => usePreviewWorkbenchStore.getState().activateProject('previous-project'))

    const notebook: NotebookSessionReference = {
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace/project-1',
      notebookSessionRoot: '/notebooks/project-1/session-1',
      dataRoot: '/notebooks/project-1/session-1/data',
      runtimeRoot: '/notebooks/project-1/session-1/runtime',
      runJsonPath: '/notebooks/project-1/session-1/run.json'
    }
    await act(async () => notebookAvailableListener?.(notebook))

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'previous-project',
      activeItemId: undefined,
      panelState: 'collapsed',
      items: []
    })

    act(() => usePreviewWorkbenchStore.getState().activateProject('project-1'))

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-1',
      activeItemId: 'tool:session-1:notebook',
      panelState: 'open',
      items: [expect.objectContaining({ id: 'tool:session-1:notebook', notebook })]
    })
  })

  it('refreshes an existing notebook entry without reopening or activating it', async () => {
    selectSession('session-1', 'project-1')
    await renderPage(false)

    const notebook: NotebookSessionReference = {
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace/project-1',
      notebookSessionRoot: '/notebooks/project-1/session-1/root',
      dataRoot: '/notebooks/project-1/session-1/root/data',
      runtimeRoot: '/notebooks/project-1/session-1/root/runtime',
      runJsonPath: '/notebooks/project-1/session-1/root/run.json'
    }
    await act(async () => notebookAvailableListener?.(notebook))

    const fileItem: PreviewFileItem = {
      id: 'file:session-1:/workspace/project-1/report.md',
      sessionId: 'session-1',
      type: 'file',
      title: 'report.md',
      path: '/workspace/project-1/report.md',
      format: 'markdown',
      name: 'report.md'
    }
    act(() => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(fileItem)
      usePreviewWorkbenchStore.getState().collapsePanel()
    })

    const delegatedNotebook = {
      ...notebook,
      notebookSessionRoot: '/notebooks/project-1/session-1/delegated',
      dataRoot: '/notebooks/project-1/session-1/delegated/data',
      runtimeRoot: '/notebooks/project-1/session-1/delegated/runtime',
      runJsonPath: '/notebooks/project-1/session-1/delegated/run.json'
    }
    await act(async () => notebookAvailableListener?.(delegatedNotebook))

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: fileItem.id,
      panelState: 'collapsed',
      items: [
        expect.objectContaining({
          id: 'tool:session-1:notebook',
          notebook: delegatedNotebook
        }),
        expect.objectContaining({ id: fileItem.id })
      ]
    })
  })

  it('hosts a cross-Project file dialog without creating or activating a Files tab', async () => {
    const fileDialogItem = {
      id: 'artifact-b',
      projectId: 'project-b',
      sessionId: 'session-b',
      type: 'file' as const,
      title: 'result.png',
      path: 'artifact-version:project-b/session-b/artifact-b/version-1',
      format: 'image' as const,
      name: 'result.png'
    }
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-b' })
    usePreviewWorkbenchStore.setState({
      activeProjectId: 'project-a',
      fileDialogItem
    })

    await renderPage(false)

    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(filePreviewDialogHarness.item).toEqual(fileDialogItem)

    act(() => usePreviewWorkbenchStore.getState().activateProject('project-b'))
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-b',
      activeItemId: undefined,
      items: [],
      fileDialogItem
    })

    act(() => usePreviewWorkbenchStore.getState().activateProject('project-c'))
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    expect(filePreviewDialogHarness.item).toBeUndefined()
  })

  it('marks the sidebar preview toggle as expanded after opening the panel', async () => {
    await renderPage()

    const toggleButton = getPreviewToggle()
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(toggleButton.getAttribute('aria-expanded')).toBe('true')
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')
  })

  it('syncs the initial collapsed preview size without running a close animation', async () => {
    workspacePageHarness.previewSize = 40

    await renderPage()

    expect(workspacePageHarness.previewPanelDefaultSize).toBe('0%')
    expect(workspacePageHarness.previewPanelHandle.resize).toHaveBeenCalledWith('0%')
    expect(motionHarness.animate).not.toHaveBeenCalled()
  })

  it('retries once when the desktop panel layout is still registering', async () => {
    workspacePageHarness.previewSize = 40
    workspacePageHarness.previewPanelHandle.getSize = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Layout not found for Panel right-panel-resizable')
      })
      .mockImplementation(() => ({
        asPercentage: workspacePageHarness.previewSize,
        inPixels: workspacePageHarness.previewSize * 10
      }))

    await renderPage()

    expect(workspacePageHarness.previewPanelHandle.getSize).toHaveBeenCalledTimes(2)
    expect(workspacePageHarness.previewPanelHandle.resize).toHaveBeenCalledWith('0%')
  })

  it('uses a navigation drawer and bottom preview sheet on mobile', async () => {
    workspacePageHarness.isMobile = true
    await renderPage()

    expect(container.querySelector('[data-testid="preview-panel"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="mobile-preview-sheet"]')?.getAttribute('data-open')
    ).toBe('false')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="navigation-toggle"]')?.click()
    })
    expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('true')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="preview-toggle"]')?.click()
    })
    expect(
      container.querySelector('[data-testid="mobile-preview-sheet"]')?.getAttribute('data-open')
    ).toBe('true')
  })

  it('keeps mobile navigation focus modal and restores its trigger on close', async () => {
    workspacePageHarness.isMobile = true
    await renderPage()

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="navigation-toggle"]')
    const conversation = container.querySelector<HTMLElement>('[data-testid="conversation-panel"]')
    trigger?.focus()

    await act(async () => trigger?.click())

    const sidebar = container.querySelector<HTMLElement>('aside')
    const dialog = sidebar?.closest<HTMLElement>('[role="dialog"]')
    expect(sidebar?.contains(document.activeElement)).toBe(true)
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(conversation?.closest('[inert]')).not.toBeNull()

    await act(async () => trigger?.focus())
    expect(sidebar?.contains(document.activeElement)).toBe(true)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('toggles the mobile navigation drawer with Ctrl+B', async () => {
    workspacePageHarness.isMobile = true
    await renderPage()

    const toggleFromKeyboard = async (): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
          })
        )
      })
    }

    expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('false')
    await toggleFromKeyboard()
    expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('true')
    await toggleFromKeyboard()
    expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('false')
  })

  it('closes the mobile navigation drawer from Escape and the overlay', async () => {
    workspacePageHarness.isMobile = true
    await renderPage()

    const openNavigation = async (): Promise<void> => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="navigation-toggle"]')?.click()
      })
      expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('true')
    }

    await openNavigation()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('false')

    await openNavigation()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]')?.click()
    })
    expect(container.querySelector('aside')?.getAttribute('data-mobile-open')).toBe('false')
  })

  it('keeps an explicit open request when expand animation emits a near-zero resize', async () => {
    await renderPage()

    const toggleButton = getPreviewToggle()
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

  it('reopens the physical preview panel when a dirty surface refuses a resize collapse', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-a')
    await renderPage()
    const itemId = 'file:session-1:/workspace/project/report.md'
    usePreviewWorkbenchStore.getState().activateItem(itemId)
    usePreviewWorkbenchStore.setState({ panelState: 'open' })
    workspacePageHarness.previewSize = 35
    await act(async () => {
      workspacePageHarness.previewOnResize?.(
        { asPercentage: 35, inPixels: 350 },
        { asPercentage: 40, inPixels: 400 }
      )
    })
    previewLeaveGuards.register(`workbench:project-a:${itemId}`, () => false)
    motionHarness.animate.mockClear()
    vi.mocked(workspacePageHarness.previewPanelHandle.resize).mockClear()
    workspacePageHarness.previewSize = 0

    await act(async () => {
      workspacePageHarness.previewOnResize?.(
        { asPercentage: 0, inPixels: 0 },
        { asPercentage: 35, inPixels: 350 }
      )
    })

    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')
    expect(motionHarness.animate).toHaveBeenLastCalledWith(
      0,
      35,
      expect.objectContaining({ onUpdate: expect.any(Function) })
    )
  })

  it('keeps an explicit collapse request when animation resize lacks a previous size', async () => {
    await renderPage()

    const toggleButton = getPreviewToggle()
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

    const toggleButton = getPreviewToggle()
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

  it('does not resize a detached preview panel during an in-flight animation', async () => {
    await renderPage()

    const toggleButton = getPreviewToggle()
    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const animationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onUpdate?: (value: number) => void; onComplete?: () => void } | undefined
    vi.mocked(workspacePageHarness.previewPanelHandle.resize).mockClear()
    if (workspacePageHarness.previewPanelRef) {
      workspacePageHarness.previewPanelRef.current = null
    }

    await act(async () => {
      animationOptions?.onUpdate?.(24)
      animationOptions?.onComplete?.()
    })

    expect(workspacePageHarness.previewPanelHandle.resize).not.toHaveBeenCalled()
  })

  it('temporarily relaxes the preview min size while programmatic animation runs', async () => {
    await renderPage()

    expect(workspacePageHarness.previewPanelMinSize).toBe('30%')

    const toggleButton = getPreviewToggle()
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

  // Open sidebar keeps enough room for its navigation content while remaining collapsible.
  it('keeps the open sidebar min size at sixteen percent', async () => {
    await renderPage()

    expect(workspacePageHarness.sidebarPanelDefaultSize).toBe('16%')
    expect(workspacePageHarness.sidebarPanelMinSize).toBe('16%')

    const toggleButton = getSidebarToggle()
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(workspacePageHarness.sidebarPanelMinSize).toBe('0%')

    const animationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onUpdate?: (value: number) => void; onComplete?: () => void } | undefined

    await act(async () => {
      animationOptions?.onComplete?.()
    })

    expect(workspacePageHarness.sidebarPanelMinSize).toBe('16%')
  })

  it('keeps the sidebar open when an expand animation reports a near-zero resize', async () => {
    await renderPage()

    await act(async () => {
      getSidebarToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const closeAnimationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onComplete?: () => void } | undefined
    await act(async () => closeAnimationOptions?.onComplete?.())

    await act(async () => {
      getSidebarToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      workspacePageHarness.sidebarOnResize?.({ asPercentage: 0.05, inPixels: 0.5 }, 'left-panel', {
        asPercentage: 0,
        inPixels: 0
      })
    })

    expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('moves keyboard focus from a collapsed sidebar separator to its toggle', async () => {
    await renderPage()

    const leftHandle = container.querySelector<HTMLElement>('[aria-label="Resize left panel"]')
    leftHandle?.focus()

    await act(async () => {
      workspacePageHarness.sidebarOnResize?.({ asPercentage: 0, inPixels: 0 }, 'left-panel', {
        asPercentage: 16,
        inPixels: 160
      })
    })

    // The header instance unmounts on collapse, so focus lands on the floating fallback.
    const toggleButton = getSidebarToggle()
    expect(toggleButton.className).toContain('absolute')
    expect(document.activeElement).toBe(toggleButton)
  })

  it('moves keyboard focus from a collapsed preview separator to its toggle', async () => {
    await renderPage()

    // The floating preview toggle is always mounted, so it is the collapse focus target.
    const rightHandle = container.querySelector<HTMLElement>('[aria-label="Resize right panel"]')
    const toggleButton = getPreviewToggle()
    rightHandle?.focus()

    await act(async () => {
      workspacePageHarness.previewOnResize?.(
        { asPercentage: 0, inPixels: 0 },
        { asPercentage: 30, inPixels: 300 }
      )
    })

    expect(document.activeElement).toBe(toggleButton)
  })

  it('lets an opposite sidebar drag interrupt a closing animation', async () => {
    await renderPage()

    await act(async () => {
      getSidebarToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('false')
    expect(workspacePageHarness.sidebarOnResize).toBeTypeOf('function')
    await act(async () => {
      workspacePageHarness.sidebarOnResize?.({ asPercentage: 10, inPixels: 100 }, 'left-panel', {
        asPercentage: 9,
        inPixels: 90
      })
    })

    expect(getSidebarToggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('does not resize a detached sidebar panel during an in-flight animation', async () => {
    await renderPage()

    const toggleButton = getSidebarToggle()
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const animationOptions = motionHarness.animate.mock.calls.at(-1)?.[2] as
      { onUpdate?: (value: number) => void; onComplete?: () => void } | undefined
    vi.mocked(workspacePageHarness.sidebarPanelHandle.resize).mockClear()
    if (workspacePageHarness.sidebarPanelRef) {
      workspacePageHarness.sidebarPanelRef.current = null
    }

    await act(async () => {
      animationOptions?.onUpdate?.(8)
      animationOptions?.onComplete?.()
    })

    expect(workspacePageHarness.sidebarPanelHandle.resize).not.toHaveBeenCalled()
  })

  it('skips sidebar animation when reduced motion is enabled', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true }))
    )

    await renderPage()

    const toggleButton = getSidebarToggle()
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(motionHarness.animate).not.toHaveBeenCalled()
    expect(workspacePageHarness.sidebarPanelHandle.resize).toHaveBeenCalledWith('0%')
  })
})
