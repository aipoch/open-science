// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialMemoryState, useMemoryStore } from '@/stores/memory-store'
import type {
  MemoryCategoryView,
  MemoryEntryView,
  MemoryProjectView
} from '../../../../shared/memory'
import { MemoryPanel, type MemoryView } from './MemoryPanel'

type AboutYouCategory = Extract<MemoryCategoryView, { systemKey: 'about-you' }>
type CustomCategory = Extract<MemoryCategoryView, { name: string }>

const memoryEntry = (overrides: Partial<MemoryEntryView> = {}): MemoryEntryView => ({
  id: 'entry-a',
  categoryId: 'memory-category-about-you',
  categoryName: 'About you',
  projectId: null,
  projectName: null,
  content: 'A note',
  origin: 'user',
  revision: 1,
  createdAt: 2,
  updatedAt: 2,
  ...overrides
})

const aboutYouCategory = (overrides: Partial<AboutYouCategory> = {}): AboutYouCategory => ({
  id: 'memory-category-about-you',
  systemKey: 'about-you',
  autoRecall: true,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  entries: [],
  ...overrides
})

const customCategory = (overrides: Partial<CustomCategory> = {}): CustomCategory => ({
  id: 'category-a',
  name: 'Category A',
  guidance: '',
  autoRecall: true,
  revision: 1,
  createdAt: 2,
  updatedAt: 2,
  entries: [],
  ...overrides
})

const memoryProject = (overrides: Partial<MemoryProjectView> = {}): MemoryProjectView => ({
  projectId: 'project-a',
  name: 'Project A',
  archived: false,
  entries: [],
  ...overrides
})

let container: HTMLDivElement
let root: Root

