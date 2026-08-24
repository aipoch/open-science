// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore,
  type PreviewFileItem,
  type PreviewSourceItem,
  type PreviewToolItem
} from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  )
}))

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: ({ item }: { item: PreviewFileItem }): React.JSX.Element => (
    <div data-testid="file-content">
      file:{item.format}:{item.source ?? 'artifact'}:{item.name}:{item.path}
    </div>
  )
}))

vi.mock('./previews/PreviewToolContent', () => ({
  PreviewToolContent: ({ item }: { item: PreviewToolItem }): React.JSX.Element => (
    <div data-testid="tool-content">tool:{item.toolKind ?? 'unknown'}</div>
  )
}))

const { PreviewPanel } = await import('./PreviewPanel')

const createFileItem = (overrides: Partial<PreviewFileItem>): PreviewFileItem => ({
  id: 'item-1',
  sessionId: 'session-1',
  title: 'file-1.png',
  type: 'file',
  path: '/workspace/file-1.png',
  name: 'file-1.png',
  format: 'image',
  ...overrides
})

const createToolItem = (overrides: Partial<PreviewToolItem>): PreviewToolItem => ({
  id: 'tool-1',
  sessionId: 'session-1',
  title: 'Tool preview',
  type: 'tool',
  toolKind: 'notebook',
  ...overrides
})

const createSourceItem = (overrides: Partial<PreviewSourceItem> = {}): PreviewSourceItem => ({
  id: 'source:https://example.com/paper',
  sessionId: '__sources__',
  title: 'Genome study',
  type: 'source',
  url: 'https://example.com/paper',
  ...overrides
})

