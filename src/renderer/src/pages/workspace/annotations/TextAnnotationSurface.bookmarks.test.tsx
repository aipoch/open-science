// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installCssHighlightsMock, type TestHighlightRegistry } from '@/test-utils/css-highlights'
import type { Bookmark, CreateBookmarkRequest } from '../../../../../shared/bookmarks'
import { BookmarksProvider } from '../bookmarks/BookmarksProvider'
import { TextAnnotationSurface } from './TextAnnotationSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('TextAnnotationSurface private bookmarks', () => {
  let container: HTMLDivElement
  let root: Root
  let highlights: TestHighlightRegistry

  beforeEach(() => {
    highlights = installCssHighlightsMock()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.getSelection()?.removeAllRanges()
    vi.restoreAllMocks()
  })

  const renderSurface = async (): Promise<HTMLParagraphElement> => {
    await act(async () => {
      root.render(
        <BookmarksProvider projectId="project-1" sessionId="session-1">
          <TextAnnotationSurface
            source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
            activeAnnotations={[]}
            onAdd={vi.fn()}
            onError={vi.fn()}
          >
            <p>selected evidence</p>
          </TextAnnotationSurface>
        </BookmarksProvider>
      )
    })
    return container.querySelector('p')!
  }

  const selectParagraph = async (paragraph: HTMLParagraphElement): Promise<void> => {
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 10, right: 100, top: 10, bottom: 30, width: 90, height: 20 })
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  }

  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === label
    )

  it('keeps one create id through failure and marks the quote only after commit', async () => {
    const create = vi
      .fn<(request: CreateBookmarkRequest) => Promise<Bookmark>>()
      .mockRejectedValueOnce(new Error('Database is busy'))
      .mockImplementation(async (request) => ({
        ...request,
        version: 1,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z'
      }))
    window.api = {
      bookmarks: {
        list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
        create
      }
    } as unknown as Window['api']
    const paragraph = await renderSurface()
    await act(async () => undefined)
    await selectParagraph(paragraph)
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-annotation-trigger]')?.click()
    )
    await act(async () => button('For me')?.click())

    await act(async () => button('Bookmark')?.click())
    expect(Array.from(highlights.get('personal-bookmark') ?? [])).toHaveLength(0)
    expect(document.body.textContent).toContain('Bookmark could not be saved. Try again.')

    await act(async () => button('Bookmark')?.click())

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]?.[0].id).toBe(create.mock.calls[1]?.[0].id)
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      projectId: 'project-1',
      sessionId: 'session-1',
      target: {
        kind: 'text',
        quote: 'selected evidence',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' },
        anchor: { position: { start: 0, end: 17 } }
      }
    })
    expect(
      Array.from(highlights.get('personal-bookmark') ?? []).map((range) => range.toString())
    ).toEqual(['selected evidence'])
    expect(document.querySelector('[data-bookmark-active="true"]')).not.toBeNull()
  })
})