const renderMemoryPanel = async (
  view: MemoryView = { kind: 'list' },
  onNavigate: (view: MemoryView) => void = vi.fn(),
  onOpenProject?: (projectId: string) => void
): Promise<void> => {
  await act(async () => root.render(<MemoryPanel {...{ view, onNavigate, onOpenProject }} />))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useMemoryStore.setState({
    ...createInitialMemoryState(),
    status: 'ready',
    categories: [aboutYouCategory()],
    selectedCategoryId: 'memory-category-about-you'
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MemoryPanel', () => {
  it('renders the retained-data off state and immutable About you category', async () => {
    await renderMemoryPanel()

    expect(document.body.textContent).toContain('Memory is off.')
    expect(document.body.textContent).not.toContain('Turn on')
    expect(document.body.textContent).toContain('About you')
    expect(document.body.textContent).toContain('No notes yet.')
    expect(document.body.textContent).not.toContain('Delete category')
  })

  it('renders the category form with the custom-category count and auto-recall control', async () => {
    await renderMemoryPanel({ kind: 'create' })

    expect(document.body.textContent).toContain('0 of 10 categories used')
    expect(document.body.textContent).toContain('Auto-recall')
    const name = container.querySelector<HTMLInputElement>('input[name="memory-category-name"]')
    const guidance = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="memory-category-guidance"]'
    )
    const create = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Create'
    )

    expect(name?.required).toBe(true)
    expect(guidance?.required).toBe(true)
    expect(create?.disabled).toBe(true)

    fireEvent.change(name!, { target: { value: 'Experiment results' } })
    expect(create?.disabled).toBe(true)
    fireEvent.change(guidance!, { target: { value: 'Save reusable findings' } })
    expect(create?.disabled).toBe(false)
  })

  it('opens an inline note editor from Add', async () => {
    await renderMemoryPanel()

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    fireEvent.click(add!)

    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Add a note…"]'
    )
    expect(editor).not.toBeNull()
    expect(editor?.getAttribute('aria-label')).toBe('Memory note')
  })

  it('shows copied state only after the clipboard write succeeds', async () => {
    let resolveWrite: (() => void) | undefined
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => write) }
    })
    useMemoryStore.setState({
      categories: [aboutYouCategory({ entries: [memoryEntry()] })]
    })
    await renderMemoryPanel()
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy note"]')!
    const initialIcon = copy.querySelector('svg')?.outerHTML

    fireEvent.click(copy)
    expect(initialIcon).toBeTruthy()
    expect(copy.querySelector('svg')?.outerHTML).toBe(initialIcon)

    await act(async () => resolveWrite?.())
    expect(copy.querySelector('svg')?.outerHTML).not.toBe(initialIcon)
  })

  it('keeps copy state unchanged when the clipboard write fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) }
    })
    useMemoryStore.setState({
      categories: [aboutYouCategory({ entries: [memoryEntry()] })]
    })
    await renderMemoryPanel()
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy note"]')!
    const initialIcon = copy.querySelector('svg')?.outerHTML

    await act(async () => fireEvent.click(copy))

    expect(initialIcon).toBeTruthy()
    expect(copy.querySelector('svg')?.outerHTML).toBe(initialIcon)
    expect(document.body.textContent).not.toContain('Copied')
  })

  it('discards a category-bound note draft when the selected category changes', async () => {
    useMemoryStore.setState({
      categories: [
        useMemoryStore.getState().categories[0]!,
        customCategory(),
        customCategory({
          id: 'category-b',
          name: 'Category B',
          autoRecall: false,
          createdAt: 3,
          updatedAt: 3
        })
      ],
      selectedCategoryId: 'category-a'
    })
    await renderMemoryPanel()

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    fireEvent.click(add!)
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'draft for A' } })
    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Category B')
      )!
    )

    expect(container.querySelector('textarea[placeholder="Add a note…"]')).toBeNull()
    expect(document.body.textContent).toContain('No notes yet.')
  })

  it('exposes auto-recall as one checkable menu item without nested controls', async () => {
    useMemoryStore.setState({
      categories: [customCategory()],
      selectedCategoryId: 'category-a'
    })
    await renderMemoryPanel()

    fireEvent.pointerDown(container.querySelector('button[aria-label="Category actions"]')!, {
      button: 0,
      ctrlKey: false
    })

    const item = document.body.querySelector('[role="menuitemcheckbox"]')
    expect(item).not.toBeNull()
    expect(item?.getAttribute('aria-checked')).toBe('true')
    expect(item?.querySelector('[role="switch"]')).toBeNull()
  })

  it('describes destructive actions against current app data without overstating backups', async () => {
    useMemoryStore.setState({
      categories: [useMemoryStore.getState().categories[0]!, customCategory()],
      selectedCategoryId: 'category-a'
    })
    await renderMemoryPanel()

    fireEvent.click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Clear all'
      )!
    )

    expect(document.body.textContent).toContain('deleted from current app data')
    expect(document.body.textContent).toContain(
      'Restoring a database backup may restore older memory'
    )
    expect(document.body.textContent).not.toContain('permanently deleted')
  })

  it('confirms note deletion before invoking the destructive action', async () => {
    const deleteEntry = vi.fn().mockResolvedValue(undefined)
    useMemoryStore.setState({
      categories: [
        aboutYouCategory({
          entries: [memoryEntry({ content: 'Keep this until confirmed' })]
        })
      ],
      deleteEntry
    })
    await renderMemoryPanel()

    fireEvent.click(container.querySelector('button[aria-label="Delete note"]')!)

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Delete note?')
    expect(deleteEntry).not.toHaveBeenCalled()

    fireEvent.click(
      Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Delete note'
      )!
    )
    expect(deleteEntry).toHaveBeenCalledWith({ id: 'entry-a', expectedRevision: 1 })
  })

  it('dismisses note deletion from the dialog header without deleting', async () => {
    const deleteEntry = vi.fn().mockResolvedValue(undefined)
    useMemoryStore.setState({
      categories: [
        aboutYouCategory({ entries: [memoryEntry({ content: 'Keep this after closing' })] })
      ],
      deleteEntry
    })
    await renderMemoryPanel()

    fireEvent.click(container.querySelector('button[aria-label="Delete note"]')!)

    const close = document.body.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] button[aria-label="Close"]'
    )
    expect(close).not.toBeNull()
    fireEvent.click(close!)

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(deleteEntry).not.toHaveBeenCalled()
  })

  it('renders category confirmation above the parent settings dialog layer', async () => {
    useMemoryStore.setState({
      categories: [
        useMemoryStore.getState().categories[0]!,
        customCategory({
          guidance: 'Save reusable category A findings'
        })
      ],
      selectedCategoryId: 'category-a'
    })
    await renderMemoryPanel()

    fireEvent.pointerDown(container.querySelector('button[aria-label="Category actions"]')!, {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
        item.textContent?.includes('Delete category')
      )!
    )

    const dialog = document.body.querySelector('[data-slot="memory-confirm-dialog"]')
    expect(dialog?.getAttribute('class')).toContain('z-[70]!')
    expect(dialog?.textContent).toContain('Delete category?')
  })

  it('keeps the memory layout and note list within their own scroll region', async () => {
    useMemoryStore.setState({
      categories: [
        aboutYouCategory({
          entries: [
            memoryEntry({ content: 'First note' }),
            memoryEntry({
              id: 'entry-b',
              content: 'Second note',
              createdAt: 3,
              updatedAt: 3
            })
          ]
        })
      ]
    })
    await renderMemoryPanel()

    expect(container.querySelector('[data-slot="memory-panel"]')?.className).toContain('h-full')
    expect(container.querySelector('[data-slot="memory-entry-list"]')?.className).toContain(
      'overflow-y-auto'
    )
  })

  it('renders note rows without separators and aligns non-destructive icon colors', async () => {
    useMemoryStore.setState({
      categories: [aboutYouCategory({ entries: [memoryEntry()] })]
    })
    await renderMemoryPanel()

    expect(container.querySelector('[data-slot="memory-entry"]')?.className).not.toContain(
      'border-b'
    )
    expect(container.querySelector('button[aria-label="Copy note"]')?.className).toContain(
      'text-muted-foreground'
    )
    expect(container.querySelector('button[aria-label="Edit note"]')?.className).toContain(
      'text-muted-foreground'
    )
  })

  it('fails closed to the list when an edit history target no longer exists', async () => {
    const onNavigate = vi.fn()

    await renderMemoryPanel({ kind: 'edit', categoryId: 'deleted-category' }, onNavigate)

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })
    expect(container.querySelector('input[name="memory-category-name"]')).toBeNull()
    expect(document.body.textContent).toContain('About you')
  })

  it('renders a derived project container with compact provenance and opens that project', async () => {
    const onOpenProject = vi.fn()
    useMemoryStore.setState({
      projects: [
        memoryProject({
          entries: [
            memoryEntry({
              id: 'entry-project',
              categoryId: 'category-a',
              categoryName: 'Research findings',
              projectId: 'project-a',
              projectName: 'Project A',
              content: 'The assay requires a 15 minute incubation.',
              origin: 'agent',
              createdAt: 4,
              updatedAt: 4
            })
          ]
        })
      ]
    })
    await renderMemoryPanel({ kind: 'list' }, vi.fn(), onOpenProject)

    fireEvent.click(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.textContent?.includes('Project A')
      )!
    )

    const entry = container.querySelector('[data-slot="memory-entry"]')
    expect(entry?.textContent).toContain('auto')
    expect(entry?.textContent).toContain('Research findings')
    fireEvent.click(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Open project'
      )!
    )
    expect(onOpenProject).toHaveBeenCalledWith('project-a')
  })

  it('omits the category tag for uncategorized project-only memory', async () => {
    useMemoryStore.setState({
      projects: [
        memoryProject({
          entries: [
            memoryEntry({
              id: 'entry-project-only',
              categoryId: null,
              categoryName: null,
              projectId: 'project-a',
              projectName: 'Project A',
              content: 'This memory only belongs to Project A.',
              origin: 'agent'
            })
          ]
        })
      ]
    })
    await renderMemoryPanel()

    fireEvent.click(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.textContent?.includes('Project A')
      )!
    )

    expect(
      container.querySelector('[data-slot="memory-entry-metadata"]')?.textContent?.trim()
    ).toBe('auto')
  })

  it('separates category navigation from project navigation', async () => {
    useMemoryStore.setState({ projects: [memoryProject()] })
    await renderMemoryPanel()

    const categoryNavigation = container.querySelector('[aria-label="Memory categories"]')
    const separator = container.querySelector('[data-slot="separator"]')
    const projectNavigation = container.querySelector('[aria-label="Project memory"]')

    expect(separator).not.toBeNull()
    expect(separator?.getAttribute('data-orientation')).toBe('horizontal')
    expect(separator?.classList.contains('h-px')).toBe(true)
    expect(separator?.classList.contains('w-full')).toBe(true)
    expect(categoryNavigation?.compareDocumentPosition(separator!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(separator?.compareDocumentPosition(projectNavigation!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('creates a manual note inside the selected project without a global category', async () => {
    const createEntry = vi.fn().mockResolvedValue(undefined)
    useMemoryStore.setState({
      projects: [memoryProject()],
      createEntry
    })
    await renderMemoryPanel({ kind: 'list' }, vi.fn(), vi.fn())
    fireEvent.click(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.textContent?.includes('Project A')
      )!
    )
    fireEvent.click(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Add'
      )!
    )
    fireEvent.change(container.querySelector('textarea')!, {
      target: { value: 'Manually recorded project fact' }
    })
    await act(async () => {
      fireEvent.click(
        Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
          (button) => button.textContent?.trim() === 'Save'
        )!
      )
    })

    expect(createEntry).toHaveBeenCalledWith({
      projectId: 'project-a',
      categoryId: null,
      content: 'Manually recorded project fact'
    })
  })
})
