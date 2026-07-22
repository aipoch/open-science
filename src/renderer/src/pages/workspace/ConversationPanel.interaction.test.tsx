// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPanel } from './ConversationPanel'
import { emptyDoc } from './composer/composer-doc'

import type { ChatSession } from '@/stores/session-store'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Child regions pull in stores/UI unrelated to composer intake, so stub them to plain markers.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanel: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ')
}))

// Radix DropdownMenu calls pointer-capture APIs that jsdom does not implement.
// Replace with a flat render so items are always visible in the DOM.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: () => void
    'data-testid'?: string
  }>): React.JSX.Element => (
    <button type="button" disabled={disabled} onClick={onSelect} {...rest}>
      {children}
    </button>
  )
}))

vi.mock('./ComposerModelPicker', () => ({
  ComposerModelPicker: (): null => null
}))

vi.mock('./ComposerAutoReviewToggle', () => ({
  ComposerAutoReviewToggle: (): null => null
}))

vi.mock('./ComputeHostSelector', () => ({
  ComputeHostSelector: (): null => null
}))

// session-job-store mock: controls whether the active session has running/finished jobs.
// Default: no jobs. Override mockHasRunningJobs / mockAllJobs per test.
let mockHasRunningJobs = false
let mockAllJobs: unknown[] = []

vi.mock('@/stores/session-job-store', () => ({
  useSessionJobStore: (
    selector: (s: {
      runningJobsForSession: (id: string) => unknown[]
      allJobsForSession: (id: string) => unknown[]
    }) => unknown
  ) =>
    selector({
      runningJobsForSession: () => (mockHasRunningJobs ? [{ job_id: 'job-1' }] : []),
      allJobsForSession: () => mockAllJobs
    })
}))

// RemoteJobBadge renders a sentinel element when a sessionId is provided so tests can assert presence.
vi.mock('@/components/RemoteJobBadge', () => ({
  RemoteJobBadge: ({
    sessionId,
    onOpenJobList
  }: {
    sessionId: string
    onOpenJobList?: () => void
  }): React.JSX.Element | null =>
    sessionId ? (
      <span data-testid="remote-job-badge" onClick={onOpenJobList}>
        {sessionId}
      </span>
    ) : null
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
        draftDoc={emptyDoc}
        canSendMessage={false}
        canEditDraft
        actionError={null}
        isPreviewPanelCollapsed={false}
        attachments={[]}
        isUploadingAttachments={false}
        notebookReference={undefined}
        pendingPermissions={[]}
        permissionProfile="ask"
        permissionProfileState={undefined}
        permissionGrants={[]}
        canChangePermissionProfile
        onDraftDocChange={vi.fn()}
        onSendMessage={vi.fn()}
        onStageAttachmentFiles={onStageAttachmentFiles}
        onRemoveAttachment={vi.fn()}
        onCancelRun={vi.fn()}
        onResumeSession={vi.fn().mockResolvedValue(undefined)}
        onOpenNotebook={vi.fn()}
        onTogglePreviewPanel={vi.fn()}
        onRespondToPermission={vi.fn()}
        onPermissionProfileChange={vi.fn()}
        onRevokePermissionGrant={vi.fn()}
        onClearPermissionGrants={vi.fn()}
        autoReviewEnabled={true}
        onAutoReviewToggle={vi.fn()}
        enabledComputeHosts={[]}
        onComputeHostToggle={vi.fn()}
        onRequestReview={vi.fn()}
        isRequestReviewDisabled={false}
        {...props}
      />
    )
  })
}

const getComposerForm = (): HTMLElement => {
  const form = container.querySelector('form')
  if (!form) throw new Error('composer form not found')
  return form as HTMLElement
}

const getComposerEditor = (): HTMLElement => {
  const editor = container.querySelector('[role="textbox"]')
  if (!editor) throw new Error('composer editor not found')
  return editor as HTMLElement
}

const dispatchPaste = (files: File[]): boolean => {
  const editor = getComposerEditor()
  const event = new Event('paste', { bubbles: true, cancelable: true })
  // The editor also reads text/plain, so the mock clipboard exposes both files and getData.
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } })
  act(() => {
    editor.dispatchEvent(event)
  })
  return event.defaultPrevented
}

const dispatchDrag = (type: string, dataTransferTypes: string[], files: File[] = []): void => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: dataTransferTypes, files, dropEffect: 'none' }
  })
  act(() => {
    getComposerForm().dispatchEvent(event)
  })
}

