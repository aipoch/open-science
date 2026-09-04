// @vitest-environment jsdom
import { act, StrictMode } from 'react'
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
import type { Annotation } from '../../../../shared/annotations'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <div>{children}</div>
  )
}))

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: ({
    item,
    activeAnnotations,
    onAddAnnotation
  }: {
    item: PreviewFileItem
    activeAnnotations?: readonly Annotation[]
    onAddAnnotation?: (annotation: Annotation) => void
  }): React.JSX.Element => (
    <button
      type="button"
      data-testid="file-content"
      data-annotation-count={activeAnnotations?.length ?? 0}
      onClick={() => activeAnnotations?.[0] && onAddAnnotation?.(activeAnnotations[0])}
    >
      file:{item.format}:{item.source ?? 'artifact'}:{item.name}:{item.path}
    </button>
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
  projectId: 'default',
  managedFileId: 'item-1',
  title: 'file-1.png',
  type: 'file',
  path: '/workspace/file-1.png',
  name: 'file-1.png',
  format: 'image',
  source: 'artifact',
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
  let sourcePreviewListener: ((state: Record<string, unknown>) => void) | undefined
  let releaseSourcePreview: ReturnType<typeof vi.fn>

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    releaseSourcePreview = vi.fn()
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      managedFileVersions: {},
      sourcePreview: {
        release: releaseSourcePreview,
        onLoadState: (listener: (state: Record<string, unknown>) => void) => {
          sourcePreviewListener = listener
          return () => {
            sourcePreviewListener = undefined
          }
        }
      },
      uploads: { stageLocalPath: vi.fn().mockResolvedValue({ id: 'attachment-1' }) }
    } as unknown as Window['api']
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  // Radix dropdown interactions under jsdom need pointer-capture stubs.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  }

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderPanel = async (
    annotationProps: Partial<React.ComponentProps<typeof PreviewPanel>> = {},
    strict = false
  ): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      const panel = (
        <PreviewPanel
          panelRef={{ current: null }}
          defaultSize="40%"
          minSize="30%"
          onResize={vi.fn()}
          {...annotationProps}
        />
      )
      root.render(strict ? <StrictMode>{panel}</StrictMode> : panel)
    })
  }

  it('forwards one annotation port through the desktop and fullscreen file surface', async () => {
    const annotation: Annotation = {
      id: 'annotation-1',
      kind: 'text',
      target: 'agent',
      quote: 'Selected text',
      source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
    }
    const onAddAnnotation = vi.fn()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    await renderPanel({ activeAnnotations: [annotation], onAddAnnotation })

    const content = container.querySelector<HTMLButtonElement>('[data-testid="file-content"]')!
    expect(content.dataset.annotationCount).toBe('1')
    await act(async () => content.click())
    expect(onAddAnnotation).toHaveBeenCalledWith(annotation)

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Open full screen preview of file-1.png"]')
        ?.click()
    )
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="file-content"]')).toBe(content)
    expect(content.dataset.annotationCount).toBe('1')
  })

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

  const openTabContextMenu = async (tabIndex: number): Promise<void> => {
    const tab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[tabIndex]
    if (!tab) throw new Error(`tab not found at index ${tabIndex}`)
    await act(async () => {
      tab.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 })
      )
    })
  }

  const menuCommands = (): string[] =>
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
      (item) => item.dataset.command ?? ''
    )

  const clickMenuCommand = async (command: string): Promise<void> => {
    const menuItem = document.body.querySelector<HTMLElement>(
      `[role="menuitem"][data-command="${command}"]`
    )
    if (!menuItem) throw new Error(`menu item not found: ${command}`)
    await act(async () => {
      menuItem.click()
    })
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

  it('keeps an HTTPS source iframe mounted while its tab is inactive', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())
    usePreviewWorkbenchStore.getState().upsertItem(createFileItem({}))

    await renderPanel()

    const sourceTab = container.querySelector('[role="tab"][title="Genome study"]')
    const sourceHeader = container.querySelector('[data-source-preview-header]')
    const iframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')
    expect(sourceTab?.querySelector('[data-source-preview-tab-icon]')).not.toBeNull()
    expect(sourceTab?.textContent).toContain('Genome study')
    expect(sourceHeader?.textContent).toContain('Genome study')
    expect(sourceHeader?.textContent).toContain('https://example.com/paper')
    expect(sourceHeader?.textContent).not.toContain('Cited URL:')
    expect(sourceHeader?.querySelector('.lucide-link-2')).toBeNull()
    const sourceHeaderTitle = sourceHeader?.querySelector<HTMLElement>(
      '[data-source-preview-header-title]'
    )
    expect(sourceHeaderTitle?.className).toContain('text-text-000')
    const sourceHeaderUrl = sourceHeader?.querySelector<HTMLElement>(
      '[data-source-preview-header-url]'
    )
    expect(sourceHeaderUrl?.className).toContain('text-text-000/70')
    const sourceHeaderExternal = sourceHeader?.querySelector<HTMLButtonElement>(
      '[data-source-preview-header-external]'
    )
    const sourceHeaderClose = sourceHeader?.querySelector<HTMLButtonElement>(
      '[data-source-preview-header-close]'
    )
    expect(sourceHeader?.className).toContain('items-start')
    expect(sourceHeader?.className).not.toContain('items-center')
    expect(sourceHeader?.className).toContain('px-2')
    expect(sourceHeader?.className).toContain('py-1')
    expect(sourceHeaderExternal?.dataset.size).toBe('icon-xs')
    expect(sourceHeaderExternal?.className).toContain('text-text-100')
    expect(sourceHeaderExternal?.className).toContain('hover:text-text-000')
    expect(sourceHeaderClose?.dataset.size).toBe('icon-xs')
    expect(sourceHeaderClose?.className).toContain('text-text-100')
    expect(sourceHeaderClose?.className).toContain('hover:text-text-000')
    expect(sourceHeaderExternal?.nextElementSibling).toBe(sourceHeaderClose)
    expect(iframe?.getAttribute('src')).toBe('https://example.com/paper')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('title')).toBe('Source preview: Genome study')
    expect(container.querySelector('[aria-label="Open source in browser"]')).not.toBeNull()
    const sourcePanel = iframe?.closest<HTMLElement>('[role="tabpanel"]')
    expect(sourcePanel?.className).toContain('rounded-md')
    expect(sourcePanel?.className).toContain('bg-bg-000')
    expect(sourcePanel?.className).toContain('shadow-card')
    expect(sourcePanel?.parentElement?.className).toContain('pl-2')
    expect(sourcePanel?.parentElement?.className).toContain('pr-1')

    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem('item-1')
    })

    expect(container.querySelector('[data-source-preview-frame]')).toBe(iframe)
    expect(iframe?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true)
    expect(container.querySelector('[data-testid="file-content"]')).not.toBeNull()

    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem(createSourceItem().id)
    })

    expect(container.querySelector('[data-source-preview-frame]')).toBe(iframe)
    expect(iframe?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)
  })

  it('does not grant remote source previews permission to open popup windows', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())

    await renderPanel()

    const iframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')
    expect(iframe?.getAttribute('sandbox')?.split(/\s+/u)).toEqual([
      'allow-same-origin',
      'allow-scripts',
      'allow-forms'
    ])
  })

  it('closes a source preview from the header action', async () => {
    const sourceItem = createSourceItem()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(sourceItem)

    await renderPanel({}, true)

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[data-source-preview-header-close]'
    )
    expect(closeButton?.getAttribute('aria-label')).toBe('Close preview of Genome study')

    await act(async () => closeButton?.click())

    expect(usePreviewWorkbenchStore.getState().items).not.toContainEqual(sourceItem)
    expect(container.querySelector('[data-source-preview-frame]')).toBeNull()
    expect(releaseSourcePreview).toHaveBeenCalledWith('https://example.com/paper')
  })

  it('keeps an HTTPS source iframe mounted while the preview panel is collapsed', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())

    await renderPanel()

    const iframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')
    await act(async () => usePreviewWorkbenchStore.getState().collapsePanel())

    expect(container.querySelector('[data-source-preview-frame]')).toBe(iframe)
    expect(iframe?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true)
    expect(releaseSourcePreview).not.toHaveBeenCalled()

    await act(async () => usePreviewWorkbenchStore.getState().togglePanel())

    expect(container.querySelector('[data-source-preview-frame]')).toBe(iframe)
    expect(iframe?.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)
  })

  it('shows a two-pixel simulated loading bar until the source frame loads', async () => {
    vi.useFakeTimers()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())

    await renderPanel()

    const progress = container.querySelector<HTMLElement>('[data-source-preview-progress]')
    const progressFill = progress?.querySelector<HTMLElement>('[data-source-preview-progress-fill]')
    const skeleton = container.querySelector<HTMLElement>('[data-source-preview-skeleton]')
    expect(progress).not.toBeNull()
    expect(skeleton).not.toBeNull()
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

    await act(async () => {
      sourcePreviewListener?.({
        navigationId: 1,
        sourceUrl: 'https://example.com/paper',
        currentUrl: 'https://example.com/paper',
        phase: 'loaded',
        httpStatusCode: 200,
        httpStatusText: 'OK'
      })
    })

    expect(progressFill?.style.transform).toBe('scaleX(1)')
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(container.querySelector('[data-source-preview-progress]')).toBeNull()
    expect(container.querySelector('[data-source-preview-skeleton]')).toBeNull()
  })

  it('shows a retryable ErrorNotice with the blocked-frame failure reason', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())

    await renderPanel()
    const firstIframe = container.querySelector<HTMLIFrameElement>('[data-source-preview-frame]')

    await act(async () => {
      sourcePreviewListener?.({
        navigationId: 1,
        sourceUrl: 'https://example.com/paper',
        currentUrl: 'https://example.com/paper',
        phase: 'failed',
        failure: 'blocked',
        errorCode: -27,
        errorDescription: 'ERR_BLOCKED_BY_RESPONSE'
      })
    })

    const alert = container.querySelector<HTMLElement>('[data-source-preview-error]')
    expect(alert?.textContent).toContain('Could not load this source')
    expect(alert?.textContent).toContain('This source does not allow embedded previews.')
    expect(alert?.textContent).toContain('ERR_BLOCKED_BY_RESPONSE (-27)')
    expect(container.querySelector('[data-source-preview-progress]')).toBeNull()

    const retryButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Try again'
    )
    await act(async () => retryButton?.click())

    expect(container.querySelector('[data-source-preview-skeleton]')).not.toBeNull()
    expect(container.querySelector('[data-source-preview-frame]')).not.toBe(firstIframe)
  })

  it('preserves a failed source state while its tab is inactive', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createSourceItem())
    usePreviewWorkbenchStore.getState().upsertItem(createFileItem({}))

    await renderPanel()

    await act(async () => {
      sourcePreviewListener?.({
        navigationId: 1,
        sourceUrl: 'https://example.com/paper',
        currentUrl: 'https://example.com/paper',
        phase: 'failed',
        failure: 'network',
        errorCode: -102,
        errorDescription: 'ERR_CONNECTION_REFUSED'
      })
    })

    const error = container.querySelector('[data-source-preview-error]')
    expect(error?.textContent).toContain('ERR_CONNECTION_REFUSED (-102)')

    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem('item-1')
    })
    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem(createSourceItem().id)
    })

    expect(container.querySelector('[data-source-preview-error]')).toBe(error)
    expect(container.querySelector('[data-source-preview-skeleton]')).toBeNull()
  })

  it('releases a source iframe and its cached state only when the tab closes', async () => {
    const sourceItem = createSourceItem()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(sourceItem)
    usePreviewWorkbenchStore.getState().upsertItem(createFileItem({}))

    await renderPanel({}, true)

    const firstIframe = container.querySelector('[data-source-preview-frame]')
    await act(async () => {
      usePreviewWorkbenchStore.getState().activateItem('item-1')
    })
    expect(releaseSourcePreview).not.toHaveBeenCalled()

    await act(async () => {
      usePreviewWorkbenchStore.getState().removeItem(sourceItem.id)
    })
    expect(container.querySelector('[data-source-preview-frame]')).toBeNull()
    expect(releaseSourcePreview).toHaveBeenCalledOnce()
    expect(releaseSourcePreview).toHaveBeenCalledWith('https://example.com/paper')

    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(sourceItem)
    })
    expect(container.querySelector('[data-source-preview-frame]')).not.toBe(firstIframe)
    expect(container.querySelector('[data-source-preview-skeleton]')).not.toBeNull()
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
        source: 'upload',
        managedFileId: 'upload-1'
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
      projectId: 'default',
      fileId: 'upload-1',
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
        projectId: 'project-1',
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
      managedFileVersions: {},
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

  it('opens a tab menu on right-click without activating the tab', async () => {
    await renderTwoFileTabs()

    await openTabContextMenu(1)

    expect(document.body.querySelector('[data-testid="preview-tab-context-menu"]')).not.toBeNull()
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-1')
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'file-1.png'
    )
  })

  it('shows managed-file actions for an artifact tab and shared-only for a tool tab', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore.getState().upsertItem(createToolItem({}))
    await renderPanel()

    await openTabContextMenu(0)
    expect(menuCommands()).toEqual(['close', 'close-others', 'download'])
    // Every entry renders its icon (×, ⊗, ↓) ahead of the label.
    for (const menuItem of document.body.querySelectorAll('[role="menuitem"]')) {
      expect(menuItem.querySelector('svg')).not.toBeNull()
    }

    await openTabContextMenu(1)
    expect(menuCommands()).toEqual(['close', 'close-others'])
    expect(
      document.body.querySelector('[data-testid="preview-tab-context-menu"] [role="separator"]')
    ).toBeNull()
  })

  it('leads a linkable PDF tab menu with Read with agent and links through it', async () => {
    const linkPdfContext = vi.fn().mockResolvedValue({ version: 1, revision: 2 })
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    window.api.sessions = {
      linkPdfContext,
      unlinkPdfContext: vi.fn()
    } as unknown as Window['api']['sessions']
    window.api.artifacts = {
      getLineage: vi.fn().mockResolvedValue(undefined)
    } as unknown as Window['api']['artifacts']
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Session',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          runtimeContext: { version: 1, revision: 1 },
          createdAt: 1,
          updatedAt: 1
        } as ChatSession
      ],
      selectedSessionId: 'session-1'
    })
    const focusListener = vi.fn()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusListener)
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        format: 'pdf',
        title: 'paper.pdf',
        name: 'paper.pdf',
        artifactId: 'artifact-1',
        selectedVersionId: 'version-1',
        path: 'artifact-version:project-1/session-1/artifact-1/version-1'
      })
    )
    await renderPanel()

    await openTabContextMenu(0)
    expect(menuCommands()[0]).toBe('toggle-pdf-context')
    expect(
      document.body.querySelector('[data-command="toggle-pdf-context"]')?.textContent
    ).toContain('Read with agent')

    await clickMenuCommand('toggle-pdf-context')

    // The command activates the tab, links the PDF, and hands focus to the composer.
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-1')
    expect(linkPdfContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'item-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    )
    expect(focusListener).toHaveBeenCalled()
    // The menu's focus return must not override the composer's focus request — even after
    // Radix's scheduled close handling lands.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).not.toBe(document.getElementById('preview-tab-item-1'))
    window.removeEventListener(FOCUS_COMPOSER_EVENT, focusListener)
  })

  it('routes the PDF tab command through the Composer Reading history port when provided', async () => {
    const linkPdfContext = vi.fn()
    const onLinkReadingContext = vi.fn().mockResolvedValue(undefined)
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    window.api.sessions = {
      linkPdfContext,
      unlinkPdfContext: vi.fn()
    } as unknown as Window['api']['sessions']
    window.api.artifacts = {
      getLineage: vi.fn().mockResolvedValue(undefined)
    } as unknown as Window['api']['artifacts']
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Session',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          runtimeContext: { version: 1, revision: 1 },
          createdAt: 1,
          updatedAt: 1
        } as ChatSession
      ],
      selectedSessionId: 'session-1'
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        format: 'pdf',
        title: 'paper.pdf',
        name: 'paper.pdf',
        artifactId: 'artifact-1',
        selectedVersionId: 'version-1',
        path: 'artifact-version:project-1/session-1/artifact-1/version-1'
      })
    )
    await renderPanel({ onLinkReadingContext })

    await openTabContextMenu(0)
    await clickMenuCommand('toggle-pdf-context')

    await vi.waitFor(() =>
      expect(onLinkReadingContext).toHaveBeenCalledWith({
        sourceKind: 'artifact-version',
        sourceFileId: 'item-1',
        sourceVersionId: 'version-1'
      })
    )
    expect(linkPdfContext).not.toHaveBeenCalled()
  })

  it('returns focus to the tab after a menu command that does not target the composer', async () => {
    await renderTwoFileTabs()

    await openTabContextMenu(0)
    await clickMenuCommand('download')
    // Radix returns focus on close; let its scheduled focus restoration land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.activeElement).toBe(document.getElementById('preview-tab-item-1'))
  })

  it('labels the PDF tab command Remove PDF from context when the tab is the current binding', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    window.api.artifacts = {
      getLineage: vi.fn().mockResolvedValue(undefined)
    } as unknown as Window['api']['artifacts']
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Session',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          runtimeContext: {
            version: 1,
            revision: 1,
            pdfContext: {
              version: 1,
              bindings: [
                {
                  version: 1,
                  bindingId: 'binding-1',
                  sourceKind: 'artifact-version',
                  sourceFileId: 'artifact-1',
                  sourceVersionId: 'version-1',
                  sourceSessionId: 'session-1',
                  name: 'paper.pdf',
                  mimeType: 'application/pdf',
                  sizeBytes: 12,
                  checksum: 'checksum-1',
                  linkedAt: 1
                }
              ]
            }
          },
          createdAt: 1,
          updatedAt: 1
        } as ChatSession
      ],
      selectedSessionId: 'session-1'
    })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        format: 'pdf',
        title: 'paper.pdf',
        name: 'paper.pdf',
        artifactId: 'artifact-1',
        selectedVersionId: 'version-1',
        path: 'artifact-version:project-1/session-1/artifact-1/version-1'
      })
    )
    await renderPanel()

    await openTabContextMenu(0)

    const command = document.body.querySelector('[data-command="toggle-pdf-context"]')
    expect(command?.textContent).toContain('Remove PDF from context')
    // Unlink is reversible, so it never takes the danger styling.
    expect(command?.className).not.toContain('danger')
  })

  it('omits the reading-context command for non-PDF and non-linkable tabs', async () => {
    useSessionStore.setState({ sessions: [], selectedSessionId: undefined })
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createFileItem({}))
    usePreviewWorkbenchStore
      .getState()
      .upsertItem(
        createFileItem({ id: 'item-2', format: 'pdf', title: 'paper.pdf', name: 'paper.pdf' })
      )
    await renderPanel()

    await openTabContextMenu(0)
    expect(menuCommands()).not.toContain('toggle-pdf-context')

    // A PDF without immutable Version identity is not linkable.
    await openTabContextMenu(1)
    expect(menuCommands()).not.toContain('toggle-pdf-context')
  })

  it('offers local-file actions and disables close-others for a single tab', async () => {
    usePreviewWorkbenchStore
      .getState()
      .upsertAndActivateItem(createFileItem({ source: 'local', id: 'local:/tmp/notes.md' }))
    await renderPanel()

    await openTabContextMenu(0)

    expect(menuCommands()).toEqual([
      'close',
      'close-others',
      'copy-path',
      'download',
      'save-as-artifact'
    ])
    expect(
      document.body
        .querySelector<HTMLElement>('[role="menuitem"][data-command="close-others"]')
        ?.getAttribute('aria-disabled')
    ).toBe('true')
  })

  it('closes the other tabs from the menu and focuses the kept tab', async () => {
    await renderTwoFileTabs()

    await openTabContextMenu(1)
    await clickMenuCommand('close-others')

    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(['item-2'])
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-2')
    expect(document.body.querySelector('[data-testid="preview-tab-context-menu"]')).toBeNull()
  })

  it('closes the right-clicked tab from the menu', async () => {
    await renderTwoFileTabs()

    await openTabContextMenu(0)
    await clickMenuCommand('close')

    expect(usePreviewWorkbenchStore.getState().items.map((item) => item.id)).toEqual(['item-2'])
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('item-2')
  })

  it('downloads a managed file from the menu', async () => {
    await renderTwoFileTabs()

    await openTabContextMenu(0)
    await clickMenuCommand('download')

    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'default',
      fileId: 'item-1',
      suggestedName: 'file-1.png'
    })
  })

  it('copies a local file path and stages it as an artifact from the menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const stageLocalPath = vi.fn().mockResolvedValue({ id: 'attachment-1' })
    Object.assign(navigator, { clipboard: { writeText } })
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      managedFileVersions: {},
      uploads: { stageLocalPath }
    } as unknown as Window['api']
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createFileItem({
        source: 'local',
        id: 'local:/tmp/notes.md',
        path: '/tmp/notes.md',
        name: 'notes.md'
      })
    )
    usePreviewWorkbenchStore.getState().upsertItem(
      createFileItem({
        id: 'item-2',
        title: 'other.png',
        path: '/w/other.png',
        name: 'other.png'
      })
    )
    await renderPanel()

    await openTabContextMenu(0)
    await clickMenuCommand('copy-path')
    expect(writeText).toHaveBeenCalledWith('/tmp/notes.md')

    await openTabContextMenu(0)
    await clickMenuCommand('save-as-artifact')
    await act(async () => {
      await Promise.resolve()
    })
    expect(stageLocalPath).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'notes.md', sourcePath: '/tmp/notes.md' })
    )
  })
})
