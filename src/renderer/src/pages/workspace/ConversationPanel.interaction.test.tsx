// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPanel } from './ConversationPanel'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Child regions pull in stores/UI unrelated to composer intake, so stub them to plain markers.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

vi.mock('./ComposerModelPicker', () => ({
  ComposerModelPicker: (): null => null
}))

vi.mock('./WorkspaceMessageScroller', () => ({
  WorkspaceMessageScroller: (): null => null
}))

vi.mock('./PermissionApprovalControls', () => ({
  PermissionApprovalControls: (): null => null
}))

let container: HTMLDivElement
let root: Root

const onStageAttachmentFiles = vi.fn()

const renderPanel = (props: Partial<Parameters<typeof ConversationPanel>[0]> = {}): void => {
  act(() => {
    root.render(
      <ConversationPanel
        activeSession={undefined}
        messageDraft=""
        canSendMessage={false}
        canEditDraft
        actionError={null}
        isPreviewPanelCollapsed={false}
        attachments={[]}
        isUploadingAttachments={false}
        notebookReference={undefined}
        pendingPermissions={[]}
        onMessageDraftChange={vi.fn()}
        onSendMessage={vi.fn()}
        onStageAttachmentFiles={onStageAttachmentFiles}
        onRemoveAttachment={vi.fn()}
        onCancelRun={vi.fn()}
        onOpenNotebook={vi.fn()}
        onTogglePreviewPanel={vi.fn()}
        onRespondToPermission={vi.fn()}
        {...props}
      />
    )
  })
}

const getSection = (): HTMLElement => {
  const section = container.querySelector('section[data-session-id]')
  if (!section) throw new Error('conversation section not found')
  return section as HTMLElement
}

const dispatchPaste = (files: File[]): boolean => {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files } })
  act(() => {
    textarea.dispatchEvent(event)
  })
  return event.defaultPrevented
}

const dispatchDrag = (type: string, dataTransferTypes: string[], files: File[] = []): void => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: dataTransferTypes, files, dropEffect: 'none' }
  })
  act(() => {
    getSection().dispatchEvent(event)
  })
}

const hasDropOverlay = (): boolean =>
  container.textContent?.includes('Drop files to attach') ?? false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onStageAttachmentFiles.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ConversationPanel composer intake', () => {
  it('stages a pasted non-image file', () => {
    renderPanel()
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })

    const prevented = dispatchPaste([pdf])

    expect(onStageAttachmentFiles).toHaveBeenCalledWith([pdf])
    expect(prevented).toBe(true)
  })

  it('leaves plain-text paste untouched when no files are present', () => {
    renderPanel()

    const prevented = dispatchPaste([])

    expect(onStageAttachmentFiles).not.toHaveBeenCalled()
    expect(prevented).toBe(false)
  })

  it('shows the overlay during a file drag and stages the dropped files', () => {
    renderPanel()
    const file = new File(['data'], 'data.csv', { type: 'text/csv' })

    dispatchDrag('dragenter', ['Files'])
    expect(hasDropOverlay()).toBe(true)

    dispatchDrag('drop', ['Files'], [file])
    expect(onStageAttachmentFiles).toHaveBeenCalledWith([file])
    expect(hasDropOverlay()).toBe(false)
  })

  it('ignores plain-text drags with no overlay and no upload', () => {
    renderPanel()

    dispatchDrag('dragenter', ['text/plain'])
    expect(hasDropOverlay()).toBe(false)

    dispatchDrag('drop', ['text/plain'])
    expect(onStageAttachmentFiles).not.toHaveBeenCalled()
  })

  it('never activates the drop overlay when editing is disabled', () => {
    renderPanel({ canEditDraft: false })

    dispatchDrag('dragenter', ['Files'])
    expect(hasDropOverlay()).toBe(false)
  })
})
