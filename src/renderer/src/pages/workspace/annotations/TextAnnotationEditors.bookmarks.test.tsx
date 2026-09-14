// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnnotationDraftEditor } from './TextAnnotationEditors'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AnnotationDraftEditor For me tab', () => {
  let container: HTMLDivElement
  let root: Root
  let range: Range

  beforeEach(() => {
    container = document.createElement('div')
    const paragraph = document.createElement('p')
    paragraph.textContent = 'selected evidence'
    container.append(paragraph)
    document.body.append(container)
    range = document.createRange()
    range.selectNodeContents(paragraph)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 10, right: 100, top: 10, bottom: 30, width: 90, height: 20 })
    })
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const renderEditor = async (bookmark: {
    available: boolean
    onSave: (note: string) => Promise<void>
  }): Promise<void> => {
    await act(async () => {
      root.render(
        <AnnotationDraftEditor
          range={range}
          backward={false}
          open
          note=""
          noteInputId="agent-note"
          variant="workspace"
          onOpenChange={vi.fn()}
          onCancel={vi.fn()}
          onNoteChange={vi.fn()}
          onAdd={vi.fn()}
          bookmark={bookmark}
        />
      )
    })
  }

  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === label
    )

  const enterNote = async (note: HTMLTextAreaElement, value: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(note, value)
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('saves an optional private note from the For me tab', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await renderEditor({ available: true, onSave })

    expect(document.querySelector('[role="tablist"]')?.textContent).toContain('To Agent')
    await act(async () => button('For me')?.click())
    const note = document.querySelector<HTMLTextAreaElement>('[data-bookmark-note]')!
    await enterNote(note, 'Read this again')
    await act(async () => button('Bookmark')?.click())

    expect(onSave).toHaveBeenCalledWith('Read this again')
  })

  it('explains why For me is disabled without a persisted Session', async () => {
    await renderEditor({ available: false, onSave: vi.fn() })

    await act(async () => button('For me')?.click())

    expect(document.body.textContent).toContain(
      'Bookmarks are available after this conversation is saved.'
    )
    expect(button('Bookmark')?.disabled).toBe(true)
  })

  it('keeps the note available for retry after saving fails', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('Database is busy'))
      .mockResolvedValueOnce(undefined)
    await renderEditor({ available: true, onSave })
    await act(async () => button('For me')?.click())
    const note = document.querySelector<HTMLTextAreaElement>('[data-bookmark-note]')!
    await enterNote(note, 'Keep this note')

    await act(async () => button('Bookmark')?.click())
    expect(document.body.textContent).toContain('Bookmark could not be saved. Try again.')
    expect(note.value).toBe('Keep this note')

    await act(async () => button('Bookmark')?.click())
    expect(onSave).toHaveBeenNthCalledWith(2, 'Keep this note')
  })

  it('keeps For me available when the Agent annotation target is a historical version', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      root.render(
        <AnnotationDraftEditor
          range={range}
          backward={false}
          open
          note=""
          noteInputId="agent-note"
          variant="preview"
          onOpenChange={vi.fn()}
          onCancel={vi.fn()}
          onNoteChange={vi.fn()}
          onAdd={vi.fn()}
          annotationBlockedByHistoricalVersion
          bookmark={{ available: true, onSave }}
        />
      )
    })

    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
    expect(document.body.textContent).toContain(
      'Historical versions cannot be annotated. Switch to the latest version to annotate.'
    )
    await act(async () => button('For me')?.click())
    expect(button('Bookmark')?.disabled).toBe(false)
    await act(async () => button('Bookmark')?.click())
    expect(onSave).toHaveBeenCalled()
  })
})
