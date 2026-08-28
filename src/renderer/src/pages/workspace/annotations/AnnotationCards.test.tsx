// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Annotation, AnnotationValidationError } from '../../../../../shared/annotations'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { AnnotationDraftCards, AnnotationMessageCards } from './AnnotationCards'
import { requestAnnotationReveal } from './annotation-reveal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const annotations: Annotation[] = [
  {
    id: 'quote-1',
    kind: 'text',
    target: 'agent',
    quote: 'Compare this sentence.',
    source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
  },
  {
    id: 'point-1',
    kind: 'image-point',
    target: 'agent',
    note: 'Inspect the peak.',
    source: {
      kind: 'artifact-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'figure.png',
      path: 'artifact-version:project-1/session-1/artifact-1/version-1',
      mimeType: 'image/png'
    },
    point: { x: 0.5, y: 0.25 },
    naturalSize: { width: 1000, height: 400 }
  }
]

describe('AnnotationCards image projection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps mixed annotation image numbering and pixels on sent cards', async () => {
    await act(async () => root.render(<AnnotationMessageCards annotations={annotations} />))
    expect(container.textContent).toContain('Text quote')
    expect(container.textContent).toContain('Image point 1')
    expect(container.textContent).toContain('Point 1 at 500, 100')
    expect(container.textContent).toContain('Inspect the peak.')
  })

  it('omits the source line from draft chips', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )
    // The chip sits next to the message it annotates and the quote preview
    // jumps back to the source text, so a source line only adds noise.
    expect(container.textContent).not.toContain('Source:')
    expect(
      container
        .querySelector('[data-annotation-hover-label]')
        ?.getAttribute('data-annotation-hover-label')
    ).toContain('Agent Message')
  })

  it('shows readable Session source types without exposing source machine values', async () => {
    const sourceTypes = [
      ['tool-activity', 'Tool activity'],
      ['plan', 'Execution plan'],
      ['elicitation', 'Question'],
      ['delegated-elicitation', 'Delegated question'],
      ['subagent-message', 'Subagent message']
    ] as const
    const sessionAnnotations: Annotation[] = sourceTypes.map(([itemType], index) => ({
      id: `session-quote-${index}`,
      kind: 'text',
      target: 'agent',
      quote: `Quoted evidence ${index + 1}`,
      source: {
        kind: 'session-item',
        sessionId: 'session-1',
        itemId: `machine-item-${index + 1}`,
        itemType,
        sectionId: `machine-section-${index + 1}`
      }
    }))

    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={sessionAnnotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const hoverLabels = Array.from(
      container.querySelectorAll<HTMLElement>('[data-annotation-hover-label]')
    ).map((chip) => chip.dataset.annotationHoverLabel)
    expect(hoverLabels).toEqual(
      sourceTypes.map(([, label], index) => `Quoted evidence ${index + 1} - ${label}`)
    )
    expect(hoverLabels.join(' ')).not.toMatch(
      /tool-activity|delegated-elicitation|subagent-message|machine-(?:item|section)/u
    )
  })

  it('compresses the draft quote preview to a single line', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={[
            {
              id: 'long-quote',
              kind: 'text',
              target: 'agent',
              quote:
                'A very long quoted passage that would wrap across multiple lines when the card still showed the full text.',
              source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
            }
          ]}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const quoteLine = container.querySelector('[data-annotation-quote]')
    expect(quoteLine?.textContent).toContain('A very long quoted passage')
    expect(quoteLine?.querySelector('span')?.className).toContain('truncate')
  })

  it('reveals the quoted text when the quote preview is clicked', async () => {
    const onReveal = vi.fn()
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
          onReveal={onReveal}
        />
      )
    )

    const quoteButtons = container.querySelectorAll<HTMLButtonElement>(
      'button[data-annotation-quote]'
    )
    expect(quoteButtons).toHaveLength(2)

    await act(async () => quoteButtons[0]?.click())
    expect(onReveal).toHaveBeenCalledWith(annotations[0])

    await act(async () => quoteButtons[1]?.click())
    expect(onReveal).toHaveBeenCalledWith(annotations[1])
  })

  it('uses compact wrapping chips with persistent edit/delete actions and truncated hover copy', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const section = container.querySelector('section')
    expect(section?.className).toContain('flex-wrap')
    const chips = container.querySelectorAll('[data-annotation-draft-chip]')
    expect(chips).toHaveLength(2)
    expect(chips[0]?.className).toContain('max-w-[13rem]')
    expect(container.querySelectorAll('[aria-label="Edit annotation note"]')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label="Remove annotation"]')).toHaveLength(2)
    const hoverLabel = chips[0]?.getAttribute('data-annotation-hover-label')
    expect(hoverLabel).toContain('Compare this sentence. - Agent Message')
  })

  it('edits in a portalled popover without expanding the chip layout', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const section = container.querySelector('section')
    const chip = container.querySelector<HTMLElement>('[data-annotation-draft-chip]')
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit annotation note"]')
    await act(async () => edit?.click())

    const editor = document.body.querySelector<HTMLElement>('[data-annotation-note-editor]')
    const textarea = editor?.querySelector('textarea')
    expect(editor).not.toBeNull()
    expect(textarea).not.toBeNull()
    expect(container.contains(editor)).toBe(false)
    expect(chip?.contains(editor ?? null)).toBe(false)
    expect(section?.className).toContain('flex-wrap')
    expect(chip?.className).toContain('h-7')
    expect(chip?.className).toContain('max-w-[13rem]')
    expect(chip?.className).not.toContain('basis-full')
    expect(chip?.className).not.toContain('max-w-none')
  })

  it('returns focus after cancel, Escape, and outside dismissal', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit annotation note"]')!
    const open = async (): Promise<HTMLElement> => {
      await act(async () => edit.click())
      const editor = document.body.querySelector<HTMLElement>('[data-annotation-note-editor]')
      if (!editor) throw new Error('annotation note editor not found')
      return editor
    }

    let editor = await open()
    const cancel = Array.from(editor.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => {
      cancel?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.querySelector('[data-annotation-note-editor]')).toBeNull()
    expect(document.activeElement).toBe(edit)

    editor = await open()
    await act(async () => {
      editor
        .querySelector('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.querySelector('[data-annotation-note-editor]')).toBeNull()
    expect(document.activeElement).toBe(edit)

    await open()
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.body.querySelector('[data-annotation-note-editor]')).toBeNull()
    expect(document.activeElement).toBe(edit)
  })

  it('closes after a successful save and stays open after a validation error', async () => {
    const onUpdateNote = vi.fn<(id: string, note: string) => AnnotationValidationError | undefined>(
      () => undefined
    )
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={onUpdateNote}
          onRemove={vi.fn()}
        />
      )
    )

    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit annotation note"]')!
    await act(async () => edit.click())
    let editor = document.body.querySelector<HTMLElement>('[data-annotation-note-editor]')!
    let textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Updated note'
      )
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    const save = (): HTMLButtonElement =>
      Array.from(editor.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Save'
      )!
    await act(async () => {
      save().click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(onUpdateNote).toHaveBeenCalledWith('quote-1', 'Updated note')
    expect(document.body.querySelector('[data-annotation-note-editor]')).toBeNull()
    expect(document.activeElement).toBe(edit)

    onUpdateNote.mockReturnValue('note-too-long')
    await act(async () => edit.click())
    editor = document.body.querySelector<HTMLElement>('[data-annotation-note-editor]')!
    textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Rejected note'
      )
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }))
      save().click()
    })
    expect(onUpdateNote).toHaveBeenLastCalledWith('quote-1', 'Rejected note')
    expect(document.body.querySelector('[data-annotation-note-editor]')).not.toBeNull()
  })

  it('shows the annotation note as the chip label and falls back to its quote', async () => {
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={[
            { ...annotations[0]!, note: 'Prefer this annotation label' },
            { ...annotations[0]!, id: 'quote-fallback' }
          ]}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
        />
      )
    )

    const labels = Array.from(container.querySelectorAll('[data-annotation-quote] > span')).map(
      (label) => label.textContent
    )
    expect(labels).toEqual(['Prefer this annotation label', 'Compare this sentence.'])
  })

  it('activates an existing file preview before revealing its image pin', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    usePreviewWorkbenchStore.getState().upsertItem({
      id: 'figure-preview',
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'figure.png',
      type: 'file',
      path: 'artifact-version:project-1/session-1/artifact-1/version-1',
      format: 'image',
      name: 'figure.png',
      mimeType: 'image/png',
      selectedVersionId: 'version-1'
    })
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={annotations}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
          onReveal={requestAnnotationReveal}
        />
      )
    )

    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>('[data-annotation-quote]')[1]?.click()
    )
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'figure-preview',
      panelState: 'open'
    })
  })

  it('reopens a closed source as a preview tab before revealing it', async () => {
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    await act(async () =>
      root.render(
        <AnnotationDraftCards
          annotations={[annotations[1]!]}
          disabled={false}
          onUpdateNote={vi.fn()}
          onRemove={vi.fn()}
          onReveal={requestAnnotationReveal}
        />
      )
    )

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-annotation-quote]')?.click()
    )
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      type: 'file',
      name: 'figure.png',
      selectedVersionId: 'version-1',
      format: 'image'
    })
  })
})
