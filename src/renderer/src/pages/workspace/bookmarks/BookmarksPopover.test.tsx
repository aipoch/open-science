// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Bookmark } from '../../../../../shared/bookmarks'
import {
  subscribeAnnotationReveal,
  subscribeBookmarkReveal
} from '../annotations/annotation-reveal'
import { BookmarksPopover } from './BookmarksPopover'
import { BookmarksProvider } from './BookmarksProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const saved: Bookmark = {
  id: 'bookmark-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  version: 1,
  target: {
    kind: 'text',
    quote: 'selected evidence',
    source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
  },
  note: 'Check this claim',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
}

describe('BookmarksPopover', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    subscribeAnnotationReveal(() => true)()
    container.remove()
    vi.restoreAllMocks()
  })

  const renderPopover = async (items: Bookmark[] = [saved]): Promise<void> => {
    window.api = {
      bookmarks: {
        list: vi.fn().mockResolvedValue({ items, total: items.length }),
        updateNote: vi.fn().mockImplementation(async ({ note }) => ({ ...saved, note })),
        delete: vi.fn().mockResolvedValue({ deleted: true })
      }
    } as unknown as Window['api']
    await act(async () => {
      root.render(
        <BookmarksProvider projectId="project-1" sessionId="session-1">
          <BookmarksPopover />
        </BookmarksProvider>
      )
    })
    await act(async () => undefined)
  }

  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute('aria-label') === label
    )

  it('shows the Session count and reveals a saved source', async () => {
    const reveal = vi.fn()
    const stop = subscribeBookmarkReveal((target) => {
      reveal(target.id)
      return true
    })
    await renderPopover()

    const trigger = button('Bookmarks (1)')
    expect(trigger).toBeDefined()
    await act(async () => trigger?.click())
    expect(document.body.textContent).toContain('selected evidence')
    expect(document.body.textContent).toContain('Check this claim')

    await act(async () => button('Show bookmark source')?.click())
    expect(reveal).toHaveBeenCalledWith('bookmark-1')
    stop()
  })

  it('edits a note and deletes the bookmark', async () => {
    await renderPopover()
    await act(async () => button('Bookmarks (1)')?.click())
    await act(async () => button('Edit bookmark note')?.click())
    const note = document.querySelector<HTMLTextAreaElement>('[aria-label="Bookmark note"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(note, 'Updated note')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Save')?.click())
    expect(document.body.textContent).toContain('Updated note')

    await act(async () => button('Delete bookmark')?.click())
    expect(button('Bookmarks (0)')).toBeUndefined()
    expect(document.querySelector('[aria-label="Bookmarks"]')).toBeNull()
  })

  it('hides the entry when there are no bookmarks', async () => {
    await renderPopover([])
    expect(button('Bookmarks (0)')).toBeUndefined()
  })
})
