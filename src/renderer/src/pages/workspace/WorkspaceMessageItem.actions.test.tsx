// @vitest-environment jsdom
// Pins the user-bubble hover actions and the inline edit flow: copy writes the prompt to the
// clipboard, edit swaps the bubble for a multi-line editor, and confirming resends the prompt —
// with a warning first when several later turns would be deleted.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import type { SendEditedMessage } from './workspace-edited-message'
import type { EditAnnotationTarget } from './WorkspaceMessageItem'
import type { Annotation, TextAnnotation } from '../../../../shared/annotations'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'

const { requestPdfReadingReveal } = vi.hoisted(() => ({ requestPdfReadingReveal: vi.fn() }))
vi.mock('./pdf-reading-reveal', () => ({ requestPdfReadingReveal }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Keep the transcript row and markdown surface as thin wrappers so the test never loads Shiki.
vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({
    children,
    disableContainment
  }: PropsWithChildren<{ disableContainment?: boolean }>): JSX.Element => (
    <div data-disable-containment={disableContainment || undefined}>{children}</div>
  )
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

// Artifact rendering is outside this test's boundary and imports the PDF worker bundle.
vi.mock('./artifact-preview', () => ({
  ArtifactPreview: () => <div data-testid="artifact-preview" />
}))

let container: HTMLDivElement
let root: Root
let notifyResize: (() => void) | undefined

const originalResizeObserver = globalThis.ResizeObserver

const writeText = vi.fn().mockResolvedValue(undefined)

const createMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt text',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const noop = (): void => {}

const renderItem = async (
  message: ChatMessage,
  options: {
    canEditMessage?: boolean
    showUserActions?: boolean
    onSendEditedMessage?: SendEditedMessage
    onEditAnnotationTargetChange?: (
      messageId: string,
      target: EditAnnotationTarget | undefined
    ) => void
    canBranchInNewSession?: boolean
    onBranchInNewSession?: (messageId: string) => void
    subsequentTurns?: number
    revisionNavigation?: {
      index: number
      total: number
      onPrevious?: () => void
      onNext?: () => void
    }
    reviewerCorrectionActive?: boolean
    activeTextAnnotations?: TextAnnotation[]
    onAddTextAnnotation?: (annotation: TextAnnotation) => undefined
  } = {}
): Promise<void> => {
  await act(async () => {
    root.render(
      <WorkspaceMessageItem
        message={message}
        projectId="project-1"
        onPreviewArtifact={noop}
        onPreviewUploadAttachment={noop}
        onOpenSkillMention={noop}
        onPreviewMentionArtifact={noop}
        canEditMessage={options.canEditMessage ?? false}
        showUserActions={options.showUserActions}
        onSendEditedMessage={options.onSendEditedMessage}
        onEditAnnotationTargetChange={options.onEditAnnotationTargetChange}
        canBranchInNewSession={options.canBranchInNewSession}
        onBranchInNewSession={options.onBranchInNewSession}
        subsequentTurns={options.subsequentTurns ?? 0}
        revisionNavigation={options.revisionNavigation}
        reviewerCorrectionActive={options.reviewerCorrectionActive}
        annotationPort={
          options.onAddTextAnnotation
            ? {
                sessionId: 'session-1',
                activeAnnotations: options.activeTextAnnotations ?? [],
                onAdd: options.onAddTextAnnotation,
                onError: noop
              }
            : undefined
        }
      />
    )
  })
}

const getButton = (label: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!button) throw new Error(`button "${label}" not found`)
  return button
}

const getEditor = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[role="textbox"][aria-label="Edit message"]')

// The editor card's Send/Cancel buttons are plain text buttons inside the item container.
const getEditorCardButton = (label: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  if (!button) throw new Error(`button "${label}" not found`)
  return button as HTMLButtonElement
}

// The confirmation dialog renders in a body-level portal, outside the item container.
const getDialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]')

const getDialogButton = (label: string): HTMLButtonElement => {
  const dialog = getDialog()
  const button = dialog
    ? Array.from(dialog.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label
      )
    : undefined
  if (!button) throw new Error(`dialog button "${label}" not found`)
  return button as HTMLButtonElement
}

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const expectComputeCompletionEvent = (): void => {
  expect(container.querySelector('[data-testid="compute-job-completion-event"]')).not.toBeNull()
  expect(container.textContent).toContain('Remote job completed')
  expect(container.textContent).toContain('Analysis started automatically')
  expect(container.textContent).not.toContain('A remote job has finished')
  expect(container.querySelector('[data-slot="user-message-bubble"]')).toBeNull()
  expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
}

