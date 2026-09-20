// @vitest-environment jsdom
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import * as annotationContext from '../../pdf-annotations/pdf-annotations-context'
import * as annotationReveal from '../../annotations/annotation-reveal'
import { fireEvent, getByRole } from '@testing-library/react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PdfAnnotation } from '../../../../../../shared/pdf-annotations'
import type { PdfBookmarkSource } from '../../../../../../shared/pdf-bookmarks'
import { PdfAnnotationsProvider } from '../../pdf-annotations/PdfAnnotationsProvider'
import { PdfNotebookView } from './PdfNotebookView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source: PdfBookmarkSource = {
  kind: 'literature-attachment-version',
  projectId: 'project-1',
  sourceFileId: 'file-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  name: 'paper.pdf',
  path: 'literature-attachment-version:version-1'
}

const bookmark = (id: string, note: string, markKind: 'highlight' | 'area'): PdfAnnotation => ({
  id,
  projectId: 'project-1',
  sessionId: 'session-1',
  version: 1,
  origin: 'user',
  target: {
    source,
    selector:
      markKind === 'area'
        ? {
            kind: 'region',
            pageNumber: 2,
            rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
            pageRotation: 0,
            coordinateVersion: 1
          }
        : {
            kind: 'text',
            pageNumber: 1,
            exact: 'A highlighted passage',
            position: { start: 0, end: 22 },
            quads: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.03 }],
            extractorVersion: 'pdfjs-test',
            pageRotation: 0,
            coordinateVersion: 1
          }
  },
  kind: markKind,
  color: markKind === 'area' ? 'purple' : 'yellow',
  tagIds: markKind === 'highlight' ? ['important'] : [],
  note,
  createdAt: `2026-09-19T00:00:0${id.slice(-1)}.000Z`,
  updatedAt: `2026-09-19T00:00:0${id.slice(-1)}.000Z`
})

