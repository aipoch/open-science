// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installCssHighlightsMock, type TestHighlightRegistry } from '@/test-utils/css-highlights'
import type { TextAnnotation } from '../../../../../shared/annotations'
import { WorkspaceToolCodeBlock } from '../WorkspaceToolCodeBlock'
import { requestAnnotationReveal } from './annotation-reveal'
import { TextAnnotationSurface } from './TextAnnotationSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let highlights: TestHighlightRegistry
const annotation = (id: string, quote: string): TextAnnotation => ({
  id,
  kind: 'text',
  target: 'agent',
  quote,
  source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
})

describe('TextAnnotationSurface highlight restoration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    highlights = installCssHighlightsMock()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderSurface = async (
    activeAnnotations: readonly TextAnnotation[],
    messageId = 'message-1',
    content = 'repeat then repeat'
  ): Promise<void> => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId }}
          activeAnnotations={activeAnnotations}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <p>{content}</p>
        </TextAnnotationSurface>
      )
    )
  }

  it('rebuilds duplicate quote ranges deterministically after a virtualized remount', async () => {
    const active = [annotation('first', 'repeat'), annotation('second', 'repeat')]
    await renderSurface(active)

    const firstMountRanges = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(firstMountRanges.map((range) => range.startOffset)).toEqual([0, 12])

    await renderSurface(active, 'message-2')
    expect(highlights.has('agent-annotation-draft')).toBe(false)
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()

    await act(async () => root.unmount())
    expect(highlights.has('agent-annotation-draft')).toBe(false)
    root = createRoot(container)
    await renderSurface(active)

    const remountedRanges = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(remountedRanges.map((range) => range.startOffset)).toEqual([0, 12])
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Annotated for Agent')
  })

  it('keeps the non-color annotation state when a saved quote can no longer be projected', async () => {
    const active = [annotation('missing', 'no longer present')]
    await renderSurface(active)

    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])).toHaveLength(0)
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Annotated for Agent')

    await renderSurface(active, 'message-1', 'no longer present')
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])).toHaveLength(1)

    await renderSurface(active, 'message-1', 'stream replaced the quote')
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])).toHaveLength(0)
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
  })

  it('reprojects an Agent quote when streaming mutates the mounted text node in place', async () => {
    const active = [annotation('streaming', 'repeat')]
    await renderSurface(active)
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])[0]?.startOffset).toBe(0)

    await renderSurface(active, 'message-1', 'prefix repeat then repeat')
    const range = Array.from(highlights.get('agent-annotation-draft') ?? [])[0]
    expect(range?.toString()).toBe('repeat')
    expect(range?.startOffset).toBe(7)
  })

  it('defers the highlight reconcile while animating and reconciles once streaming ends', async () => {
    const active = [annotation('streaming', 'repeat')]
    const renderWith = async (isAnimating: boolean, content: string): Promise<void> => {
      await act(async () =>
        root.render(
          <TextAnnotationSurface
            source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
            activeAnnotations={active}
            onAdd={vi.fn()}
            onError={vi.fn()}
            isAnimating={isAnimating}
          >
            <p>{content}</p>
          </TextAnnotationSurface>
        )
      )
    }

    await renderWith(false, 'repeat then repeat')
    expect(Array.from(highlights.get('agent-annotation-draft') ?? [])[0]?.toString()).toBe('repeat')

    // Streaming replaces the mounted text node; the live range collapses onto
    // the parent per DOM range adjustment. While animating it is left stale
    // instead of being re-anchored every frame.
    await renderWith(true, 'prefix repeat then repeat')
    const deferred = Array.from(highlights.get('agent-annotation-draft') ?? [])[0]
    expect(deferred?.toString()).toBe('')

    await renderWith(false, 'prefix repeat then repeat')
    const reconciled = Array.from(highlights.get('agent-annotation-draft') ?? [])[0]
    expect(reconciled?.toString()).toBe('repeat')
    expect(reconciled?.startOffset).toBe(7)
  })

  it('keeps a saved code quote highlighted and revealable after async syntax highlighting', async () => {
    const saved = {
      ...annotation('async-code', 'const answer = 42'),
      source: {
        kind: 'session-item' as const,
        sessionId: 'session-1',
        itemId: 'tool-1',
        itemType: 'tool-activity' as const,
        sectionId: 'code'
      }
    }
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={saved.source}
          activeAnnotations={[saved]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <WorkspaceToolCodeBlock code="const answer = 42" language="typescript" />
        </TextAnnotationSurface>
      )
    )

    expect(
      Array.from(highlights.get('agent-annotation-draft') ?? []).map((range) => range.toString())
    ).toContain('const answer = 42')

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="tool-code-block"] code span').length
      ).toBeGreaterThan(0)
    })
    await act(async () => Promise.resolve())

    const restored = Array.from(highlights.get('agent-annotation-draft') ?? [])
    expect(restored.map((range) => range.toString())).toContain('const answer = 42')
    expect(restored[0]?.startContainer.isConnected).toBe(true)

    await act(async () => requestAnnotationReveal(saved))
    expect(
      Array.from(highlights.get('agent-annotation-reveal') ?? []).map((range) => range.toString())
    ).toContain('const answer = 42')
    expect(scrollIntoView).toHaveBeenCalled()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('observes surface and content reflow and disconnects on cleanup', async () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe
        disconnect = disconnect
      }
    )
    await renderSurface([])
    expect(observe).toHaveBeenCalledTimes(2)
    await act(async () => root.render(<div>Unmounted surface</div>))
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('overlays a zero-layout pencil and edits the annotation locally with Cancel/Save', async () => {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ left: 10, right: 90, top: 24, bottom: 40, width: 80, height: 16 }]
    })
    const active = [{ ...annotation('editable', 'repeat'), note: 'Check this wording' }]
    const onUpdateNote = vi.fn(() => undefined)
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={active}
          onAdd={vi.fn()}
          onUpdateNote={onUpdateNote}
          onError={vi.fn()}
        >
          <p>repeat then repeat</p>
        </TextAnnotationSurface>
      )
    )

    const pencil = container.querySelector<HTMLButtonElement>('[data-text-annotation-edit]')
    expect(pencil?.parentElement?.className).toContain('absolute')
    expect(pencil?.className).toContain('bg-transparent')
    expect(pencil?.dataset.annotationNote).toBe('Check this wording')
    expect(pencil?.parentElement?.style.left).toBe('90px')
    await act(async () =>
      container
        .querySelector('p')
        ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 30 }))
    )
    const hoverNote = container.querySelector('[data-text-annotation-hover-note]')
    expect(hoverNote?.textContent).toBe('Check this wording')
    expect(hoverNote?.className).toContain('bg-muted')
    expect(hoverNote?.className).toContain('truncate')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-text-annotation-edit]')?.click()
    )
    expect(
      document.querySelector<HTMLTextAreaElement>('[data-source-annotation-note]')?.value
    ).toBe('Check this wording')
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent === 'Cancel'
      )
    ).toBe(true)
    const editor = document.querySelector<HTMLTextAreaElement>('[data-source-annotation-note]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'Updated locally')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    )
    expect(onUpdateNote).toHaveBeenCalledWith('editable', 'Updated locally')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-text-annotation-edit]')?.click()
    )
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click()
    )
    expect(document.querySelector('[data-source-annotation-note]')).toBeNull()
    expect(onUpdateNote).toHaveBeenCalledTimes(1)
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
  })
})

