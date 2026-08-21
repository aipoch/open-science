// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialMemoryState, useMemoryStore } from '@/stores/memory-store'
import { MemoryPanel } from './MemoryPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useMemoryStore.setState({
    ...createInitialMemoryState(),
    status: 'ready',
    categories: [
      {
        id: 'memory-category-about-you',
        systemKey: 'about-you',
        autoRecall: true,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        entries: []
      }
    ],
    selectedCategoryId: 'memory-category-about-you'
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MemoryPanel', () => {
  it('renders the retained-data off state and immutable About you category', async () => {
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

    expect(document.body.textContent).toContain('Memory is off.')
    expect(document.body.textContent).not.toContain('Turn on')
    expect(document.body.textContent).toContain('About you')
    expect(document.body.textContent).toContain('No notes yet.')
    expect(document.body.textContent).not.toContain('Delete category')
  })

  it('renders the category form with the custom-category count and auto-recall control', async () => {
    await act(async () =>
      root.render(<MemoryPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    )

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
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    fireEvent.click(add!)

    expect(container.querySelector('textarea[placeholder="Add a note…"]')).not.toBeNull()
  })

  it('discards a category-bound note draft when the selected category changes', async () => {
    useMemoryStore.setState({
      categories: [
        useMemoryStore.getState().categories[0]!,
        {
          id: 'category-a',
          name: 'Category A',
          guidance: '',
          autoRecall: true,
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
          entries: []
        },
        {
          id: 'category-b',
          name: 'Category B',
          guidance: '',
          autoRecall: false,
          revision: 1,
          createdAt: 3,
          updatedAt: 3,
          entries: []
        }
      ],
      selectedCategoryId: 'category-a'
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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
      categories: [
        {
          id: 'category-a',
          name: 'Category A',
          guidance: '',
          autoRecall: true,
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
          entries: []
        }
      ],
      selectedCategoryId: 'category-a'
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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
      categories: [
        useMemoryStore.getState().categories[0]!,
        {
          id: 'category-a',
          name: 'Category A',
          guidance: '',
          autoRecall: true,
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
          entries: []
        }
      ],
      selectedCategoryId: 'category-a'
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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
        {
          ...useMemoryStore.getState().categories[0]!,
          entries: [
            {
              id: 'entry-a',
              content: 'Keep this until confirmed',
              origin: 'user',
              revision: 1,
              createdAt: 2,
              updatedAt: 2
            }
          ]
        }
      ],
      deleteEntry
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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
        {
          ...useMemoryStore.getState().categories[0]!,
          entries: [
            {
              id: 'entry-a',
              content: 'Keep this after closing',
              origin: 'user',
              revision: 1,
              createdAt: 2,
              updatedAt: 2
            }
          ]
        }
      ],
      deleteEntry
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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
        {
          id: 'category-a',
          name: 'Category A',
          guidance: 'Save reusable category A findings',
          autoRecall: true,
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
          entries: []
        }
      ],
      selectedCategoryId: 'category-a'
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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
        {
          ...useMemoryStore.getState().categories[0]!,
          entries: [
            {
              id: 'entry-a',
              content: 'First note',
              origin: 'user',
              revision: 1,
              createdAt: 2,
              updatedAt: 2
            },
            {
              id: 'entry-b',
              content: 'Second note',
              origin: 'user',
              revision: 1,
              createdAt: 3,
              updatedAt: 3
            }
          ]
        }
      ]
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

    expect(container.querySelector('[data-slot="memory-panel"]')?.className).toContain('h-full')
    expect(container.querySelector('[data-slot="memory-entry-list"]')?.className).toContain(
      'overflow-y-auto'
    )
  })

  it('renders note rows without separators and aligns non-destructive icon colors', async () => {
    useMemoryStore.setState({
      categories: [
        {
          ...useMemoryStore.getState().categories[0]!,
          entries: [
            {
              id: 'entry-a',
              content: 'A note',
              origin: 'user',
              revision: 1,
              createdAt: 2,
              updatedAt: 2
            }
          ]
        }
      ]
    })
    await act(async () => root.render(<MemoryPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

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

    await act(async () =>
      root.render(
        <MemoryPanel
          view={{ kind: 'edit', categoryId: 'deleted-category' }}
          onNavigate={onNavigate}
        />
      )
    )

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })
    expect(container.querySelector('input[name="memory-category-name"]')).toBeNull()
    expect(document.body.textContent).toContain('About you')
  })
})