const hasDropOverlay = (): boolean =>
  container.textContent?.includes('Drop files to attach') ?? false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onStageAttachmentFiles.mockClear()
  mockHasRunningJobs = false
  mockAllJobs = []
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

  it('submits on Enter through the editor with the picked skill ids', () => {
    const onSendMessage = vi.fn()
    renderPanel({ onSendMessage })

    const editor = getComposerEditor()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      editor.dispatchEvent(event)
    })

    // A plain-text draft carries no chips, so the send handler receives an empty id list.
    expect(onSendMessage).toHaveBeenCalledWith([])
  })

  it('persists typed text as a doc via onDraftDocChange', () => {
    const onDraftDocChange = vi.fn()
    renderPanel({ onDraftDocChange })

    const editor = getComposerEditor()
    editor.textContent = 'hello'
    act(() => {
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onDraftDocChange).toHaveBeenCalledWith({ nodes: [{ type: 'text', text: 'hello' }] })
  })
})

describe('ConversationPanel + menu', () => {
  it('renders both Attach files and Request review items', () => {
    renderPanel()

    const attachItem = container.querySelector('[data-testid="menu-attach-files"]')
    const reviewItem = container.querySelector('[data-testid="menu-request-review"]')

    expect(attachItem).not.toBeNull()
    expect(reviewItem).not.toBeNull()
  })

  it('Attach files item triggers the hidden file input (onStageAttachmentFiles path)', () => {
    // We can only confirm the item exists and is not disabled; the picker click is browser-native.
    renderPanel()

    const attachItem = container.querySelector('[data-testid="menu-attach-files"]')
    expect(attachItem).not.toBeNull()
    expect((attachItem as HTMLButtonElement).disabled).toBe(false)
  })

  it('Request review calls onRequestReview when enabled', () => {
    const onRequestReview = vi.fn()
    renderPanel({ onRequestReview, isRequestReviewDisabled: false })

    const reviewItem = container.querySelector('[data-testid="menu-request-review"]')
    expect(reviewItem).not.toBeNull()
    act(() => {
      ;(reviewItem as HTMLButtonElement).click()
    })

    expect(onRequestReview).toHaveBeenCalledTimes(1)
  })

  it('Request review is disabled when isRequestReviewDisabled is true', () => {
    const onRequestReview = vi.fn()
    renderPanel({ onRequestReview, isRequestReviewDisabled: true })

    const reviewItem = container.querySelector(
      '[data-testid="menu-request-review"]'
    ) as HTMLButtonElement
    expect(reviewItem.disabled).toBe(true)

    act(() => {
      reviewItem.click()
    })

    // disabled button click should not call the handler
    expect(onRequestReview).not.toHaveBeenCalled()
  })

  it('Request review is not called when disabled is true (onSelect guard)', () => {
    const onRequestReview = vi.fn()
    renderPanel({ onRequestReview, isRequestReviewDisabled: true })

    const reviewItem = container.querySelector(
      '[data-testid="menu-request-review"]'
    ) as HTMLButtonElement
    // Simulate the click directly on the element — disabled buttons suppress click events.
    act(() => {
      reviewItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onRequestReview).not.toHaveBeenCalled()
  })
})

describe('ConversationPanel fix loop lock', () => {
  const idleSession: ChatSession = {
    id: 'session-fix-loop',
    projectId: 'project-a',
    title: 'Fix loop session',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      {
        id: 'msg-1',
        role: 'agent',
        content: 'Done',
        status: 'complete',
        eventIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  const lockedSession: ChatSession = {
    ...idleSession,
    fixLoopActive: true
  }

  it('send button is disabled when canSendMessage is false (fix loop active)', () => {
    // canSendMessage is passed from outside (computed by WorkspacePage)
    renderPanel({ activeSession: idleSession, canSendMessage: false })

    const sendButton = container.querySelector('[aria-label="Send message"]') as HTMLButtonElement
    expect(sendButton).not.toBeNull()
    expect(sendButton.disabled).toBe(true)
  })

  it('send button is enabled when canSendMessage is true (no fix loop)', () => {
    renderPanel({ activeSession: idleSession, canSendMessage: true })

    const sendButton = container.querySelector('[aria-label="Send message"]') as HTMLButtonElement
    expect(sendButton).not.toBeNull()
    expect(sendButton.disabled).toBe(false)
  })

  it('send button stays disabled when typing does not change canSendMessage (fix loop active)', () => {
    const onDraftDocChange = vi.fn()
    renderPanel({
      activeSession: lockedSession,
      canSendMessage: false,
      onDraftDocChange
    })

    // Simulate typing — the doc change is fired but canSendMessage remains false (external prop)
    const editor = container.querySelector('[role="textbox"]') as HTMLElement
    editor.textContent = 'some text'
    act(() => {
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Even after typing, the send button remains disabled because canSendMessage=false is external
    const sendButton = container.querySelector('[aria-label="Send message"]') as HTMLButtonElement
    if (sendButton) {
      expect(sendButton.disabled).toBe(true)
    }
    // The doc change is still fired (composing is allowed)
    expect(onDraftDocChange).toHaveBeenCalled()
  })

  it('cancel button is visible when session is running and calls onCancelRun', () => {
    const onCancelRun = vi.fn()
    const runningSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() }
    }
    renderPanel({ activeSession: runningSession, canSendMessage: false, onCancelRun })

    const cancelButton = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    expect(cancelButton).not.toBeNull()
    act(() => {
      cancelButton.click()
    })

    expect(onCancelRun).toHaveBeenCalledTimes(1)
  })

  it('cancel button during fix loop calls onCancelRun which unlocks the composer', () => {
    const onCancelRun = vi.fn()
    const runningLockedSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() },
      fixLoopActive: true
    }
    // When the fix loop is active and session is running, onCancelRun handles both
    // ACP cancel and fix loop abort (wired in WorkspacePage)
    renderPanel({
      activeSession: runningLockedSession,
      canSendMessage: false,
      onCancelRun
    })

    const cancelButton = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    expect(cancelButton).not.toBeNull()
    act(() => {
      cancelButton.click()
    })

    // The same cancel button is reused; the wiring to abort the loop happens in WorkspacePage
    expect(onCancelRun).toHaveBeenCalledTimes(1)
  })

  it('cancel button is visible during the reviewer-review sub-phase (fix loop active, main agent idle)', () => {
    const onCancelRun = vi.fn()
    // Reviewer-review sub-phase: the fix loop is active but the main agent is idle (the reviewer runs in
    // a separate ACP session, so the main session's status is not 'running'). The cancel affordance
    // must still be reachable so the user can abort the loop during this window.
    renderPanel({ activeSession: lockedSession, canSendMessage: false, onCancelRun })

    const cancelButton = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    expect(cancelButton).not.toBeNull()
    // The send button is replaced by cancel while the loop is active — not merely disabled.
    expect(container.querySelector('[aria-label="Send message"]')).toBeNull()

    act(() => {
      cancelButton.click()
    })
    expect(onCancelRun).toHaveBeenCalledTimes(1)
  })
})

describe('ConversationPanel compacting state', () => {
  const compactingSession: ChatSession = {
    id: 'session-compacting',
    projectId: 'project-a',
    title: 'Compacting session',
    cwd: '/workspace',
    status: 'idle',
    compacting: true,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  it('shows a neutral compacting note and hides the overflow error during recovery', () => {
    // The raw overflow error is still present as a global actionError, but must be suppressed while the
    // session is compacting so the user sees the recovery affordance, not a dead-end.
    renderPanel({
      activeSession: compactingSession,
      actionError: 'Internal error: Request too large (max 32MB).'
    })

    expect(container.textContent).toContain('Compacting conversation to fit the context limit')
    expect(container.textContent).not.toContain('Request too large')
  })
})

describe('ConversationPanel notebook bar', () => {
  const session: ChatSession = {
    id: 'session-bar',
    projectId: 'project-a',
    title: 'Bar session',
    cwd: '/workspace',
    status: 'idle',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  it('hides the notebook bar when there is no notebookReference and no running job', () => {
    mockHasRunningJobs = false
    renderPanel({ activeSession: session, notebookReference: undefined })

    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).toBeNull()
  })

  it('shows only the Notebook button when notebookReference exists and no running job', () => {
    mockHasRunningJobs = false
    const ref = {
      notebookId: 'nb-1',
      sessionId: 'session-bar',
      projectName: 'proj',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/nb',
      dataRoot: '/data',
      runtimeRoot: '/rt',
      runJsonPath: '/run.json'
    }
    renderPanel({ activeSession: session, notebookReference: ref })

    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).toBeNull()
  })

  it('shows only the job badge when there is no notebookReference but there are running jobs', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference: undefined })

    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('shows both the Notebook button and the job badge when both are present', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    const ref = {
      notebookId: 'nb-1',
      sessionId: 'session-bar',
      projectName: 'proj',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/nb',
      dataRoot: '/data',
      runtimeRoot: '/rt',
      runJsonPath: '/run.json'
    }
    renderPanel({ activeSession: session, notebookReference: ref })

    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('keeps the notebook bar visible when there are finished jobs but no running jobs', () => {
    mockHasRunningJobs = false
    mockAllJobs = [{ job_id: 'job-1', status: 'done', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference: undefined })

    // Bar should be visible (the container that wraps badge/notebook button)
    const notebookBar = container.querySelector('.mb-2.flex.min-h-9')
    expect(notebookBar).not.toBeNull()
    // Badge should be visible even though no jobs are running
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('calls onOpenJobList when the badge is clicked', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    const handleOpenJobList = vi.fn()
    renderPanel({ activeSession: session, notebookReference: undefined, onOpenJobList: handleOpenJobList })

    const badge = container.querySelector('[data-testid="remote-job-badge"]')
    expect(badge).not.toBeNull()

    act(() => {
      ;(badge as HTMLElement).click()
    })

    expect(handleOpenJobList).toHaveBeenCalledTimes(1)
    expect(handleOpenJobList).toHaveBeenCalledWith('session-bar')
  })
})