describe('PreviewPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true })
    } as unknown as Window['api']
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderPanel = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PreviewPanel
          panelRef={{ current: null }}
          defaultSize="40%"
          minSize="30%"
          onResize={vi.fn()}
        />
      )
    })
  }

  const renderTwoFileTabs = async (): Promise<void> => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )
    await renderPanel()
  }

  const mockTabScrollGeometry = ({
    tabIndex,
    listBounds,
    tabBounds,
    scrollLeft = 0
  }: {
    tabIndex: number
    listBounds: [number, number]
    tabBounds: [number, number]
    scrollLeft?: number
  }): { tabBar: HTMLElement; scrollTo: ReturnType<typeof vi.fn> } => {
    const tabBar = container.querySelector<HTMLElement>('[aria-label="Open previews"]')
    const tabContainer = container.querySelectorAll<HTMLElement>('[role="presentation"]')[tabIndex]
    if (!tabBar || !tabContainer) throw new Error('Expected preview tab geometry targets')

    const scrollTo = vi.fn()
    const rect = ([left, right]: [number, number]): DOMRect =>
      ({ left, right, width: right - left }) as DOMRect
    Object.defineProperty(tabBar, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperty(tabBar, 'scrollLeft', {
      configurable: true,
      value: scrollLeft,
      writable: true
    })
    vi.spyOn(tabBar, 'getBoundingClientRect').mockReturnValue(rect(listBounds))
    vi.spyOn(tabContainer, 'getBoundingClientRect').mockReturnValue(rect(tabBounds))

    return { tabBar, scrollTo }
  }

  it('shows an empty state without rendering preview header chrome', async () => {
    await renderPanel()

    expect(container.textContent).toContain('No preview content')
    expect(container.querySelector('[aria-label="Open previews"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-panel-top-bar"]')).toBeNull()
  })

  it('reserves stable header padding for the external preview toggle', async () => {
    await renderTwoFileTabs()

    const chromeRow = container.querySelector('[data-testid="preview-panel-top-bar"]')
    const tabBar = container.querySelector('[aria-label="Open previews"]')

    expect(chromeRow).not.toBeNull()
    expect(chromeRow?.contains(tabBar)).toBe(true)
    expect(tabBar?.parentElement).toBe(chromeRow)
    expect(chromeRow?.className).toContain('pl-2')
    expect(chromeRow?.className).toContain('pr-14')
    expect(tabBar?.className).toContain('flex-1')
    expect(container.querySelector('[data-testid="preview-panel-toggle-slot"]')).toBeNull()
    expect(container.querySelector('[data-testid="workspace-preview-toggle"]')).toBeNull()
  })

  it('renders a tab per item, highlights the active one, and routes file items to PreviewFileContent', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )

    await renderPanel()

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs.length).toBe(2)
    const previewTabs = container.querySelectorAll<HTMLElement>('[role="tab"]')
    for (const tab of previewTabs) {
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).not.toBeNull()
      expect(container.querySelector(`#${panelId}`)?.getAttribute('role')).toBe('tabpanel')
    }
    expect(container.querySelector('[role="tab"][title="file-1.png"] .lucide-file')).not.toBeNull()

    const activeContent = container.querySelector('[data-testid="file-content"]')
    expect(activeContent?.textContent).toBe('file:image:artifact:file-1.png:/workspace/file-1.png')
  })

  it('renders an HTTPS source in an isolated iframe tab and releases it when inactive', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())
    usePreviewWorkbenchStore.getState().upsertItem(createFileItem({}))

    await renderPanel()

    const sourceTab = container.querySelector('[role="tab"][title="Genome study"]')
    const sourceHeader = container.querySelector('header')
    const iframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')
    expect(sourceTab?.querySelector('[data-source-preview-tab-icon]')).not.toBeNull()
    expect(sourceTab?.textContent).toContain('Genome study')
    expect(sourceHeader?.textContent).toContain('Genome study')
    expect(sourceHeader?.textContent).toContain('https://example.com/paper')
    expect(sourceHeader?.textContent).not.toContain('Cited URL:')
    const sourceHeaderUrl = sourceHeader?.querySelector<HTMLElement>(
      '[title="https://example.com/paper"]'
    )
    expect(sourceHeaderUrl?.className).toContain('text-text-300')
    expect(sourceHeaderUrl?.className).not.toContain('text-text-400')
    expect(iframe?.getAttribute('src')).toBe('https://example.com/paper')
    expect(iframe?.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('title')).toBe('Source preview: Genome study')
    expect(container.querySelector('[aria-label="Open source in browser"]')).not.toBeNull()

    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem('item-1')
    })

    expect(container.querySelector('[data-source-preview-frame]')).toBeNull()
    expect(container.querySelector('[data-testid="file-content"]')).not.toBeNull()
  })

  it('shows a two-pixel simulated loading bar until the source frame loads', async () => {
    vi.useFakeTimers()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())

    await renderPanel()

    const progress = container.querySelector<HTMLElement>('[data-source-preview-progress]')
    const progressFill = progress?.querySelector<HTMLElement>('[data-source-preview-progress-fill]')
    expect(progress).not.toBeNull()
    expect(progress?.className).toContain('h-0.5')
    expect(progress?.getAttribute('role')).toBe('progressbar')
    expect(progress?.getAttribute('aria-valuenow')).toBeNull()
    expect(progressFill?.style.transform).toBe('scaleX(0.08)')

    await act(async () => vi.advanceTimersByTimeAsync(700))

    const advancedProgress = Number(progressFill?.style.transform.match(/scaleX\(([^)]+)\)/u)?.[1])
    expect(advancedProgress).toBeGreaterThan(0.08)
    expect(advancedProgress).toBeLessThanOrEqual(0.9)

    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(progressFill?.style.transform).toBe('scaleX(0.9)')
    expect(vi.getTimerCount()).toBe(0)

    const iframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')
    await act(async () => {
      iframe?.dispatchEvent(new Event('load'))
    })

    expect(progressFill?.style.transform).toBe('scaleX(1)')
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(container.querySelector('[data-source-preview-progress]')).toBeNull()
  })

  it('restarts source loading progress when the active URL changes', async () => {
    vi.useFakeTimers()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())

    await renderPanel()
    await act(async () => vi.advanceTimersByTimeAsync(700))

    const firstIframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')
    const firstFill = container.querySelector<HTMLElement>('[data-source-preview-progress-fill]')
    expect(firstFill?.style.transform).not.toBe('scaleX(0.08)')

    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(
        createSourceItem({
          title: 'Second study',
          url: 'https://example.com/second'
        })
      )
    })

    const restartedFill = container.querySelector<HTMLElement>(
      '[data-source-preview-progress-fill]'
    )
    expect(restartedFill?.style.transform).toBe('scaleX(0.08)')

    await act(async () => {
      firstIframe?.dispatchEvent(new Event('load'))
    })
    expect(restartedFill?.style.transform).toBe('scaleX(0.08)')
    expect(container.querySelector('[data-source-preview-progress]')).not.toBeNull()
  })

  it('wraps an active file in a compact card with middle-ellipsis title and header actions', async () => {
    const name = 'global_climate_anomaly_analysis_1850-2025.csv'
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        title: name,
        name,
        path: `/workspace/${name}`,
        format: 'csv'
      })
    )

    await renderPanel()

    const card = container.querySelector('[data-testid="preview-card"]')
    const header = card?.querySelector('[data-testid="preview-card-header"]')
    const headerFileName = header?.querySelector('[data-testid="file-name-root"]')
    const tabBar = container.querySelector('[aria-label="Open previews"]')
    const fileTab = tabBar?.querySelector(`[role="tab"][title="${name}"]`)
    const fileTabContainer = fileTab?.parentElement

    expect(card?.className).toContain('rounded-md')
    expect(card?.className).toContain('shadow-card')
    expect(card?.className).not.toContain('border-[0.5px]')
    expect(card?.className).not.toContain('border-border-300/35')
    expect(card?.parentElement?.className).toContain('pl-2')
    expect(card?.parentElement?.className).toContain('pr-1')
    expect(card?.parentElement?.className).not.toContain('px-2')
    expect(header?.className).toContain('h-8')
    expect(headerFileName?.querySelector('[data-testid="file-name-head"]')?.textContent).toBe(
      'global_climate_anomaly_analysis_1850'
    )
    expect(headerFileName?.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe(
      '-2025'
    )
    expect(headerFileName?.querySelector('[data-testid="file-name-extension"]')?.textContent).toBe(
      '.csv'
    )
    expect(header?.querySelector(`[aria-label="Download ${name}"]`)).not.toBeNull()
    expect(
      header?.querySelector(`[aria-label="Open full screen preview of ${name}"]`)
    ).not.toBeNull()
    expect(header?.querySelector(`[aria-label="Close preview of ${name}"]`)).not.toBeNull()
    expect(tabBar?.getAttribute('role')).toBe('tablist')
    expect(tabBar?.className).toContain('min-w-0')
    expect(tabBar?.className).toContain('flex-1')
    expect(fileTabContainer?.className).toContain('max-w-[160px]')
    expect(fileTabContainer?.className.split(' ')).not.toContain('w-[160px]')
    expect(fileTab?.className.split(' ')).not.toContain('flex-1')
    expect(tabBar?.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull()
    const tabFileName = fileTab?.querySelector('[data-testid="file-name-root"]')
    expect(tabFileName?.className.split(' ')).not.toContain('flex-1')
    expect(tabFileName?.querySelector('[data-testid="file-name-head"]')?.textContent).toBe(
      'global_climate_anomaly_analysis_1850'
    )
    expect(fileTab?.querySelector('[data-testid="file-name-ellipsis"]')).toBeNull()
    expect(fileTab?.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe('-2025')
    const tabExtension = fileTab?.querySelector('[data-testid="file-name-extension"]')
    expect(tabExtension?.textContent).toBe('.csv')
    expect(tabExtension?.className).toContain('shrink-0')
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull()
    expect(tabBar?.querySelector(`[data-preview-close="${name}"]`)).not.toBeNull()
  })

  it('opens and closes a large file preview without removing the workbench tab', async () => {
    const name = 'report.pdf'
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        title: name,
        name,
        path: `/workspace/${name}`,
        format: 'pdf'
      })
    )

    await renderPanel()
    const compactContent = container.querySelector('[data-testid="file-content"]')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[aria-label="Open full screen preview of ${name}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    expect(dialog).not.toBeNull()
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('h-[90vh]')
    expect(dialog?.className).toContain('w-[90vw]')
    expect(dialog?.className).toContain('overscroll-contain')
    expect(dialog?.className).toContain('rounded-xl')
    expect(dialog?.className).toContain('border-border')
    expect(dialog?.className).toContain('bg-card')
    expect(dialog?.className).toContain('shadow-dialog')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.querySelector('[data-testid="file-content"]')?.textContent).toContain(name)
    expect(dialog?.querySelector('[data-testid="file-content"]')).toBe(compactContent)
    expect(dialog?.querySelector(`[aria-label="Open full screen preview of ${name}"]`)).toBeNull()

    await act(async () => {
      dialog
        ?.querySelector<HTMLButtonElement>(`[aria-label="Close preview of ${name}"]`)
        ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    // The full-screen dialog floats at z-[61]; header tooltips must layer above it. Radix puts
    // role="tooltip" on a visually-hidden span, so assert on the styled content div instead.
    expect(
      document.body.querySelector('[data-radix-popper-content-wrapper] [data-state]')?.className
    ).toContain('z-[70]')

    await act(async () => {
      dialog
        ?.querySelector<HTMLButtonElement>(`[aria-label="Close preview of ${name}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'item-1',
      panelState: 'open'
    })
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(['item-1'])
  })

  it('supports keyboard navigation between preview tabs', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )
    await renderPanel()

    const firstTab = container.querySelector<HTMLButtonElement>('[role="tab"]')
    await act(async () => {
      firstTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-2')
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'file-2.pdf'
    )
  })

  it('scrolls a clipped active preview tab inside the tab list', async () => {
    await renderTwoFileTabs()
    const { scrollTo } = mockTabScrollGeometry({
      tabIndex: 1,
      listBounds: [100, 300],
      tabBounds: [260, 360],
      scrollLeft: 40
    })

    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(scrollTo).toHaveBeenCalledOnce()
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: 'smooth',
      left: 108
    })
  })

  it('avoids smooth tab scrolling when the user prefers reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true }))
    )
    await renderTwoFileTabs()
    const { scrollTo } = mockTabScrollGeometry({
      tabIndex: 1,
      listBounds: [100, 300],
      tabBounds: [260, 360]
    })

    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(scrollTo).toHaveBeenCalledWith({
      behavior: 'auto',
      left: 68
    })
  })

  it('does not scroll when the active preview tab is already fully visible', async () => {
    await renderTwoFileTabs()
    const { scrollTo } = mockTabScrollGeometry({
      tabIndex: 1,
      listBounds: [100, 300],
      tabBounds: [160, 260]
    })

    await act(async () => {
      container
        .querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('rechecks active tab visibility when the preview panel width changes', async () => {
    let notifyResize: (() => void) | undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver)
        }

        observe = observe
        disconnect = disconnect
      }
    )
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    await renderPanel()
    const { tabBar, scrollTo } = mockTabScrollGeometry({
      tabIndex: 0,
      listBounds: [100, 260],
      tabBounds: [220, 300]
    })

    await act(async () => {
      notifyResize?.()
    })

    expect(observe).toHaveBeenCalledWith(tabBar)
    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'auto', left: 48 })
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('leaves vertical arrows available to the page for a horizontal tab list', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )
    await renderPanel()

    const firstTab = container.querySelector<HTMLButtonElement>('[role="tab"]')
    await act(async () => {
      firstTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-1')
  })

  it('keeps pointer close affordances non-focusable and supports Delete on the tab', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )
    await renderPanel()

    const closeAffordances = container.querySelectorAll<HTMLElement>(
      '[aria-label="Open previews"] [data-preview-close]'
    )
    expect(Array.from(closeAffordances).every((element) => element.tabIndex === -1)).toBe(true)
    expect(
      Array.from(closeAffordances).every(
        (element) => element.tagName === 'SPAN' && element.getAttribute('aria-hidden') === 'true'
      )
    ).toBe(true)

    const firstTab = container.querySelector<HTMLButtonElement>('[role="tab"]')!
    firstTab.focus()
    await act(async () => {
      firstTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(['item-2'])
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-2')
    expect(document.activeElement?.textContent).toContain('file-2.pdf')
  })

  it('passes upload file sources through to the active preview content', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        id: 'upload:upload-1',
        title: 'upload.png',
        name: 'upload.png',
        path: '/Users/example/.open-science/uploads/default-project/session-1/upload.png',
        source: 'upload'
      })
    )

    await renderPanel()

    expect(container.querySelector('[data-testid="file-content"]')?.textContent).toBe(
      'file:image:upload:upload.png:/Users/example/.open-science/uploads/default-project/session-1/upload.png'
    )

    const downloadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download upload.png"]'
    )
    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'upload',
      path: '/Users/example/.open-science/uploads/default-project/session-1/upload.png',
      suggestedName: 'upload.png'
    })
  })

  it('routes tool preview items to PreviewToolContent', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createToolItem({}))

    await renderPanel()

    expect(container.querySelector('[data-testid="tool-content"]')?.textContent).toBe(
      'tool:notebook'
    )
    expect(container.querySelector('[aria-label^="Download "]')).toBeNull()
    expect(container.querySelector('[data-preview-close="Tool preview"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-card"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-card-header"]')).toBeNull()
    const toolTab = container.querySelector<HTMLElement>('[role="tab"]')
    expect(toolTab?.querySelector('.lucide-book-open')).not.toBeNull()
    expect(toolTab?.querySelector('.lucide-file, .lucide-folder-open')).toBeNull()
    expect(
      container.querySelector(`#${toolTab?.getAttribute('aria-controls')}`)?.getAttribute('role')
    ).toBe('tabpanel')
  })

  it('renders the Files project tool tab when it is active', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'tool:project:files',
      sessionId: '__project_files__',
      title: 'Files',
      type: 'tool',
      toolKind: 'files'
    } as never)

    await renderPanel()

    expect(container.querySelector('button[title="Files"]')).not.toBeNull()
    expect(container.querySelector('button[title="Files"] .lucide-folder-open')).not.toBeNull()
    expect(container.querySelector('button[title="Files"] .lucide-file')).toBeNull()
    expect(container.querySelector('[data-testid="tool-content"]')?.textContent).toBe('tool:files')
    expect(container.querySelector('[data-testid="preview-card"]')).toBeNull()
  })

  it('expands a tool tab into a modal surface without remounting its content', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: 'tool:project:files',
      sessionId: '__project_files__',
      title: 'Files',
      type: 'tool',
      toolKind: 'files'
    } as never)

    await renderPanel()

    const inlineContent = container.querySelector('[data-testid="tool-content"]')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[role="tabpanel"]')?.className).toContain('overflow-y-auto')

    await act(async () => {
      usePreviewWorkbenchStore.getState().setToolItemExpanded('tool:project:files')
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )
    expect(dialog).not.toBeNull()
    expect(overlay).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-label')).toBe('Files')
    expect(dialog?.className).toContain('h-[90vh]')
    expect(dialog?.className).toContain('w-[90vw]')
    expect(dialog?.querySelector('[data-testid="tool-content"]')).toBe(inlineContent)

    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().expandedToolItemId).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[data-testid="tool-content"]')).toBe(inlineContent)
  })

  const panelId = (itemId: string): string => `preview-panel-${encodeURIComponent(itemId)}`

  it('keeps a tool panel mounted while a file tab is active', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createToolItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(createFileItem({}))

    await renderPanel()

    // Node identity is the signal: a remount replaces the DOM node and loses component state such
    // as the local file browser's current directory.
    const toolContent = container.querySelector('[data-testid="tool-content"]')
    expect(toolContent).not.toBeNull()
    const toolPanel = container.querySelector(`#${panelId('tool-1')}`)
    expect(toolPanel?.hasAttribute('hidden')).toBe(false)

    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem('item-1')
    })

    expect(container.querySelector('[data-testid="file-content"]')).not.toBeNull()
    expect(container.querySelector(`#${panelId('tool-1')}`)?.hasAttribute('hidden')).toBe(true)
    expect(container.querySelector('[data-testid="tool-content"]')).toBe(toolContent)

    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem('tool-1')
    })

    expect(container.querySelector(`#${panelId('tool-1')}`)?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('[data-testid="tool-content"]')).toBe(toolContent)
  })

  it('activates a different tab on click and swaps the rendered content', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )

    await renderPanel()

    const secondTabButton = container.querySelector<HTMLButtonElement>('button[title="file-2.pdf"]')
    await act(async () => {
      secondTabButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-2')
    expect(container.querySelector('[data-testid="file-content"]')?.textContent).toBe(
      'file:pdf:artifact:file-2.pdf:/workspace/file-2.pdf'
    )
  })

  it('closes an inactive tab without activating or mounting its content', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )
    await renderPanel()

    const closeInactiveTab = container.querySelector<HTMLElement>(
      '[aria-label="Open previews"] [data-preview-close="file-2.pdf"]'
    )
    await act(async () => {
      closeInactiveTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-1')
    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(['item-1'])
    expect(container.querySelector('[data-testid="file-content"]')?.textContent).toContain(
      'file-1.png'
    )
  })

  it('closes a tab, removes it from the store, and repairs the active tab', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'file-2.pdf',
        format: 'pdf',
        path: '/workspace/file-2.pdf',
        name: 'file-2.pdf'
      })
    )

    await renderPanel()

    const closeButton = container.querySelector<HTMLElement>('[data-preview-close="file-1.png"]')
    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(['item-2'])
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-2')
  })

  it('unmounts active preview content while the panel is collapsed', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))

    await renderPanel()
    expect(container.querySelector('[data-testid="file-content"]')).not.toBeNull()

    await act(async () => usePreviewWorkbenchStore.getState().collapsePanel())
    expect(container.querySelector('[data-testid="file-content"]')).toBeNull()

    await act(async () => usePreviewWorkbenchStore.getState().togglePanel())
    expect(container.querySelector('[data-testid="file-content"]')).not.toBeNull()
  })

  it('collapses the panel full-screen preview after View in context navigates', async () => {
    const name = 'figure.png'
    // The managed-artifact identity and a live origin session make View in context actionable.
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        title: name,
        name,
        path: `/workspace/${name}`,
        artifactId: 'artifact-1',
        sessionId: 'session-1'
      })
    )
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'Project One',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      isLoaded: true
    })
    const session = (id: string, updatedAt: number): ChatSession => ({
      id,
      projectId: 'project-1',
      title: id,
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      artifacts: [],
      filesRevision: 1,
      createdAt: 1,
      updatedAt
    })
    useSessionStore.setState({
      sessions: [session('session-1', 1), session('session-2', 2)],
      selectedSessionId: 'session-2'
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      artifacts: {
        getLineage: vi.fn().mockResolvedValue({
          artifactId: 'artifact-1',
          filename: name,
          originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
          versions: []
        })
      }
    } as unknown as Window['api']

    await renderPanel()
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[aria-label="Open full screen preview of ${name}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[aria-label="View in context for ${name}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
    // The floating preview must step aside so the switched conversation is visible.
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull()
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-1')
  })
})