describe('TextAnnotationSurface note editor highlight', () => {
  let container: HTMLDivElement
  let root: Root
  let highlights: TestHighlightRegistry

  beforeEach(() => {
    highlights = installCssHighlightsMock()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    container.remove()
    window.getSelection()?.removeAllRanges()
  })

  const renderSurface = async (): Promise<HTMLParagraphElement> => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    return container.querySelector('p')!
  }

  const commitSelection = async (paragraph: HTMLParagraphElement): Promise<void> => {
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 10,
          right: 120,
          top: 20,
          bottom: 40,
          width: 110,
          height: 20,
          x: 10,
          y: 20,
          toJSON: () => ({})
        }) as DOMRect
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  }

  const annotateTrigger = (): HTMLButtonElement | undefined =>
    document.querySelector<HTMLButtonElement>('[data-annotation-trigger]') ?? undefined

  const draftRanges = (): Range[] => Array.from(highlights.get('agent-annotation-draft') ?? [])

  it('highlights the selection only while the note editor is open', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(draftRanges()).toHaveLength(0)

    await act(async () => annotateTrigger()?.click())
    expect(draftRanges().map((range) => range.toString())).toContain('selectable agent reply')

    const editor = document.querySelector('[data-radix-popper-content-wrapper]')
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toContain('To Agent')
    expect(editor?.textContent).not.toContain('selectable agent reply')

    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())

    expect(draftRanges()).toHaveLength(0)
  })

  it('reveals the quoted text when the composer card requests it', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={onAdd}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())
    const added = onAdd.mock.calls[0]?.[0] as TextAnnotation

    await act(async () => requestAnnotationReveal(added))

    const revealed = Array.from(highlights.get('agent-annotation-reveal') ?? [])
    expect(revealed.map((range) => range.toString())).toContain('selectable agent reply')
    expect(scrollIntoView).toHaveBeenCalled()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('creates and restores an annotation for its Session item source', async () => {
    const source = {
      kind: 'session-item' as const,
      sessionId: 'session-1',
      itemId: 'activity-1',
      itemType: 'tool-activity' as const,
      sectionId: 'output'
    }
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    const renderWith = async (activeAnnotations: readonly TextAnnotation[]): Promise<void> => {
      await act(async () =>
        root.render(
          <TextAnnotationSurface
            source={source}
            activeAnnotations={activeAnnotations}
            onAdd={onAdd}
            onError={vi.fn()}
          >
            <p>selectable Session output</p>
          </TextAnnotationSurface>
        )
      )
    }

    await renderWith([])
    await commitSelection(container.querySelector('p')!)
    await act(async () => annotateTrigger()?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())

    const added = onAdd.mock.calls[0]?.[0]
    expect(added?.source).toEqual(source)

    await renderWith(added ? [added] : [])
    expect(draftRanges().map((range) => range.toString())).toContain('selectable Session output')
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
  })

  it('clears the native selection when the editor is dismissed by escape', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    // A keyboard-triggered editor keeps the native selection alive; closing
    // the editor must withdraw it, not only the pending highlight.
    expect(window.getSelection()?.rangeCount).toBeGreaterThan(0)

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector('textarea')).toBeNull()
    expect(window.getSelection()?.rangeCount).toBe(0)
    expect(draftRanges()).toHaveLength(0)
  })

  it('clears the native selection when clicking outside the open editor', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    expect(window.getSelection()?.rangeCount).toBeGreaterThan(0)

    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })

    expect(document.querySelector('textarea')).toBeNull()
    expect(window.getSelection()?.rangeCount).toBe(0)
    expect(draftRanges()).toHaveLength(0)
  })

  it('clears the highlight when the annotation is removed from the draft', async () => {
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    const renderWith = async (active: readonly TextAnnotation[]): Promise<void> => {
      await act(async () =>
        root.render(
          <TextAnnotationSurface
            source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
            activeAnnotations={active}
            onAdd={onAdd}
            onError={vi.fn()}
          >
            <p>selectable agent reply</p>
          </TextAnnotationSurface>
        )
      )
    }
    await renderWith([])
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())
    expect(draftRanges()).toHaveLength(1)

    // The composer drops the annotation (card removed) — the highlight on the
    // message must withdraw with it.
    await renderWith([])
    expect(draftRanges()).toHaveLength(0)
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()
  })

  it('hands the pending highlight over to the confirmed annotation', async () => {
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={onAdd}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const pending = draftRanges()[0]

    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())

    expect(onAdd).toHaveBeenCalledTimes(1)
    const added = onAdd.mock.calls[0]?.[0]
    expect(added?.quote).toBe('selectable agent reply')
    expect(draftRanges()).toEqual([pending])
    expect(draftRanges()[0]?.toString()).toBe('selectable agent reply')

    // The pending range keeps its highlight across later annotation syncs.
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[added]}
          onAdd={onAdd}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    expect(draftRanges()).toEqual([pending])
  })
})