describe('PdfNotebookView', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    useTagStore.setState({
      ...createInitialTagState(),
      status: 'ready',
      tags: [
        {
          id: 'important',
          name: 'important',
          iconKey: 'tag',
          colorKey: 'blue',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    window.api = {
      tags: {
        snapshot: vi.fn(async () => ({
          revision: 1,
          tags: useTagStore.getState().tags,
          assignments: []
        }))
      },
      pdfAnnotations: {
        list: vi.fn().mockResolvedValue({
          items: [
            bookmark('bookmark-1', 'Review this claim.', 'highlight'),
            bookmark('bookmark-2', '', 'area')
          ],
          total: 2
        }),
        update: vi.fn(),
        delete: vi.fn()
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  const selectOption = async (label: string, option: string): Promise<void> => {
    await act(async () =>
      fireEvent.keyDown(container.querySelector(`[aria-label="${label}"]`)!, { key: 'ArrowDown' })
    )
    const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === option
    )!
    expect(item).toBeDefined()
    await act(async () => fireEvent.click(item))
  }

  it('lists PDF marks and filters commented annotations', async () => {
    await act(async () => {
      root.render(
        createElement(
          PdfAnnotationsProvider,
          { projectId: 'project-1', sessionId: 'session-1' },
          createElement(PdfNotebookView, { source, active: true })
        )
      )
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('A highlighted passage'))
    expect(container.querySelector('section[aria-label]')?.getAttribute('aria-label')).toBe(
      'Notes & Annotations'
    )
    expect(container.querySelector('li')?.className).toContain('content-visibility:auto')
    expect(container.textContent).toContain('A highlighted passage')
    expect(container.textContent).toContain('PDF region on page 2')
    expect(container.querySelector('[aria-label="Selected area"]')).not.toBeNull()
    expect(container.querySelector('blockquote span')?.className).toContain('line-clamp-3')

    await toggleFilters()
    await selectOption('Annotation filter', 'Commented')
    expect(container.textContent).toContain('A highlighted passage')
    expect(container.textContent).not.toContain('PDF region on page 2')
  })
  const toggleFilters = async (): Promise<void> => {
    await act(async () =>
      fireEvent.click(getByRole(container, 'button', { name: 'Search & filter' }))
    )
  }

  const renderNotebook = async (active = true): Promise<void> => {
    await act(async () =>
      root.render(
        createElement(
          PdfAnnotationsProvider,
          { projectId: 'project-1', sessionId: 'session-1' },
          createElement(PdfNotebookView, { source, active })
        )
      )
    )
  }

  it('hides the duplicate title and filters by default, retains collapsed filters and can clear them', async () => {
    await renderNotebook()
    expect(container.querySelector('header h2')).toBeNull()
    expect(container.querySelector('[aria-label="Search annotations"]')).toBeNull()
    const trigger = getByRole(container, 'button', { name: 'Search & filter' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await toggleFilters()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await act(async () =>
      fireEvent.change(container.querySelector('[aria-label="Search annotations"]')!, {
        target: { value: 'IMPORTANT' }
      })
    )
    expect(container.querySelectorAll('li')).toHaveLength(1)
    await toggleFilters()
    expect(container.querySelector('[aria-label="Search annotations"]')).toBeNull()
    expect(container.querySelectorAll('li')).toHaveLength(1)
    expect(trigger.textContent).toBe('1')
    await toggleFilters()
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Search annotations"]')!.value
    ).toBe('IMPORTANT')
    await act(async () =>
      fireEvent.click(
        [...container.querySelectorAll('button')].find(
          (button) => button.textContent === 'Clear filters'
        )!
      )
    )
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(trigger.textContent).toBe('')
  })

  it.each([false, true])(
    'focuses a document note when revealing its saved source (filtered: %s)',
    async (filtered) => {
      const note = bookmark('bookmark-1', 'Document summary', 'highlight')
      note.kind = 'document-note'
      note.target = { source, selector: { kind: 'document-note', coordinateVersion: 1 } }
      vi.mocked(window.api.pdfAnnotations.list).mockResolvedValue({ items: [note], total: 1 })
      await renderNotebook()
      if (filtered) {
        await toggleFilters()
        await act(async () =>
          fireEvent.change(container.querySelector('[aria-label="Search annotations"]')!, {
            target: { value: 'no matching note' }
          })
        )
        expect(container.querySelector('li')).toBeNull()
      }
      let outcome: ReturnType<typeof annotationReveal.requestPdfAnnotationReveal>
      await act(async () => {
        outcome = annotationReveal.requestPdfAnnotationReveal(note)
      })
      expect(await outcome!).toBe('revealed')
      expect(document.activeElement).toBe(container.querySelector('li'))
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    }
  )

  it('offers both note scopes from one action and preserves the draft when switching scope', async () => {
    await renderNotebook()
    const trigger = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Add note'
    )!
    const chooseScope = async (label: string): Promise<void> => {
      await act(async () => fireEvent.keyDown(trigger, { key: 'ArrowDown' }))
      const option = [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent === label
      )!
      await act(async () => fireEvent.click(option))
    }
    expect(container.textContent).not.toContain('Add document note')
    expect(container.textContent).not.toContain('Add page note')
    await chooseScope('Add document note')
    const editor = container.querySelector<HTMLTextAreaElement>('#pdf-notebook-note')!
    expect(editor).not.toBeNull()
    expect(container.querySelector('input[type="number"]')).toBeNull()
    await act(async () => fireEvent.change(editor, { target: { value: 'Keep my note' } }))
    await chooseScope('Add page note')
    expect(container.querySelector<HTMLTextAreaElement>('#pdf-notebook-note')!.value).toBe(
      'Keep my note'
    )
    expect(container.querySelector('input[type="number"]')).not.toBeNull()
  })

  it('searches quotes, comments and tags, sorts by time, and distinguishes no matches from an empty notebook', async () => {
    await renderNotebook()
    await toggleFilters()
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search annotations"]')!
    await act(async () => {
      fireEvent.change(search, { target: { value: 'IMPORTANT' } })
    })
    expect(container.querySelectorAll('li')).toHaveLength(1)
    expect(container.textContent).toContain('Review this claim.')
    await act(async () => {
      fireEvent.change(search, { target: { value: 'missing phrase' } })
    })
    expect(container.textContent).toContain('No matching annotations.')
    expect(container.textContent).not.toContain('No annotations yet.')
    await act(async () => {
      fireEvent.change(search, { target: { value: '' } })
    })
    await selectOption('Sort annotations', 'Newest first')
    expect(container.querySelector('li')?.textContent).toContain('PDF region on page 2')
  })

  it('keeps tag add fixed in the card header and removes a tag with Backspace', async () => {
    const updated = bookmark('bookmark-1', 'Review this claim.', 'highlight')
    updated.tagIds = []
    vi.mocked(window.api.pdfAnnotations.update).mockResolvedValueOnce(updated)
    await renderNotebook()

    const card = container.querySelector('li')!
    const addTag = card.querySelector<HTMLButtonElement>('[aria-label="Add tag"]')!
    const removeTag = card.querySelector<HTMLButtonElement>(
      '[aria-label="Remove important from this annotation"]'
    )!
    expect(addTag).not.toBeNull()
    expect(addTag.compareDocumentPosition(removeTag) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    await act(async () => fireEvent.keyDown(removeTag, { key: 'Backspace' }))
    await vi.waitFor(() =>
      expect(window.api.pdfAnnotations.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bookmark-1', tagIds: [] })
      )
    )
  })

  it('removes tags only through the X control, not by clicking the tag label', async () => {
    const updated = bookmark('bookmark-1', 'Review this claim.', 'highlight')
    updated.tagIds = []
    vi.mocked(window.api.pdfAnnotations.update).mockResolvedValueOnce(updated)
    await renderNotebook()
    const card = container.querySelector('li')!
    const label = card.querySelector('[title="important"]')!
    await act(async () => fireEvent.click(label))
    expect(window.api.pdfAnnotations.update).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.click(getByRole(card, 'button', { name: 'Remove important from this annotation' }))
    )
    expect(window.api.pdfAnnotations.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bookmark-1', tagIds: [] })
    )
  })

  it('follows global tag order rather than annotation assignment order', async () => {
    const tags = ['first', 'second', 'third'].map((id) => ({
      id,
      name: id,
      iconKey: 'tag' as const,
      colorKey: 'blue' as const,
      createdAt: 1,
      updatedAt: 1
    }))
    useTagStore.setState({ tags })
    const mark = bookmark('bookmark-1', '', 'highlight')
    mark.tagIds = ['third', 'second', 'first']
    vi.mocked(window.api.pdfAnnotations.list).mockResolvedValue({ items: [mark], total: 1 })
    await renderNotebook()
    const labels = (): (string | null)[] =>
      [...container.querySelectorAll('li [aria-label^="Remove "]')].map((node) =>
        node.getAttribute('aria-label')
      )
    expect(labels()).toEqual([
      'Remove first from this annotation',
      'Remove second from this annotation'
    ])
    await act(async () => useTagStore.setState({ tags: [tags[2], tags[0], tags[1]] }))
    expect(labels()).toEqual([
      'Remove third from this annotation',
      'Remove first from this annotation'
    ])
    expect(window.api.pdfAnnotations.update).not.toHaveBeenCalled()
  })

  it('keeps all tags manageable when the card folds overflow tags', async () => {
    const tags = Array.from({ length: 4 }, (_, index) => ({
      id: `tag-${index}`,
      name: `Tag ${index}`,
      iconKey: 'tag' as const,
      colorKey: 'blue' as const,
      createdAt: 1,
      updatedAt: 1
    }))
    useTagStore.setState({ tags })
    const mark = bookmark('bookmark-1', '', 'highlight')
    mark.tagIds = tags.map((tag) => tag.id)
    vi.mocked(window.api.pdfAnnotations.list).mockResolvedValue({ items: [mark], total: 1 })
    vi.mocked(window.api.pdfAnnotations.update).mockImplementation(async (request) => ({
      ...mark,
      tagIds: request.tagIds ?? mark.tagIds
    }))
    await renderNotebook()
    const card = container.querySelector('li')!
    expect(card.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(2)
    await act(async () => fireEvent.click(getByRole(card, 'button', { name: 'Manage Tags' })))
    const lastTag = getByRole(document.body, 'option', { name: 'Tag 3' })
    await act(async () => fireEvent.click(lastTag))
    expect(window.api.pdfAnnotations.update).toHaveBeenCalledWith(
      expect.objectContaining({ tagIds: ['tag-0', 'tag-1', 'tag-2'] })
    )
  })

  it('reveals a source only through its arrow, never through quote, area, or comment content', async () => {
    const reveal = vi
      .spyOn(annotationReveal, 'requestPdfAnnotationReveal')
      .mockResolvedValue('revealed')
    await renderNotebook()
    await act(async () => {
      fireEvent.click(container.querySelector('blockquote')!)
      fireEvent.click(container.querySelector('[aria-label="Selected area"]')!)
      fireEvent.click(
        [...container.querySelectorAll('span')].find(
          (node) => node.textContent === 'Review this claim.'
        )!
      )
    })
    expect(reveal).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.click(
        getByRole(container.querySelector('li')!, 'button', { name: 'Show annotation source' })
      )
    )
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('uses document undo shortcuts while preserving native undo inside the note editor', async () => {
    let stored = bookmark('bookmark-1', 'Review this claim.', 'highlight')
    let version = 3
    vi.mocked(window.api.pdfAnnotations.update).mockImplementation(async (request) => {
      stored = {
        ...stored,
        note: request.note ?? stored.note,
        tagIds: request.tagIds ?? stored.tagIds,
        color: request.color ?? undefined,
        updatedAt: `2026-09-19T00:00:0${version++}.000Z`
      }
      return stored
    })
    await renderNotebook()
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Edit annotation note"]')!)
    })
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Annotation note"]')!
    expect(editor.closest('li')?.className).not.toContain('content-visibility:auto')
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'Revised comment' } })
    })
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save'
    )!
    await act(async () => {
      fireEvent.click(save)
    })
    expect(stored.note).toBe('Revised comment')
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Edit annotation note"]')!)
    })
    await act(async () => {
      fireEvent.keyDown(container.querySelector('[aria-label="Annotation note"]')!, {
        key: 'z',
        ctrlKey: true
      })
    })
    expect(stored.note).toBe('Revised comment')
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )!
    await act(async () => {
      fireEvent.click(cancel)
    })
    await act(async () => {
      fireEvent.keyDown(container.querySelector('section')!, { key: 'z', ctrlKey: true })
    })
    expect(stored.note).toBe('Review this claim.')
    await act(async () => {
      fireEvent.keyDown(container.querySelector('section')!, {
        key: 'z',
        metaKey: true,
        shiftKey: true
      })
    })
    expect(stored.note).toBe('Revised comment')
  })

  it('keeps editing in Notes and reveals the PDF only through the explicit source action', async () => {
    const reveal = vi
      .spyOn(annotationReveal, 'requestPdfAnnotationReveal')
      .mockResolvedValue('revealed')
    await renderNotebook()
    const card = container.querySelector('li')!
    await act(async () =>
      fireEvent.click(card.querySelector('[aria-label="Edit annotation note"]')!)
    )
    const field = card.querySelector('textarea')!
    const listReads = vi.spyOn(annotationContext, 'usePdfAnnotations')
    await act(async () => fireEvent.change(field, { target: { value: 'Unsaved draft' } }))
    expect(listReads).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(card.querySelector('blockquote')!))
    const blue = card.querySelector('[role="group"][aria-label="Color"] [aria-label="Blue"]')!
    await act(async () => fireEvent.click(blue))
    expect(blue.getAttribute('aria-pressed')).toBe('true')
    expect(reveal).not.toHaveBeenCalled()
    expect(field.value).toBe('Unsaved draft')
    await act(async () =>
      fireEvent.click(card.querySelector('[aria-label="Show annotation source"]')!)
    )
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('Unsaved draft')
  })

  it('retains an edited draft across PDF inspection and filter changes', async () => {
    await renderNotebook()
    await act(async () =>
      fireEvent.click(container.querySelector('[aria-label="Edit annotation note"]')!)
    )
    const field = container.querySelector<HTMLTextAreaElement>('[aria-label="Annotation note"]')!
    await act(async () => fireEvent.change(field, { target: { value: 'Keep this draft' } }))
    await renderNotebook(false)
    expect(container.querySelector('section')?.getAttribute('aria-hidden')).toBe('true')
    await renderNotebook(true)
    expect(container.querySelector('textarea')).toBe(field)
    expect(field.value).toBe('Keep this draft')
    await toggleFilters()
    await act(async () =>
      fireEvent.change(container.querySelector('[aria-label="Search annotations"]')!, {
        target: { value: 'no matching quote' }
      })
    )
    expect(container.querySelector('textarea')).toBe(field)
    expect(field.value).toBe('Keep this draft')
    await act(async () =>
      fireEvent.click(
        [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
      )
    )
    expect(container.textContent).toContain('No matching annotations.')
  })

  it('exports complete versioned JSON including source, selectors, colors and timestamps', async () => {
    let exported!: Blob
    const previousCreate = URL.createObjectURL
    const previousRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn((blob: Blob) => {
      exported = blob
      return 'blob:notes'
    })
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      await renderNotebook()
      await selectOption('Export format', 'JSON')
      await act(async () => {
        fireEvent.click(
          [...container.querySelectorAll('button')].find((button) =>
            button.textContent?.includes('Export notes')
          )!
        )
      })
      const content = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(exported)
      })
      expect(JSON.parse(content)).toEqual({
        format: 'open-science-pdf-annotations',
        version: 1,
        tags: useTagStore.getState().tags,
        source,
        annotations: [
          bookmark('bookmark-1', 'Review this claim.', 'highlight'),
          bookmark('bookmark-2', '', 'area')
        ]
      })
    } finally {
      URL.createObjectURL = previousCreate
      URL.revokeObjectURL = previousRevoke
      click.mockRestore()
    }
  })
})
