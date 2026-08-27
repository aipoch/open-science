// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  Annotation,
  AnnotationValidationError,
  TextAnnotation
} from '../../../../../shared/annotations'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { requestAnnotationReveal } from '../annotations/annotation-reveal'
import { PreviewTextAnnotationSurface } from './PreviewTextAnnotationSurface'

const item = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'preview-1',
  type: 'file',
  title: 'notes.md',
  name: 'notes.md',
  path: '/project/notes.md',
  format: 'markdown',
  source: 'artifact',
  projectId: 'project-1',
  sessionId: 'session-1',
  selectedVersionId: 'version-7',
  ...overrides
})

const annotation = (overrides: Partial<TextAnnotation> = {}): TextAnnotation => ({
  id: 'annotation-1',
  kind: 'text',
  target: 'agent',
  quote: 'confidence intervals overlap',
  source: {
    kind: 'project-file',
    projectId: 'project-1',
    path: '/project/notes.md',
    name: 'notes.md',
    versionId: 'version-7',
    sessionId: 'session-1'
  },
  ...overrides
})

describe('PreviewTextAnnotationSurface', () => {
  let container: HTMLDivElement
  let root: Root
  let registeredRanges: Set<Range>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    registeredRanges = new Set()
    class TestHighlight extends Set<Range> {}
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: TestHighlight
    })
    // One stable Highlight instance per name, like the real registry: get
    // returns the same object that was set, so reveal and surface cleanups
    // operate on the same collection instead of stacked replacements.
    const singleton = {
      add: (range: Range) => registeredRanges.add(range),
      delete: (range: Range) => registeredRanges.delete(range)
    }
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        highlights: {
          get: vi.fn(() => singleton),
          set: vi.fn(() => undefined),
          delete: vi.fn(() => registeredRanges.clear())
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.getSelection()?.removeAllRanges()
  })

  const renderSurface = async ({
    activeAnnotations = [],
    onAddAnnotation = vi.fn(() => undefined),
    onUpdateAnnotationNote,
    onAnnotationError = vi.fn(),
    previewItem = item(),
    content = 'Experiment result: confidence intervals overlap.'
  }: {
    activeAnnotations?: readonly Annotation[]
    onAddAnnotation?: (annotation: Annotation) => undefined
    onUpdateAnnotationNote?: (id: string, note: string) => undefined
    onAnnotationError?: (error: AnnotationValidationError) => void
    previewItem?: PreviewFileItem
    content?: string
  } = {}): Promise<void> => {
    await act(async () => {
      root.render(
        <PreviewTextAnnotationSurface
          item={previewItem}
          activeAnnotations={activeAnnotations}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotationNote={onUpdateAnnotationNote}
          onAnnotationError={onAnnotationError}
        >
          <p>{content}</p>
        </PreviewTextAnnotationSurface>
      )
    })
  }

  const selectRange = async (start: number, end: number): Promise<void> => {
    const text = container.querySelector('p')?.firstChild
    if (!text) throw new Error('Preview text was not rendered')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, end)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        right: 120,
        top: 20,
        bottom: 40,
        width: 110,
        height: 20,
        x: 10,
        y: 20,
        toJSON: () => ({})
      })
    })
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    await act(async () => {
      container
        .querySelector('[data-preview-text-annotation-surface="true"]')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
  }

  const selectQuote = (): Promise<void> => selectRange(19, 47)

  const confirmAnnotation = async (): Promise<void> => {
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())
    const actions = Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => actions.at(-1)?.click())
  }

  it('creates a versioned project-file annotation only after confirmation', async () => {
    const onAddAnnotation = vi.fn<(annotation: Annotation) => undefined>(() => undefined)
    await renderSurface({ onAddAnnotation })
    await selectQuote()

    expect(onAddAnnotation).not.toHaveBeenCalled()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())
    const actions = Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent === 'Annotate'
    )
    await act(async () => actions.at(-1)?.click())

    expect(onAddAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        quote: 'confidence intervals overlap',
        source: {
          kind: 'project-file',
          projectId: 'project-1',
          path: '/project/notes.md',
          name: 'notes.md',
          versionId: 'version-7',
          sessionId: 'session-1'
        }
      })
    )
    expect(registeredRanges.size).toBe(1)
  })

  it('renders the annotation editor above full-screen preview chrome', async () => {
    await renderSurface()
    await selectQuote()

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-annotation-trigger]')?.click()
    )

    const popover = document.querySelector<HTMLElement>(
      '[data-radix-popper-content-wrapper] > [data-state="open"]'
    )
    expect(popover).not.toBeNull()
    expect(popover?.className).toContain('z-[70]')
    expect(popover?.className).not.toContain('z-50')
  })

  it('does not create an annotation for cancellation or an empty selection', async () => {
    const onAddAnnotation = vi.fn(() => undefined)
    await renderSurface({ onAddAnnotation })

    await act(async () => {
      container
        .querySelector('[data-preview-text-annotation-surface="true"]')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('To Agent')

    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())

    expect(onAddAnnotation).not.toHaveBeenCalled()
  })

  it('reprojects matching draft quotes after reopening and ignores other sources', async () => {
    await renderSurface({
      activeAnnotations: [
        annotation(),
        annotation({
          id: 'annotation-other',
          source: {
            kind: 'project-file',
            projectId: 'project-1',
            path: '/project/other.md',
            versionId: 'version-7'
          }
        }),
        annotation({
          id: 'annotation-other-version',
          source: {
            kind: 'project-file',
            projectId: 'project-1',
            path: '/project/notes.md',
            versionId: 'version-8'
          }
        })
      ]
    })

    expect(container.textContent).toContain('Annotated for Agent')
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(registeredRanges.size).toBe(1)

    await act(async () => root.render(<div>Preview closed</div>))
    expect(registeredRanges.size).toBe(0)

    await renderSurface({ activeAnnotations: [annotation()] })
    expect(registeredRanges.size).toBe(1)

    await renderSurface({ activeAnnotations: [] })
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()
    expect(registeredRanges.size).toBe(0)
  })

  it('edits an existing annotation in a full-screen-safe local popover', async () => {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: 10, right: 120, top: 20, bottom: 40, width: 110, height: 20 }]
    })
    const onUpdateAnnotationNote = vi.fn(() => undefined)
    await renderSurface({
      activeAnnotations: [annotation({ note: 'Original preview note' })],
      onUpdateAnnotationNote
    })

    const pencil = container.querySelector<HTMLButtonElement>('[data-text-annotation-edit]')
    await act(async () => pencil?.click())
    const editor = document.querySelector<HTMLTextAreaElement>('[data-source-annotation-note]')!
    expect(editor.value).toBe('Original preview note')
    expect(
      editor.closest('[data-radix-popper-content-wrapper]')?.firstElementChild?.className
    ).toContain('z-[70]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'Updated preview note')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    )
    expect(onUpdateAnnotationNote).toHaveBeenCalledWith('annotation-1', 'Updated preview note')
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
  })

  it('preserves exact duplicate ranges until deletion and falls back only after reopening', async () => {
    const onAddAnnotation = vi.fn<(annotation: Annotation) => undefined>(() => undefined)
    const content = 'repeat then repeat'
    await renderSurface({ onAddAnnotation, content })
    await selectRange(12, 18)
    await confirmAnnotation()
    const second = onAddAnnotation.mock.calls[0]?.[0] as TextAnnotation

    await renderSurface({ activeAnnotations: [second], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([12])

    await selectRange(0, 6)
    await confirmAnnotation()
    const first = onAddAnnotation.mock.calls[1]?.[0] as TextAnnotation
    await renderSurface({ activeAnnotations: [second, first], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([12, 0])

    await renderSurface({ activeAnnotations: [second], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([12])

    await act(async () => root.render(<div>Preview closed</div>))
    await renderSurface({ activeAnnotations: [second], onAddAnnotation, content })
    expect(Array.from(registeredRanges).map((range) => range.startOffset)).toEqual([0])
  })

  it('reprojects a Preview quote after content mutation and removes stale color when it disappears', async () => {
    const active = [annotation({ id: 'content-update', quote: 'repeat' })]
    await renderSurface({ activeAnnotations: active, content: 'repeat then repeat' })
    expect(Array.from(registeredRanges)[0]?.startOffset).toBe(0)

    await renderSurface({ activeAnnotations: active, content: 'prefix repeat then repeat' })
    const moved = Array.from(registeredRanges)[0]
    expect(moved?.toString()).toBe('repeat')
    expect(moved?.startOffset).toBe(7)

    await renderSurface({ activeAnnotations: active, content: 'quote disappeared' })
    expect(registeredRanges.size).toBe(0)
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
  })

  it('does not expose annotation controls without a project identity', async () => {
    await renderSurface({ previewItem: item({ projectId: undefined, source: 'local' }) })
    await selectQuote()

    expect(document.body.textContent).not.toContain('To Agent')
  })

  it('keeps the annotate entry alive when clicking it collapses the browser selection', async () => {
    await renderSurface()
    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    expect(entry).toBeDefined()

    // A real browser collapses the selection on mousedown before the click
    // lands, and the button's mouseup bubbles back into the surface.
    window.getSelection()?.removeAllRanges()
    await act(async () => entry!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const surviving = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    expect(surviving).toBe(entry)

    await act(async () => surviving?.click())
    expect(document.querySelector('textarea')).not.toBeNull()
  })

  it('clears the draft entry when clicking anywhere outside it', async () => {
    await renderSurface()
    await selectQuote()
    expect(document.querySelector<HTMLElement>('[data-annotation-trigger]')).toBeDefined()

    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })

    expect(document.querySelector<HTMLElement>('[data-annotation-trigger]')).toBeNull()
  })

  it('hides the entry while the note editor is open and restores it after escape', async () => {
    await renderSurface()
    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())

    expect(document.querySelector<HTMLElement>('[data-annotation-trigger]')).toBeNull()
    expect(document.querySelector('textarea')).not.toBeNull()

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector<HTMLElement>('[data-annotation-trigger]')).toBeDefined()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('keeps the selection highlighted while the note editor is open', async () => {
    await renderSurface()
    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())

    expect(Array.from(registeredRanges).map((range) => range.toString())).toContain(
      'confidence intervals overlap'
    )

    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())
    expect(registeredRanges.size).toBe(0)
  })

  it('hands the pending highlight over to the confirmed annotation', async () => {
    const onAddAnnotation = vi.fn<(annotation: Annotation) => undefined>(() => undefined)
    await renderSurface({ onAddAnnotation })
    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())
    const pending = Array.from(registeredRanges)[0]
    expect(pending?.toString()).toBe('confidence intervals overlap')

    await confirmAnnotation()

    expect(onAddAnnotation).toHaveBeenCalledTimes(1)
    expect(registeredRanges.size).toBe(1)
    expect(Array.from(registeredRanges)[0]).toBe(pending)
  })

  it('does not repeat the selected quote inside the note editor', async () => {
    await renderSurface()
    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())

    const editor = document.querySelector('[data-radix-popper-content-wrapper]')
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toContain('To Agent')
    expect(editor?.textContent).not.toContain('confidence intervals overlap')
  })

  it('clears the native selection when the editor is dismissed by escape', async () => {
    await renderSurface()
    await selectQuote()
    const entry = document.querySelector<HTMLElement>('[data-annotation-trigger]')
    await act(async () => entry?.click())
    expect(window.getSelection()?.rangeCount).toBeGreaterThan(0)

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector('textarea')).toBeNull()
    expect(window.getSelection()?.rangeCount).toBe(0)
    expect(registeredRanges.size).toBe(0)
  })

  it('reveals the quoted text when the composer card requests it', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const onAddAnnotation = vi.fn<(annotation: Annotation) => undefined>(() => undefined)
    await renderSurface({ onAddAnnotation })
    await selectQuote()
    await confirmAnnotation()
    const added = onAddAnnotation.mock.calls[0]?.[0] as TextAnnotation

    await act(async () => requestAnnotationReveal(added))

    // Only a surface that owns the annotation's range reaches the reveal
    // choreography; the scroll call proves the range was found and passed on.
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
})