describe('TextAnnotationSurface annotate trigger', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.getSelection()?.removeAllRanges()
  })

  const renderSurface = async (): Promise<HTMLParagraphElement> => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    return container.querySelector('p')!
  }

  const annotateTrigger = (): HTMLButtonElement | undefined =>
    document.querySelector<HTMLButtonElement>('[data-annotation-trigger]') ?? undefined

  const commitSelection = async (target: HTMLElement): Promise<void> => {
    const range = document.createRange()
    range.selectNodeContents(target.firstChild!)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 10,
          right: 120,
          top: 20,
          bottom: 40,
          width: 110,
          height: 20,
          x: 10,
          y: 20,
          toJSON: () => ({})
        }) as DOMRect
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  }

  it('keeps the trigger alive when clicking it collapses the browser selection', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    const trigger = annotateTrigger()
    expect(trigger).toBeDefined()

    // A real browser collapses the selection on mousedown before the click
    // lands, and the button's mouseup bubbles back into the surface.
    window.getSelection()?.removeAllRanges()
    await act(async () => trigger!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const surviving = annotateTrigger()
    expect(surviving).toBe(trigger)

    await act(async () => surviving?.click())
    expect(document.querySelector('textarea')).not.toBeNull()
  })

  it('keeps the note editor open while typing a note', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    const editor = document.querySelector<HTMLTextAreaElement>('textarea')
    expect(editor).not.toBeNull()

    await act(async () => {
      editor!.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'first character')
      editor!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const survivingEditor = document.querySelector<HTMLTextAreaElement>('textarea')
    expect(survivingEditor).toBe(editor)
    expect(survivingEditor?.value).toBe('first character')
  })

  it('clears the draft trigger when clicking anywhere outside it', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()

    // Clicking elsewhere collapses the selection in a real browser; the
    // leftover trigger must not linger over the text.
    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })

    expect(annotateTrigger()).toBeUndefined()
  })

  it('hides the trigger while the note editor is open and restores it after escape', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())

    expect(annotateTrigger()).toBeUndefined()
    expect(document.querySelector('textarea')).not.toBeNull()

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(annotateTrigger()).toBeDefined()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('does not reopen the note editor for a fresh selection after the draft was cleared', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    await act(async () => annotateTrigger()?.click())
    expect(document.querySelector('textarea')).not.toBeNull()

    // The draft is cleared from outside while the editor was open; a stale
    // open state must not resurrect the editor with the next selection.
    await act(async () => {
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      outside.remove()
    })
    expect(annotateTrigger()).toBeUndefined()
    expect(document.querySelector('textarea')).toBeNull()

    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('hides the trigger when a nested containing block is removed', async () => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <div>
            <p>
              <span>selectable agent reply</span>
            </p>
          </div>
        </TextAnnotationSurface>
      )
    )
    const span = container.querySelector('span')!
    await commitSelection(span)
    expect(annotateTrigger()).toBeDefined()

    await act(async () => {
      container.querySelector('p')?.remove()
    })
    expect(annotateTrigger()).toBeUndefined()
  })

  it('hides the trigger when selected character data is replaced in place', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()

    await act(async () => {
      if (paragraph.firstChild) paragraph.firstChild.textContent = 'stream replaced the quote'
    })
    expect(annotateTrigger()).toBeUndefined()
  })

  it('keeps retargeting the draft selection while the surface is animating', async () => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
          isAnimating={true}
        >
          <p>selectable agent reply</p>
        </TextAnnotationSurface>
      )
    )
    const paragraph = container.querySelector('p')!
    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()

    // The highlight reconcile is deferred during streaming, but a manual
    // selection must still follow (or drop with) the mutating text.
    await act(async () => {
      if (paragraph.firstChild) paragraph.firstChild.textContent = 'stream replaced the quote'
    })
    expect(annotateTrigger()).toBeUndefined()
  })

  it('hides the trigger as soon as the selected content is removed', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()

    await act(async () => {
      paragraph.remove()
    })
    expect(annotateTrigger()).toBeUndefined()
  })

  it('keeps the trigger after syntax highlighting retargets the selected code', async () => {
    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{
            kind: 'session-item',
            sessionId: 'session-1',
            itemId: 'tool-1',
            itemType: 'tool-activity',
            sectionId: 'code'
          }}
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <WorkspaceToolCodeBlock code="const answer = 42" language="typescript" />
        </TextAnnotationSurface>
      )
    )
    const code = container.querySelector<HTMLElement>('[data-testid="tool-code-block"] code')!
    await commitSelection(code)
    expect(annotateTrigger()).toBeDefined()

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="tool-code-block"] code span').length
      ).toBeGreaterThan(0)
    })
    await act(async () => Promise.resolve())
    expect(annotateTrigger()).toBeDefined()
  })

  it('keeps a duplicate quote on the selected occurrence after highlight replacement', async () => {
    const highlights = installCssHighlightsMock()
    const onAdd = vi.fn<(annotation: TextAnnotation) => undefined>(() => undefined)
    try {
      await act(async () =>
        root.render(
          <TextAnnotationSurface
            source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
            activeAnnotations={[]}
            onAdd={onAdd}
            onError={vi.fn()}
          >
            <p>repeat then repeat</p>
          </TextAnnotationSurface>
        )
      )
      const paragraph = container.querySelector('p')!
      const range = document.createRange()
      range.setStart(paragraph.firstChild!, 12)
      range.setEnd(paragraph.firstChild!, 18)
      Object.defineProperty(range, 'getBoundingClientRect', {
        configurable: true,
        value: () =>
          ({
            left: 10,
            right: 120,
            top: 20,
            bottom: 40,
            width: 110,
            height: 20,
            x: 10,
            y: 20,
            toJSON: () => ({})
          }) as DOMRect
      })
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
      expect(annotateTrigger()).toBeDefined()

      await act(async () => {
        paragraph.replaceChildren()
        for (const part of ['repeat', ' then ', 'repeat']) {
          const token = document.createElement('span')
          token.textContent = part
          paragraph.appendChild(token)
        }
      })
      expect(annotateTrigger()).toBeDefined()

      await act(async () => annotateTrigger()?.click())
      const draftRange = Array.from(highlights.get('agent-annotation-draft') ?? [])[0]
      expect(draftRange?.toString()).toBe('repeat')
      expect(draftRange?.startContainer).toBe(paragraph.lastChild?.firstChild)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('hides the trigger when streaming replaces the selected message content', async () => {
    const paragraph = await renderSurface()
    await commitSelection(paragraph)
    expect(annotateTrigger()).toBeDefined()

    await act(async () =>
      root.render(
        <TextAnnotationSurface
          source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
          activeAnnotations={[]}
          onAdd={vi.fn()}
          onError={vi.fn()}
        >
          <p>stream replaced the quote</p>
        </TextAnnotationSurface>
      )
    )
    expect(annotateTrigger()).toBeUndefined()
  })

  it('hides the trigger when the selection scrolls outside its clipping container', async () => {
    await act(async () =>
      root.render(
        <div data-testid="annotation-scroll-viewport" style={{ maxHeight: 100, overflow: 'auto' }}>
          <TextAnnotationSurface
            source={{ kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }}
            activeAnnotations={[]}
            onAdd={vi.fn()}
            onError={vi.fn()}
          >
            <p>selectable agent reply</p>
          </TextAnnotationSurface>
        </div>
      )
    )
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="annotation-scroll-viewport"]'
    )!
    const paragraph = container.querySelector('p')!
    const rect = (top: number, bottom: number): DOMRect =>
      ({
        left: 10,
        right: 120,
        top,
        bottom,
        width: 110,
        height: bottom - top,
        x: 10,
        y: top,
        toJSON: () => ({})
      }) as DOMRect
    Object.defineProperty(viewport, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 100)
    })

    let selectionRect = rect(20, 40)
    const originalRangeRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      'getBoundingClientRect'
    )
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => selectionRect
    })

    try {
      const range = document.createRange()
      range.selectNodeContents(paragraph.firstChild!)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
      expect(annotateTrigger()).toBeDefined()

      selectionRect = rect(120, 140)
      await act(async () => viewport.dispatchEvent(new Event('scroll')))
      expect(annotateTrigger()).toBeUndefined()

      selectionRect = rect(20, 40)
      await act(async () => viewport.dispatchEvent(new Event('scroll')))
      expect(annotateTrigger()).toBeDefined()
    } finally {
      if (originalRangeRect) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect)
      } else {
        delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
      }
    }
  })

  it('places the trigger beside the last line of a multi-line selection', async () => {
    const paragraph = await renderSurface()
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    const lineRect = (left: number, top: number, right: number, bottom: number): DOMRect =>
      ({
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({})
      }) as DOMRect
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () => [lineRect(100, 20, 300, 40), lineRect(100, 50, 120, 70)]
    })
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => lineRect(100, 20, 300, 70)
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const trigger = annotateTrigger()
    // The trigger follows the selection's visible end (last line) and lives
    // in the document portal, outside any clipping message ancestor.
    expect(trigger?.className).toContain('fixed')
    expect(trigger?.className).toContain('z-[100]')
    expect(trigger?.className).toContain('rounded-md')
    expect(trigger?.className).not.toContain('rounded-full')
    expect(trigger?.className).toContain('text-[11px]')
    expect(trigger?.querySelector('svg')?.classList.contains('size-3')).toBe(true)
    expect(trigger?.parentElement).toBe(document.body)
  })
})
