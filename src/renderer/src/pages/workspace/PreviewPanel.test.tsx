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

    const activeContent = container.querySelector('[data-testid="file-content"]')
    expect(activeContent?.textContent).toBe('file:image:artifact:file-1.png:/workspace/file-1.png')
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
  })

  it('routes tool preview items to PreviewToolContent', async () => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createToolItem({}))

    await renderPanel()

    expect(container.querySelector('[data-testid="tool-content"]')?.textContent).toBe(
      'tool:notebook'
    )
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
})