// Replaces the inline editor's text and lets the editor emit the updated doc, mimicking a typing pass.
const typeIntoEditor = async (editor: HTMLElement, text: string): Promise<void> => {
  await act(async () => {
    editor.textContent = text
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
}

const typeMentionIntoEditor = async (editor: HTMLElement): Promise<void> => {
  await act(async () => {
    const mention = document.createTextNode('@')
    editor.replaceChildren(mention)
    const range = document.createRange()
    range.setStart(mention, 1)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      notifyResize = () => this.callback([], this as unknown as ResizeObserver)
    }
    disconnect(): void {
      notifyResize = undefined
    }
    unobserve(): void {
      notifyResize = undefined
    }
  }
  writeText.mockClear()
  requestPdfReadingReveal.mockClear()
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
  Range.prototype.getBoundingClientRect = () => new DOMRect(10, 20, 110, 20)
  ;(window as unknown as { api: unknown }).api = {
    projectFiles: {
      listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 })
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  notifyResize = undefined
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver
  else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
})

describe('WorkspaceMessageItem user message actions', () => {
  it('shows a passive current-page Reading marker and reopens the captured page', async () => {
    const binding = {
      version: 1 as const,
      bindingId: 'binding-1',
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'session-1',
      name: 'paper.pdf',
      mimeType: 'application/pdf' as const,
      sizeBytes: 1024,
      checksum: 'checksum-1',
      linkedAt: 1710000000000
    }
    const pdfContext = {
      version: 1 as const,
      bindings: [binding],
      activeBindingId: binding.bindingId,
      readingPosition: { pageNumber: 7, pageCount: 14 }
    }

    await renderItem(createMessage({ content: '解释这一页', pdfContext }))
    const marker = getButton('Reading · Page 7')
    expect(marker.title).toBe('paper.pdf')
    await click(marker)
    expect(requestPdfReadingReveal).toHaveBeenCalledWith('project-1', binding, 7)

    await renderItem(createMessage({ content: '全文总结一下', pdfContext }))
    expect(container.querySelector('[data-slot="message-pdf-reading-context"]')).toBeNull()

    await renderItem(createMessage({ content: 'CRAG 的优势是什么？', pdfContext }))
    expect(container.querySelector('[data-slot="message-pdf-reading-context"]')).toBeNull()
  })

  it('creates a text annotation only after the two-step confirmation', async () => {
    const onAddTextAnnotation = vi.fn(() => undefined)
    await renderItem(createMessage({ role: 'agent', content: 'Quoted Agent evidence' }), {
      onAddTextAnnotation
    })
    const annotationSurface = container.querySelector('[data-annotation-surface="true"]')
    const text = Array.from(annotationSurface?.querySelectorAll('div') ?? []).find(
      (element) =>
        element.textContent === 'Quoted Agent evidence' && element.childNodes.length === 1
    )?.firstChild
    if (!text) throw new Error('Agent response text not found')
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    await act(async () => {
      annotationSurface?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(onAddTextAnnotation).not.toHaveBeenCalled()
    const annotateEntry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Annotate'
    )
    if (!annotateEntry) throw new Error('Annotate entry not found')
    await click(annotateEntry)

    const note = document.querySelector<HTMLTextAreaElement>(
      '[placeholder="Add context for the Agent"]'
    )
    if (!note) throw new Error('Annotation note not found')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(note, 'Explain this evidence.')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = Array.from(document.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    if (!confirm) throw new Error('Annotate confirmation not found')
    await click(confirm)

    expect(onAddTextAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'text',
        target: 'agent',
        quote: 'Quoted Agent evidence',
        note: 'Explain this evidence.',
        source: {
          kind: 'agent-message',
          sessionId: 'session-1',
          messageId: 'message-1'
        }
      })
    )
  })

  it('renders sent annotations as read-only evidence cards', async () => {
    await renderItem(
      createMessage({
        content: '',
        annotations: [
          {
            id: 'annotation-1',
            kind: 'text',
            target: 'agent',
            quote: 'Quoted evidence',
            note: 'A note',
            source: {
              kind: 'agent-message',
              sessionId: 'session-1',
              messageId: 'agent-message-1'
            }
          }
        ]
      })
    )

    expect(container.textContent).toContain('Quoted evidence')
    expect(container.textContent).toContain('A note')
    expect(container.querySelector('[aria-label="Sent annotations"]')).not.toBeNull()
  })

  it('hydrates mixed sent annotations into the inline editor without losing fixed source data', async () => {
    const annotations: Annotation[] = [
      {
        id: 'quote-1',
        kind: 'text',
        target: 'agent',
        quote: 'Quoted evidence',
        note: 'Original note',
        source: {
          kind: 'project-file',
          projectId: 'project-1',
          path: 'results/report.md',
          name: 'report.md',
          versionId: 'text-version-1',
          sessionId: 'session-1'
        }
      },
      {
        id: 'point-1',
        kind: 'image-point',
        target: 'agent',
        note: 'Inspect this peak.',
        source: {
          kind: 'artifact-version',
          projectId: 'project-1',
          sessionId: 'session-1',
          versionId: 'image-version-7',
          name: 'figure.png',
          path: 'artifact-version:project-1/session-1/artifact-1/image-version-7',
          mimeType: 'image/png'
        },
        point: { x: 0.375, y: 0.25 },
        naturalSize: { width: 1600, height: 800 }
      }
    ]
    const message = createMessage({ content: '', annotations })
    const onSendEditedMessage = vi
      .fn()
      .mockResolvedValue({ ok: true, disposition: 'sent' } as const)
    await renderItem(message, { canEditMessage: true, onSendEditedMessage })

    await click(getButton('Edit message'))
    const draftAnnotations = container.querySelector('[aria-label="Annotations for Agent"]')
    expect(draftAnnotations).not.toBeNull()
    expect(
      Array.from(draftAnnotations?.querySelectorAll('[data-annotation-quote] > span') ?? []).map(
        (label) => label.textContent
      )
    ).toEqual(['Original note', 'Inspect this peak.'])
    expect(draftAnnotations?.querySelectorAll('[data-annotation-draft-chip]')).toHaveLength(2)

    await click(getEditorCardButton('Send'))

    expect(onSendEditedMessage).toHaveBeenCalledWith('message-1', { nodes: [] }, annotations)
    expect(message.annotations).toEqual(annotations)
    expect(getEditor()).toBeNull()
  })

  it('keeps a failed annotation resend editable after local note and removal changes', async () => {
    const annotations: Annotation[] = [
      {
        id: 'quote-1',
        kind: 'text',
        target: 'agent',
        quote: 'First quote',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'agent-1' }
      },
      {
        id: 'quote-2',
        kind: 'text',
        target: 'agent',
        quote: 'Second quote',
        note: 'Keep me',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'agent-2' }
      }
    ]
    const onSendEditedMessage = vi.fn().mockResolvedValue({ ok: false } as const)
    await renderItem(createMessage({ annotations }), {
      canEditMessage: true,
      onSendEditedMessage
    })
    await click(getButton('Edit message'))

    await click(getButton('Edit annotation note'))
    const note = document.body.querySelector<HTMLTextAreaElement>(
      '[data-annotation-note-editor] #edit-annotation-quote-1'
    )
    if (!note) throw new Error('annotation note editor not found')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        note,
        'Updated note'
      )
      note.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    const saveNote = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-annotation-note-editor] button')
    ).find((button) => button.textContent === 'Save')
    if (!saveNote) throw new Error('annotation note save button not found')
    await click(saveNote)
    const removeButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Remove annotation"]'
    )
    await click(removeButtons[1])
    await click(getEditorCardButton('Send'))

    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'message-1',
      { nodes: [{ type: 'text', text: 'Prompt text' }] },
      [{ ...annotations[0], note: 'Updated note' }]
    )
    expect(getEditor()).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try again')
  })

  it('mixes a newly selected annotation into the active inline revision', async () => {
    let target: EditAnnotationTarget | undefined
    const onSendEditedMessage = vi.fn(() => ({ ok: true, disposition: 'sent' as const }))
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      onEditAnnotationTargetChange: (_messageId, next) => {
        target = next
      }
    })
    await click(getButton('Edit message'))
    const annotation: TextAnnotation = {
      id: 'new-quote',
      kind: 'text',
      target: 'agent',
      quote: 'New evidence',
      source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'agent-1' }
    }

    act(() => {
      target?.add(annotation)
    })
    expect(container.textContent).toContain('New evidence')
    await click(getEditorCardButton('Send'))

    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'message-1',
      { nodes: [{ type: 'text', text: 'Prompt text' }] },
      [annotation]
    )
  })

  it('moves focus into the inline editor and restores it to Edit on cancel', async () => {
    await renderItem(createMessage(), { canEditMessage: true })
    const editButton = getButton('Edit message')

    await click(editButton)
    expect(document.activeElement).toBe(getEditor())
    await click(getEditorCardButton('Cancel'))

    expect(document.activeElement).toBe(getButton('Edit message'))
  })

  it('groups Copy tightly before Branch in a completed Agent Message footer', async () => {
    const onBranchInNewSession = vi.fn()
    await renderItem(
      createMessage({
        id: 'agent-message',
        role: 'agent',
        content: 'Completed analysis',
        completedAt: 1710000001000
      }),
      { canBranchInNewSession: true, onBranchInNewSession }
    )

    const footer = container.querySelector('[data-slot="assistant-message-footer"]')
    const actionGroup = footer?.querySelector('[data-slot="assistant-message-actions"]')
    const copyButton = getButton('Copy message')
    const branchButton = getButton('Branch in new session')
    const completedTime = footer?.querySelector('time')
    if (!footer || !actionGroup || !completedTime) {
      throw new Error('completed Agent Message footer not found')
    }

    expect(actionGroup.classList.contains('gap-0.5')).toBe(true)
    expect(actionGroup.contains(copyButton)).toBe(true)
    expect(actionGroup.contains(branchButton)).toBe(true)
    expect(
      copyButton.compareDocumentPosition(branchButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(
      branchButton.compareDocumentPosition(completedTime) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    await click(copyButton)
    expect(writeText).toHaveBeenCalledWith('Completed analysis')
    await click(branchButton)
    expect(onBranchInNewSession).toHaveBeenCalledWith('agent-message')
  })

  it('keeps the completed Agent Message branch action visible but disabled when unavailable', async () => {
    const onBranchInNewSession = vi.fn()
    await renderItem(
      createMessage({ role: 'agent', content: 'Completed analysis', completedAt: 1710000001000 }),
      { canBranchInNewSession: false, onBranchInNewSession }
    )

    const branchButton = getButton('Branch in new session')
    expect(branchButton.disabled).toBe(true)
    await click(branchButton)
    expect(onBranchInNewSession).not.toHaveBeenCalled()
  })

  it('presents a settled Reviewer Correction as a compact content-free status row', async () => {
    await renderItem(
      createMessage({
        content: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      }),
      {
        canEditMessage: true,
        revisionNavigation: { index: 0, total: 2, onNext: noop }
      }
    )

    expect(container.querySelector('[data-testid="reviewer-correction-message"]')).not.toBeNull()
    expect(container.textContent).toContain('Corrections requested')
    expect(container.textContent).toContain('Handed off to the Agent · response started')
    expect(container.textContent).not.toContain('[Auditor] Correct the unsupported claim.')
    expect(container.querySelector('[data-slot="user-message-bubble"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Message revision"]')).toBeNull()
    expect(container.querySelector('[aria-label="Copy correction"]')).toBeNull()
    expect(container.querySelector('details')).toBeNull()
    expect(
      container.querySelector('[data-testid="reviewer-correction-settled-icon"]')
    ).not.toBeNull()
  })

  it('shows the active correction lifecycle without mounting the correction body', async () => {
    await renderItem(
      createMessage({
        content: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      }),
      { reviewerCorrectionActive: true }
    )

    expect(container.textContent).toContain('Reviewer requested corrections')
    expect(container.textContent).toContain('Agent is addressing the feedback')
    expect(container.textContent).not.toContain('Handed off to the Agent · response started')
    expect(container.textContent).not.toContain('[Auditor] Correct the unsupported claim.')
    const activeIcon = container.querySelector('[data-testid="reviewer-correction-active-icon"]')
    expect(activeIcon?.getAttribute('class')).toContain('animate-spin')
    expect(activeIcon?.getAttribute('class')).toContain('motion-reduce:animate-none')
  })

  it('keeps matching Auditor text human-authored when attribution is absent', async () => {
    await renderItem(createMessage({ content: '[Auditor] Correct the unsupported claim.' }), {
      canEditMessage: true
    })

    expect(container.querySelector('[data-slot="user-message-bubble"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).not.toBeNull()
  })

  it('presents a Compute completion prompt as an automatic system event instead of a user bubble', async () => {
    await renderItem(
      createMessage({
        content: 'A remote job has finished. Please analyze the results.',
        attribution: {
          kind: 'application',
          feature: 'compute',
          purpose: 'job-completion-analysis',
          deliveryKey: 'compute_done:session-1:job-1',
          jobIds: ['job-1']
        }
      }),
      { canEditMessage: true }
    )

    expectComputeCompletionEvent()
  })

  it('keeps a reloaded Compute completion presentation out of the user bubble', async () => {
    await renderItem(
      createMessage({
        content: 'A remote job has finished. Please analyze the results.',
        presentation: { kind: 'compute-job-completion' }
      }),
      { canEditMessage: true }
    )

    expectComputeCompletionEvent()
  })
  it('keeps the normal Session transcript gutter by default', async () => {
    await renderItem(createMessage())

    const transcriptRow = container.querySelector<HTMLElement>('[class~="pb-1"][class~="pt-5"]')
    expect(transcriptRow?.classList.contains('px-4')).toBe(true)
    expect(transcriptRow?.classList.contains('md:px-6')).toBe(true)
  })

  it('measures the user bubble against the full transcript width', async () => {
    await renderItem(createMessage())

    const bubbleRow = container.querySelector<HTMLElement>('[data-slot="user-bubble-row"]')
    expect(bubbleRow?.classList.contains('w-full')).toBe(true)
  })

  it('collapses user message content beyond twelve lines and expands it downward on demand', async () => {
    await renderItem(createMessage({ content: 'Long prompt line\n'.repeat(13) }))

    const content = container.querySelector<HTMLElement>('[data-slot="user-message-content"]')
    const measurement = container.querySelector<HTMLElement>(
      '[data-slot="user-message-measurement"]'
    )
    if (!content || !measurement) throw new Error('user message content not found')
    expect(measurement.textContent).toBe('')
    expect(measurement.dataset.content).toBe('Long prompt line\n'.repeat(13))
    measurement.style.lineHeight = '20px'
    Object.defineProperty(measurement, 'scrollHeight', { configurable: true, value: 260 })
    act(() => notifyResize?.())

    const showMore = getButton('Show more')
    const ellipsis = container.querySelector<HTMLElement>(
      '[data-slot="user-message-collapse-ellipsis"]'
    )
    expect(content.classList.contains('max-h-[12.5lh]')).toBe(true)
    expect(content.classList.contains('overflow-hidden')).toBe(true)
    expect(ellipsis?.textContent?.trim()).toBe('…')
    expect(ellipsis?.getAttribute('aria-hidden')).toBe('true')
    expect(showMore.classList.contains('mt-1')).toBe(true)
    expect(showMore.getAttribute('aria-expanded')).toBe('false')
    expect(showMore.getAttribute('aria-controls')).toBe(content.id)

    await click(showMore)

    expect(content.classList.contains('max-h-[12.5lh]')).toBe(false)
    expect(content.classList.contains('overflow-hidden')).toBe(false)
    expect(container.querySelector('[data-slot="user-message-collapse-ellipsis"]')).toBeNull()
    const showLess = getButton('Show less')
    expect(showLess.classList.contains('mt-2')).toBe(true)
    expect(showLess.getAttribute('aria-expanded')).toBe('true')

    await click(showLess)

    expect(content.classList.contains('max-h-[12.5lh]')).toBe(true)
    expect(container.querySelector('[data-slot="user-message-collapse-ellipsis"]')).not.toBeNull()
    expect(getButton('Show more').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps short user message content fully visible without an expand control', async () => {
    await renderItem(createMessage({ content: 'Short prompt' }))

    const content = container.querySelector<HTMLElement>('[data-slot="user-message-content"]')
    const measurement = container.querySelector<HTMLElement>(
      '[data-slot="user-message-measurement"]'
    )
    if (!content || !measurement) throw new Error('user message content not found')
    measurement.style.lineHeight = '20px'
    Object.defineProperty(measurement, 'scrollHeight', { configurable: true, value: 240 })
    act(() => notifyResize?.())

    expect(container.querySelector('[aria-label="Show more"]')).toBeNull()
    expect(content.classList.contains('max-h-[12.5lh]')).toBe(false)
  })

  it('remeasures structured content and uses a non-interactive summary while collapsed', async () => {
    const text = 'Structured prompt line\n'.repeat(13)
    const contentText = `${text}/forecast @evidence.csv`
    await renderItem(
      createMessage({
        content: contentText,
        parts: [
          { type: 'text', text },
          { type: 'skill', id: 'skill-forecast', name: 'forecast' },
          { type: 'text', text: ' ' },
          {
            type: 'artifact',
            id: 'artifact-1',
            name: 'evidence.csv',
            path: '/project/evidence.csv',
            source: 'artifact'
          }
        ],
        uploads: [
          {
            id: 'upload-1',
            sessionId: 'session-1',
            name: 'evidence.pdf',
            originalName: 'evidence.pdf',
            mimeType: 'application/pdf',
            size: 1024
          }
        ]
      })
    )

    const content = container.querySelector<HTMLElement>('[data-slot="user-message-content"]')
    const measurement = container.querySelector<HTMLElement>(
      '[data-slot="user-message-measurement"]'
    )
    const attachment = getButton('Preview uploaded attachment evidence.pdf')
    if (!content || !measurement) throw new Error('user message content not found')
    const measuredSkill = measurement.querySelector<HTMLElement>('[data-part-type="skill"]')
    const measuredArtifact = measurement.querySelector<HTMLElement>('[data-part-type="artifact"]')
    expect(measurement.textContent).toBe('')
    expect(measurement.dataset.content).toBeUndefined()
    expect(measuredSkill?.dataset.content).toBe('/forecast')
    expect(measuredSkill?.classList.contains('px-1.5')).toBe(true)
    expect(measuredArtifact?.dataset.content).toBe('@evidence.csv')
    expect(measuredArtifact?.classList.contains('inline-flex')).toBe(true)
    measurement.style.lineHeight = '20px'
    let scrollHeight = 250
    Object.defineProperty(measurement, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight
    })

    act(() => notifyResize?.())
    expect(container.querySelector('[aria-label="Show more"]')).toBeNull()
    expect(getButton('Open skill forecast')).not.toBeNull()

    scrollHeight = 260
    act(() => notifyResize?.())

    expect(getButton('Show more')).not.toBeNull()
    expect(container.querySelector('[aria-label="Open skill forecast"]')).toBeNull()
    expect(container.querySelector('[aria-label="Preview evidence.csv"]')).toBeNull()
    expect(content.textContent).toBe(contentText)
    expect(content.contains(attachment)).toBe(false)

    await click(getButton('Show more'))

    expect(content.contains(getButton('Open skill forecast'))).toBe(true)
    expect(content.contains(getButton('Preview evidence.csv'))).toBe(true)
    expect(getButton('Show less').getAttribute('aria-expanded')).toBe('true')
  })

  it('labels an interrupted user turn without creating another message item', async () => {
    await renderItem(createMessage({ interrupted: true }))

    expect(container.querySelectorAll('[data-slot="user-message-bubble"]')).toHaveLength(1)
    const interruption = container.querySelector('[data-slot="user-message-interrupted"]')
    expect(interruption?.textContent).toBe('This turn was interrupted.')
    expect(interruption?.classList.contains('italic')).toBe(true)
    expect(interruption?.classList.contains('text-amber-600')).toBe(true)
    expect(interruption?.classList.contains('dark:text-amber-400')).toBe(true)
  })

  it('renders copy and edit actions next to user bubbles only', async () => {
    await renderItem(createMessage())

    expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).not.toBeNull()

    await renderItem(createMessage({ role: 'agent' }))

    expect(container.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('renders a delivered Side chat advisory as context instead of an editable user prompt', async () => {
    await renderItem(
      createMessage({
        content: 'Use a black line.',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      })
    )

    expect(container.querySelector('[data-testid="side-chat-advisory"]')?.textContent).toContain(
      'Side chat'
    )
    expect(container.textContent).toContain('Use a black line.')
    expect(container.querySelector('[data-slot="user-message-bubble"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('keeps hover actions left of the bubble and Branch navigation in its footer', async () => {
    await renderItem(createMessage(), {
      canEditMessage: true,
      revisionNavigation: { index: 1, total: 3 }
    })

    const bubbleRow = container.querySelector('[data-slot="user-bubble-row"]')
    const bubble = bubbleRow?.querySelector('[data-slot="user-message-bubble"]')
    const actions = bubbleRow?.querySelector('[data-slot="user-message-actions"]')
    const footer = container.querySelector('[data-slot="user-message-footer"]')
    const revisionNavigation = footer?.querySelector(
      '[data-slot="user-message-revision-navigation"]'
    )
    const sentTime = footer?.querySelector('time')

    if (!bubbleRow || !bubble || !actions || !footer || !revisionNavigation || !sentTime) {
      throw new Error('user bubble layout, actions, footer, time, or revision navigation not found')
    }
    expect(actions.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(bubbleRow.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(sentTime.textContent).toMatch(/^Sent /)
    expect(sentTime.textContent).toMatch(/^Sent [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/)
    expect(sentTime.getAttribute('datetime')).toBe('2024-03-09T16:00:00.000Z')
    expect(footer.classList.contains('text-text-000/70')).toBe(true)
    expect(footer.classList.contains('text-text-300')).toBe(false)
    expect(footer.classList.contains('w-full')).toBe(true)
    expect(footer.classList.contains('flex-wrap')).toBe(true)
    expect(footer.querySelector('[aria-label="Message revision"]')?.textContent).toBe('2/3')
    expect(footer.querySelector('[data-slot="user-message-revision-icon"]')).not.toBeNull()
    expect(actions.querySelector('[aria-label="Message revision"]')).toBeNull()
    expect(
      sentTime.compareDocumentPosition(revisionNavigation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    const copyButton = actions.querySelector('[aria-label="Copy message"]')
    expect(copyButton?.getAttribute('data-state')).toBe('closed')
    expect(copyButton?.classList.contains('focus-visible:ring-[3px]')).toBe(true)
    expect(copyButton?.classList.contains('focus-visible:ring-ring/50')).toBe(true)
    expect(copyButton?.classList.contains('disabled:pointer-events-none')).toBe(true)
    expect(actions.querySelector('[aria-label="Edit message"]')).not.toBeNull()
  })

  it('omits an out-of-range persisted sent time without losing the message', async () => {
    await renderItem(createMessage({ createdAt: Number.MAX_VALUE }))

    expect(container.textContent).toContain('Prompt text')
    expect(container.querySelector('[data-slot="user-message-footer"]')).toBeNull()
  })

  it('keeps Branch navigation available when a persisted sent time is invalid', async () => {
    await renderItem(createMessage({ createdAt: Number.MAX_VALUE }), {
      canEditMessage: true,
      revisionNavigation: { index: 0, total: 2, onNext: noop }
    })

    const footer = container.querySelector('[data-slot="user-message-footer"]')
    expect(footer?.querySelector('time')).toBeNull()
    expect(footer?.querySelector('[aria-label="Message revision"]')?.textContent).toBe('1/2')
  })

  it('hides copy and edit actions on an immutable message surface', async () => {
    await renderItem(createMessage(), { canEditMessage: false, showUserActions: false })

    expect(container.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('switches between message revisions through the rendered navigation controls', async () => {
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    await renderItem(createMessage(), {
      canEditMessage: true,
      revisionNavigation: { index: 1, total: 3, onPrevious, onNext }
    })

    expect(container.querySelector('[aria-label="Message revision"]')?.textContent).toBe('2/3')
    await click(getButton('Previous message revision'))
    await click(getButton('Next message revision'))

    expect(onPrevious).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('copies the message content and confirms with a transient check state', async () => {
    vi.useFakeTimers()
    try {
      await renderItem(createMessage({ content: 'copy me' }))

      await click(getButton('Copy message'))

      expect(writeText).toHaveBeenCalledWith('copy me')
      // The resolved clipboard write swaps the icon to a check until the reset timer fires.
      expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull()

      act(() => {
        vi.advanceTimersByTime(2000)
      })

      expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the editor closed while the run has not settled', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), { canEditMessage: false, onSendEditedMessage })

    const editButton = getButton('Edit message')
    expect(editButton.disabled).toBe(true)

    await click(editButton)
    expect(getEditor()).toBeNull()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
  })

  it('opens an inline editor prefilled from the message, restoring mention chips', async () => {
    await renderItem(
      createMessage({
        content: 'Run /forecast now',
        parts: [
          { type: 'text', text: 'Run ' },
          { type: 'skill', id: 'skill-forecast', name: 'forecast' },
          { type: 'text', text: ' now' }
        ]
      }),
      { canEditMessage: true }
    )

    await click(getButton('Edit message'))

    const editor = getEditor()
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toBe('Run /forecast now')
    // The structured skill segment comes back as a chip, not flattened text.
    expect(editor?.querySelector('[data-mention-type="skill"]')).not.toBeNull()
  })

  it('separates read-only uploaded files from the message editor', async () => {
    await renderItem(
      createMessage({
        uploads: [
          {
            id: 'upload-1',
            versionId: 'upload-version-1',
            versionNumber: 1,
            sessionId: 'session-1',
            name: 'GSE23649_group-1.csv',
            originalName: 'GSE23649_group-1.csv',
            mimeType: 'text/csv',
            size: 1024,
            sha256: 'checksum-1'
          }
        ]
      }),
      { canEditMessage: true }
    )

    await click(getButton('Edit message'))

    const editorCard = getEditorCardButton('Send').parentElement?.parentElement
    expect(editorCard?.textContent).toContain('GSE23649_group-1.csv')
    expect(editorCard?.querySelector('[role="separator"]')).not.toBeNull()
    expect(
      editorCard?.querySelector('[aria-label="Remove attachment GSE23649_group-1.csv"]')
    ).toBeNull()
  })

  it('keeps the artifact mention popup outside transcript row containment while editing', async () => {
    await renderItem(createMessage(), { canEditMessage: true })

    await click(getButton('Edit message'))
    const editor = getEditor()
    if (!editor) throw new Error('editor not found')
    await typeMentionIntoEditor(editor)

    expect(container.querySelector('[role="listbox"]')).not.toBeNull()
    expect(container.firstElementChild?.getAttribute('data-disable-containment')).toBe('true')
  })

  it('cancels editing and restores the bubble without resending', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), { canEditMessage: true, onSendEditedMessage })

    await click(getButton('Edit message'))
    expect(getEditor()).not.toBeNull()

    await click(getEditorCardButton('Cancel'))

    expect(getEditor()).toBeNull()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    // The original bubble content is back.
    expect(container.textContent).toContain('Prompt text')
  })

  it('resends the adjusted prompt and closes the editor when few turns follow', async () => {
    const onSendEditedMessage = vi.fn(() => ({ ok: true, disposition: 'sent' as const }))
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      subsequentTurns: 1
    })

    await click(getButton('Edit message'))
    const editor = getEditor()
    if (!editor) throw new Error('editor not found')

    await typeIntoEditor(editor, 'edited prompt')
    await click(getEditorCardButton('Send'))

    // With fewer than two later turns the resend proceeds without the destructive warning.
    expect(getDialog()).toBeNull()
    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'message-1',
      {
        nodes: [{ type: 'text', text: 'edited prompt' }]
      },
      []
    )
    expect(getEditor()).toBeNull()
  })

  it('warns before a destructive resend when several turns follow the edited message', async () => {
    const onSendEditedMessage = vi.fn(() => ({ ok: true, disposition: 'sent' as const }))
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      subsequentTurns: 3
    })

    await click(getButton('Edit message'))
    await click(getEditorCardButton('Send'))

    // The resend waits for explicit confirmation and explains that later turns remain on the old branch.
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    expect(getDialog()?.textContent).toContain('Resend on a new branch?')
    expect(getDialog()?.textContent).toContain('3 turns')

    await click(getDialogButton('Branch and resend'))

    expect(onSendEditedMessage).toHaveBeenCalledWith(
      'message-1',
      {
        nodes: [{ type: 'text', text: 'Prompt text' }]
      },
      []
    )
    expect(getDialog()).toBeNull()
    expect(getEditor()).toBeNull()
  })

  it('keeps the editor open when the deletion warning is cancelled', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      subsequentTurns: 2
    })

    await click(getButton('Edit message'))
    await click(getEditorCardButton('Send'))
    expect(getDialog()).not.toBeNull()

    await click(getDialogButton('Cancel'))

    expect(onSendEditedMessage).not.toHaveBeenCalled()
    expect(getDialog()).toBeNull()
    // The editor stays open so the adjusted draft is not lost.
    expect(getEditor()).not.toBeNull()
  })
})
