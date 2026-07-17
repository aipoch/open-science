// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore,
  type PreviewFileItem,
  type PreviewToolItem
} from '@/stores/preview-workbench-store'

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

  it('shows an empty state and no tab bar when there are no preview items', async () => {
    await renderPanel()

    expect(container.textContent).toContain('No preview content')
    expect(container.querySelectorAll('[title]').length).toBe(0)
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

    const tabs = container.querySelectorAll('[title]')
    expect(tabs.length).toBe(2)
    const previewTabs = container.querySelectorAll<HTMLElement>('[role="tab"]')
    for (const tab of previewTabs) {
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).not.toBeNull()
      expect(container.querySelector(`#${panelId}`)?.getAttribute('role')).toBe('tabpanel')
    }

    const activeContent = container.querySelector('[data-testid="file-content"]')
    expect(activeContent?.textContent).toBe('file:image:artifact:file-1.png:/workspace/file-1.png')
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
    const titleTail = header?.querySelector('[data-testid="preview-title-tail"]')
    const tabBar = container.querySelector('[aria-label="Open previews"]')

    expect(card?.className).toContain('rounded-md')
    expect(card?.className).toContain('shadow-card')
    expect(card?.className).not.toContain('border-[0.5px]')
    expect(card?.className).not.toContain('border-border-300/35')
    expect(card?.parentElement?.className).toContain('pl-2')
    expect(card?.parentElement?.className).toContain('pr-1')
    expect(card?.parentElement?.className).not.toContain('px-2')
    expect(header?.className).toContain('h-8')
    expect(titleTail?.textContent?.endsWith('.csv')).toBe(true)
    expect(titleTail?.className).toContain('max-w-')
    expect(titleTail?.className).toContain('overflow-hidden')
    expect(header?.querySelector(`[aria-label="Download ${name}"]`)).not.toBeNull()
    expect(header?.querySelector(`[aria-label="Close preview of ${name}"]`)).not.toBeNull()
    expect(tabBar?.getAttribute('role')).toBe('tablist')
    expect(tabBar?.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull()
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull()
    expect(tabBar?.querySelector(`[aria-label="Close preview of ${name}"]`)).not.toBeNull()
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

  it('keeps tab close controls out of the tab order and supports Delete on the tab', async () => {
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

    const closeButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Open previews"] [aria-label^="Close preview of "]'
    )
    expect(Array.from(closeButtons).every((button) => button.tabIndex === -1)).toBe(true)

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
    expect(container.querySelector('[aria-label="Close preview of Tool preview"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-card"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-card-header"]')).toBeNull()
    const toolTab = container.querySelector<HTMLElement>('[role="tab"]')
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
    expect(container.querySelector('[data-testid="tool-content"]')?.textContent).toBe('tool:files')
    expect(container.querySelector('[data-testid="preview-card"]')).toBeNull()
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

    const closeInactiveTab = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open previews"] [aria-label="Close preview of file-2.pdf"]'
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

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close preview of file-1.png"]'
    )
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

    await act(async () => usePreviewWorkbenchStore.getState().openPanel())
    expect(container.querySelector('[data-testid="file-content"]')).not.toBeNull()
  })
})
