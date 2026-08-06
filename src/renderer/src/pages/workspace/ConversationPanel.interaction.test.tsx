// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPanel } from './ConversationPanel'
import { emptyDoc } from './composer/composer-doc'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'

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

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  Tooltip: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  TooltipContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

vi.mock('./ComposerModelPicker', () => ({
  ComposerModelPicker: (): null => null
}))

vi.mock('./ComposerAgentControlsMenu', () => ({
  ComposerAgentControlsMenu: (): null => null
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

const { respondToSessionPlanMock } = vi.hoisted(() => ({
  respondToSessionPlanMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./session-plan/respond-to-session-plan', () => ({
  respondToSessionPlan: respondToSessionPlanMock
}))

let container: HTMLDivElement
let root: Root

const onStageAttachmentFiles = vi.fn()

const completedPlanProjection: ActivePlanProjection = {
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'a'.repeat(64),
  originatingPromptMessageId: 'plan-origin',
  revision: 4,
  approval: 'approved',
  lifecycle: 'completed',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze one dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: { 'Analyze data': { status: 'completed', updatedAt: 1 } },
  stepStates: { 'Analyze data': { status: 'completed' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
}

const planOriginMessages = (): ChatSession['messages'] => [
  {
    id: 'plan-origin',
    role: 'user',
    content: 'Create the Plan.',
    status: 'complete',
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
]

const renderPanel = (props: Partial<Parameters<typeof ConversationPanel>[0]> = {}): void => {
  act(() => {
    root.render(
      <ConversationPanel
        activeSession={undefined}
        draftDoc={emptyDoc}
        canSendMessage={false}
        canEditDraft
        canResumeSession
        actionError={null}
        attachments={[]}
        attachmentTransfers={[]}
        isUploadingAttachments={false}
        notebookReference={undefined}
        pendingPermissions={[]}
        permissionProfile="ask"
        permissionProfileState={undefined}
        permissionGrants={[]}
        contextUsage={undefined}
        canChangeAgentControls
        canChangePermissionProfile
        onDraftDocChange={vi.fn()}
        onSendMessage={vi.fn()}
        onRespondToRestoredPlan={vi.fn().mockResolvedValue(undefined)}
        onStageAttachmentFiles={onStageAttachmentFiles}
        onRemoveAttachment={vi.fn()}
        onCancelAttachmentTransfer={vi.fn()}
        onCancelRun={vi.fn()}
        onResumeSession={vi.fn().mockResolvedValue(undefined)}
        onOpenNotebook={vi.fn()}
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
        canEditMessage={true}
        onSendEditedMessage={vi.fn()}
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

const getConversationHeader = (): HTMLElement => {
  const header = container.querySelector('[data-testid="conversation-header"]')
  if (!header) throw new Error('conversation header not found')
  return header as HTMLElement
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

describe('ConversationPanel header spacing', () => {
  it('keeps stable title spacing independent of sidebar state', () => {
    renderPanel()

    expect(getConversationHeader().className.split(' ')).toEqual(
      expect.arrayContaining(['px-4', 'pt-2'])
    )
    expect(getConversationHeader().className.split(' ')).not.toContain('pl-8')
  })
})

const hasDropOverlay = (): boolean =>
  container.textContent?.includes('Drop files to attach') ?? false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onStageAttachmentFiles.mockClear()
  respondToSessionPlanMock.mockReset().mockResolvedValue(undefined)
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  mockHasRunningJobs = false
  mockAllJobs = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ConversationPanel composer intake', () => {
  it.each([
    ['darwin', '⌘K'],
    ['win32', 'Ctrl+K'],
    ['linux', 'Ctrl+K']
  ])('shows the %s global-search shortcut in the placeholder', (platform, shortcut) => {
    const previousApi = window.api
    window.api = { platform } as Window['api']

    renderPanel()

    expect(getComposerEditor().getAttribute('data-placeholder')).toBe(
      `Ask anything — / skills · @ files · ${shortcut} search · ↑↓ history`
    )
    window.api = previousApi
  })

  it('shows file type and per-file size behavior before selection', () => {
    renderPanel()

    expect(container.querySelector('[data-testid="attachment-limits"]')?.textContent).toContain(
      'Any file type · 10 GB per file. Large files are linked, not embedded.'
    )
  })

  it('keeps a pending Plan read-only after the Agent interaction ends without a decision', () => {
    const session: ChatSession = {
      id: 'session-settled-without-decision',
      projectId: 'project-a',
      title: 'Settled pending Plan',
      cwd: '/workspace',
      status: 'idle',
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2,
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      }
    }

    renderPanel({ activeSession: session, canEditDraft: true })

    expect(container.textContent).not.toContain('Plan ready for review')
    expect(container.querySelector('[role="textbox"]')?.closest('form')?.classList).not.toContain(
      'hidden'
    )
    expect(container.querySelector('[data-testid="menu-view-plan"]')).not.toBeNull()
  })

  it('shows per-file progress and cancels only the selected transfer', () => {
    const onCancelAttachmentTransfer = vi.fn()
    const transfer = {
      transferId: 'transfer-1',
      name: 'large.csv',
      mimeType: 'text/csv',
      receivedBytes: 25,
      totalBytes: 100,
      status: 'uploading' as const
    }
    renderPanel({
      attachmentTransfers: [transfer],
      isUploadingAttachments: true,
      onCancelAttachmentTransfer
    })

    const progress = container.querySelector('[role="progressbar"]')
    const cancel = container.querySelector(
      'button[aria-label="Cancel attachment large.csv"]'
    ) as HTMLButtonElement | null

    expect(progress?.getAttribute('aria-valuenow')).toBe('25')
    expect(container.textContent).toContain('25% of 100 B')
    expect(cancel).not.toBeNull()
    act(() => cancel?.click())
    expect(onCancelAttachmentTransfer).toHaveBeenCalledWith(transfer)
  })

  it('uses a flat border without a card shadow', () => {
    renderPanel()

    const composerForm = getComposerForm()

    expect(composerForm.classList.contains('border')).toBe(true)
    expect(composerForm.classList.contains('border-border-200')).toBe(true)
    expect(composerForm.classList.contains('shadow-card-opaque')).toBe(false)
  })

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

  it('offers Plan first for a text draft in a new conversation while Branch stays disabled', () => {
    const onPlanFirst = vi.fn()
    renderPanel({
      canSendMessage: true,
      draftDoc: {
        nodes: [
          { type: 'skill', id: 'skill-analysis', name: 'analysis' },
          { type: 'text', text: ' analyze this dataset' }
        ]
      },
      onPlanFirst
    })

    const trigger = container.querySelector(
      '[data-testid="branch-send-menu-trigger"]'
    ) as HTMLButtonElement
    const planItem = container.querySelector('[data-testid="menu-plan-first"]') as HTMLButtonElement
    const branchItem = container.querySelector(
      '[data-testid="menu-branch-in-new-session"]'
    ) as HTMLButtonElement

    expect(trigger).not.toBeNull()
    expect(planItem.textContent).toContain('Plan first')
    expect(planItem.disabled).toBe(false)
    expect(branchItem.disabled).toBe(true)

    act(() => planItem.click())
    expect(onPlanFirst).toHaveBeenCalledWith(['skill-analysis'])
  })

  it('enables both Plan first and Branch in new session for an existing Session text draft', () => {
    const session: ChatSession = {
      id: 'session-existing',
      projectId: 'project-a',
      title: 'Existing session',
      cwd: '/workspace',
      status: 'idle',
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2
    }
    renderPanel({
      activeSession: session,
      canSendMessage: true,
      draftDoc: { nodes: [{ type: 'text', text: 'analyze this dataset' }] },
      onPlanFirst: vi.fn(),
      onBranchInNewSession: vi.fn()
    })

    expect(
      (container.querySelector('[data-testid="menu-plan-first"]') as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (container.querySelector('[data-testid="menu-branch-in-new-session"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it('disables Plan first for an attachment-only draft', () => {
    renderPanel({
      canSendMessage: true,
      attachments: [
        {
          id: 'upload-1',
          sessionId: '.pending',
          name: 'data.csv',
          originalName: 'data.csv',
          path: '/uploads/data.csv',
          size: 12,
          mimeType: 'text/csv'
        }
      ],
      onPlanFirst: vi.fn()
    })

    expect(
      (container.querySelector('[data-testid="menu-plan-first"]') as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('adds a branch option beside Send only when a branch handler is available', () => {
    const onBranchInNewSession = vi.fn()
    renderPanel({ canSendMessage: true, onBranchInNewSession })

    const trigger = container.querySelector(
      '[data-testid="branch-send-menu-trigger"]'
    ) as HTMLButtonElement
    const send = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement
    const branchItem = container.querySelector(
      '[data-testid="menu-branch-in-new-session"]'
    ) as HTMLButtonElement

    expect(send.getAttribute('data-slot')).toBe('button')
    expect(trigger.getAttribute('data-slot')).toBe('button')
    expect(send.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-8',
        'w-8',
        '[@media(pointer:coarse)]:before:-inset-y-1.5',
        '[@media(pointer:coarse)]:before:-left-3',
        '[@media(pointer:coarse)]:before:right-0'
      ])
    )
    expect(trigger.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-8',
        'w-8',
        '[@media(pointer:coarse)]:before:-inset-y-1.5',
        '[@media(pointer:coarse)]:before:left-0',
        '[@media(pointer:coarse)]:before:-right-3'
      ])
    )
    expect(send.parentElement?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'rounded-md',
        'bg-primary',
        'text-primary-foreground',
        '[@media(pointer:coarse)]:mx-3'
      ])
    )
    expect(send.className.split(' ')).toEqual(
      expect.arrayContaining(['border-0', 'bg-transparent', 'hover:bg-primary-foreground/10'])
    )
    expect(trigger.className.split(' ')).toEqual(
      expect.arrayContaining([
        'border-0',
        'bg-transparent',
        'after:left-0',
        'after:bg-primary-foreground/20',
        'active:translate-y-px',
        'motion-reduce:active:translate-y-0'
      ])
    )
    expect(trigger.getAttribute('aria-label')).toBe('More send options')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(branchItem.textContent).toContain('Branch in new session')

    act(() => branchItem.click())

    expect(onBranchInNewSession).toHaveBeenCalledWith([])
  })

  it('disables the branch option whenever Send is disabled', () => {
    const onBranchInNewSession = vi.fn()
    renderPanel({ canSendMessage: false, onBranchInNewSession })

    const trigger = container.querySelector(
      '[data-testid="branch-send-menu-trigger"]'
    ) as HTMLButtonElement
    const branchItem = container.querySelector(
      '[data-testid="menu-branch-in-new-session"]'
    ) as HTMLButtonElement

    expect(trigger.disabled).toBe(true)
    expect(branchItem.disabled).toBe(true)

    act(() => {
      branchItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onBranchInNewSession).not.toHaveBeenCalled()
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

describe('ConversationPanel interrupted Session recovery', () => {
  it('keeps Resume disabled while Session persistence is unavailable', () => {
    const onResumeSession = vi.fn().mockResolvedValue(undefined)
    const interruptedSession: ChatSession = {
      id: 'session-interrupted',
      projectId: 'project-a',
      title: 'Interrupted session',
      cwd: '/workspace',
      status: 'idle',
      interrupted: true,
      messages: planOriginMessages(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    renderPanel({
      activeSession: interruptedSession,
      canResumeSession: false,
      onResumeSession
    })

    const resumeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume session"]'
    )
    expect(resumeButton?.disabled).toBe(true)
    expect(resumeButton?.dataset.slot).toBe('button')
    expect(resumeButton?.className).toContain('focus-visible:ring-3')
    expect(resumeButton?.className).toContain('disabled:pointer-events-none')

    act(() => resumeButton?.click())
    expect(onResumeSession).not.toHaveBeenCalled()
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

  it('describes the composer add icon with a tooltip', () => {
    renderPanel()

    expect(
      [...container.querySelectorAll('[data-testid="tooltip-content"]')].some(
        (node) => node.textContent === 'Add attachment or request review'
      )
    ).toBe(true)
  })

  it('replaces the composer with a pending Plan card and restores it immediately after approval', async () => {
    renderPanel()
    expect(container.querySelector('[data-testid="menu-view-plan"]')).toBeNull()

    const session: ChatSession = {
      id: 'session-plan',
      projectId: 'project-a',
      title: 'Planned session',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      activeRun: { promptMessageId: 'interaction-1', startedAt: 1 },
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2,
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      }
    }
    renderPanel({ activeSession: session, canEditDraft: false })

    const pendingEditor = container.querySelector('[role="textbox"]')
    expect(pendingEditor?.closest('form')?.classList.contains('hidden')).toBe(true)
    expect(container.textContent).toContain('Plan ready for review')
    const pendingPlanCard = [...container.querySelectorAll('article')].find((article) =>
      article.textContent?.includes('Plan ready for review')
    )
    expect(pendingPlanCard?.classList.contains('relative')).toBe(true)
    expect(pendingPlanCard?.classList.contains('z-10')).toBe(true)
    expect(
      container
        .querySelector('[data-testid="composer-plus-trigger"]')
        ?.closest('form')
        ?.classList.contains('hidden')
    ).toBe(true)

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Approve')
        ?.click()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Plan ready for review')
    expect(
      container.querySelector('[role="textbox"]')?.closest('form')?.classList.contains('hidden')
    ).toBe(false)

    renderPanel({
      activeSession: {
        ...session,
        status: 'idle',
        activePlanProjection: completedPlanProjection
      }
    })
    expect(container.textContent).not.toContain('Plan approved')
    expect(
      container.querySelector('[role="textbox"]')?.closest('form')?.classList.contains('hidden')
    ).toBe(false)
    expect(container.querySelector('[data-testid="menu-view-plan"]')).not.toBeNull()
  })

  it('routes Plan revision notes through the blocked Plan interaction', async () => {
    const session: ChatSession = {
      id: 'session-plan-feedback',
      projectId: 'project-a',
      title: 'Plan feedback',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      activeRun: { promptMessageId: 'interaction-1', startedAt: 1 },
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2,
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      }
    }
    renderPanel({ activeSession: session, canEditDraft: false })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Split the analysis by cohort.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(respondToSessionPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-a', sessionId: 'session-plan-feedback' }),
      { feedback: 'Split the analysis by cohort.' }
    )
  })

  it('routes approval-like card text as a user Message instead of a UI decision', async () => {
    const session: ChatSession = {
      id: 'session-plan-text-approval',
      projectId: 'project-a',
      title: 'Plan text approval',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      activeRun: { promptMessageId: 'interaction-1', startedAt: 1 },
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2,
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      }
    }
    renderPanel({ activeSession: session, canEditDraft: false })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '批准执行')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(respondToSessionPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-plan-text-approval' }),
      { feedback: '批准执行' }
    )
  })

  it('reopens an actionable Plan card after restart without reviving the expired interaction', async () => {
    const onRespondToRestoredPlan = vi.fn().mockResolvedValue(undefined)
    const session: ChatSession = {
      id: 'session-orphaned-plan',
      projectId: 'project-a',
      title: 'Orphaned pending Plan',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2,
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      }
    }

    renderPanel({ activeSession: session, canEditDraft: false, onRespondToRestoredPlan })

    expect(container.textContent).toContain('Plan ready for review')
    expect(container.querySelector('[role="textbox"]')?.closest('form')?.classList).toContain(
      'hidden'
    )

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Split the analysis by cohort.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(onRespondToRestoredPlan).toHaveBeenCalledWith({
      feedback: 'Split the analysis by cohort.'
    })
    expect(respondToSessionPlanMock).not.toHaveBeenCalled()
  })

  it('shows only the authoritative Plan on its Message Branch while retaining an open Preview', () => {
    const planA: ActivePlanProjection = {
      ...completedPlanProjection,
      artifactId: 'artifact-a',
      artifactVersionId: 'version-a',
      originatingPromptMessageId: 'prompt-a',
      lifecycle: 'approved'
    }
    const planB: ActivePlanProjection = {
      ...completedPlanProjection,
      artifactId: 'artifact-b',
      artifactVersionId: 'version-b',
      originatingPromptMessageId: 'prompt-b',
      lifecycle: 'approved'
    }
    const baseSession: ChatSession = {
      id: 'session-plan-branches',
      projectId: 'project-a',
      title: 'Branched plans',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      activePlanProjection: planB,
      planHistoryProjections: [planA],
      createdAt: 1,
      updatedAt: 2
    }

    renderPanel({
      activeSession: {
        ...baseSession,
        messages: [
          {
            id: 'prompt-b',
            role: 'user',
            content: 'Plan branch B',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    })

    act(() => {
      ;(
        container.querySelector('button[aria-label^="Open plan, step"]') as HTMLButtonElement
      ).click()
    })
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'tool:session-plan-branches:plan:version-b'
    )

    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    act(() => {
      ;(container.querySelector('[data-testid="menu-view-plan"]') as HTMLButtonElement).click()
    })
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'tool:session-plan-branches:plan:version-b'
    )

    renderPanel({
      activeSession: {
        ...baseSession,
        messages: [
          {
            id: 'prompt-a',
            role: 'user',
            content: 'Historical Plan branch A',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    })

    expect(container.querySelector('[data-testid="menu-view-plan"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Open plan, step"]')).toBeNull()
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'tool:session-plan-branches:plan:version-b'
    )
  })

  it.each([
    ['Approve', 'approved'],
    ['Dismiss', 'rejected']
  ] as const)(
    'routes restored Plan %s through the durable decision API',
    async (label, decision) => {
      const session: ChatSession = {
        id: `session-restored-${decision}`,
        projectId: 'project-a',
        title: 'Restored pending Plan',
        cwd: '/workspace',
        status: 'waiting-plan-approval',
        messages: planOriginMessages(),
        createdAt: 1,
        updatedAt: 2,
        activePlanProjection: {
          ...completedPlanProjection,
          approval: 'pending',
          lifecycle: 'awaiting_approval'
        }
      }
      const onRespondToRestoredPlan = vi.fn().mockResolvedValue(undefined)
      renderPanel({ activeSession: session, canEditDraft: false, onRespondToRestoredPlan })

      await act(async () => {
        ;[...container.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === label)
          ?.click()
        await Promise.resolve()
      })

      expect(onRespondToRestoredPlan).toHaveBeenCalledWith({ decision })
      expect(respondToSessionPlanMock).not.toHaveBeenCalled()
    }
  )

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

  it('keeps the split-send width while running so adjacent hover controls do not shift', () => {
    const runningSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() }
    }
    renderPanel({
      activeSession: runningSession,
      canSendMessage: false,
      onBranchInNewSession: vi.fn()
    })

    const slot = container.querySelector(
      '[data-testid="composer-running-control-slot"]'
    ) as HTMLDivElement
    expect(slot.className.split(' ')).toEqual(
      expect.arrayContaining(['w-16', 'justify-end', '[@media(pointer:coarse)]:mx-3'])
    )
    expect(slot.querySelector('[aria-label="Cancel run"]')).not.toBeNull()
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
    const onCancelRun = vi.fn()
    // The raw overflow error is still present as a global actionError, but must be suppressed while the
    // session is compacting so the user sees the recovery affordance, not a dead-end.
    renderPanel({
      activeSession: compactingSession,
      actionError: 'Internal error: Request too large (max 32MB).',
      onCancelRun
    })

    expect(container.textContent).toContain('Compacting conversation to fit the context limit')
    expect(container.textContent).not.toContain('Request too large')
    const cancelButton = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    expect(cancelButton).not.toBeNull()
    act(() => cancelButton.click())
    expect(onCancelRun).toHaveBeenCalledOnce()
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
  const notebookReference = {
    notebookId: 'nb-1',
    sessionId: 'session-bar',
    projectName: 'proj',
    workspaceCwd: '/workspace',
    notebookSessionRoot: '/nb',
    dataRoot: '/data',
    runtimeRoot: '/rt',
    runJsonPath: '/run.json'
  }

  it('hides the notebook bar when there is no notebookReference and no running job', () => {
    mockHasRunningJobs = false
    renderPanel({ activeSession: session, notebookReference: undefined })

    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).toBeNull()
  })

  it('shows only the Notebook button when notebookReference exists and no running job', () => {
    mockHasRunningJobs = false
    renderPanel({ activeSession: session, notebookReference })

    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).toBeNull()
  })

  it('animates the notebook bar upward when it appears', () => {
    renderPanel({ activeSession: session, notebookReference })

    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement

    expect(notebookBar?.className).toContain('motion-safe:animate-in')
    expect(notebookBar?.className).toContain('motion-safe:fade-in-0')
    expect(notebookBar?.className).toContain('motion-safe:slide-in-from-bottom-1')
  })

  it('shows a pointer cursor over the Notebook button', () => {
    renderPanel({ activeSession: session, notebookReference })

    const notebookButton = container.querySelector('[aria-label="Open notebook"]')

    expect(notebookButton?.className).toContain('cursor-pointer')
  })

  it('shows only the job badge when there is no notebookReference but there are running jobs', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference: undefined })

    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('keeps the job-only bar compact and static', () => {
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference: undefined })

    const jobBar = container.querySelector('[data-testid="remote-job-badge"]')?.parentElement

    expect(jobBar?.classList.contains('min-h-9')).toBe(true)
    expect(jobBar?.classList.contains('bg-bg-000')).toBe(true)
    expect(jobBar?.classList.contains('motion-safe:animate-in')).toBe(false)
  })

  it('remounts the bar when a Notebook appears after jobs', () => {
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference: undefined })
    const jobBar = container.querySelector('[data-testid="remote-job-badge"]')?.parentElement

    renderPanel({ activeSession: session, notebookReference })
    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement

    expect(notebookBar).not.toBe(jobBar)
    expect(notebookBar?.classList.contains('motion-safe:animate-in')).toBe(true)
  })

  it('does not layer card shadows behind the composer border', () => {
    renderPanel({ activeSession: session, notebookReference })

    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement
    const composerBackdrop = getComposerForm().previousElementSibling

    expect(notebookBar?.classList.contains('shadow-card')).toBe(false)
    expect(composerBackdrop?.classList.contains('shadow-card')).toBe(false)
  })

  it('shows both the Notebook button and the job badge when both are present', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference })

    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('keeps the notebook bar visible when there are finished jobs but no running jobs', () => {
    mockHasRunningJobs = false
    mockAllJobs = [{ job_id: 'job-1', status: 'done', created_at: Date.now() }]
    renderPanel({ activeSession: session, notebookReference: undefined })

    // The badge's parent is the shared notebook/job bar.
    const notebookBar = container.querySelector('[data-testid="remote-job-badge"]')?.parentElement
    expect(notebookBar).not.toBeNull()
    // Badge should be visible even though no jobs are running
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('calls onOpenJobList when the badge is clicked', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    const handleOpenJobList = vi.fn()
    renderPanel({
      activeSession: session,
      notebookReference: undefined,
      onOpenJobList: handleOpenJobList
    })

    const badge = container.querySelector('[data-testid="remote-job-badge"]')
    expect(badge).not.toBeNull()

    act(() => {
      ;(badge as HTMLElement).click()
    })

    expect(handleOpenJobList).toHaveBeenCalledTimes(1)
    expect(handleOpenJobList).toHaveBeenCalledWith('session-bar')
  })
})

describe('ConversationPanel error box + report affordance', () => {
  const errorSession: ChatSession = {
    id: 'session-err',
    projectId: 'project-a',
    title: 'Error session',
    cwd: '/workspace',
    status: 'error',
    error: 'Run failed: connection reset',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  const reportButton = (): HTMLElement | null =>
    container.querySelector('[aria-label="Report this error"]')

  const errorBoxText = (): string => container.querySelector('.border-red-200')?.textContent ?? ''

  it('shows the error and a Report button for a failed run (status === error)', () => {
    renderPanel({ activeSession: errorSession })
    expect(errorBoxText()).toContain('Run failed: connection reset')
    expect(reportButton()).not.toBeNull()
  })

  it('renders the error box for a failed run even when it has no error text', () => {
    renderPanel({ activeSession: { ...errorSession, error: undefined } })
    // The shown fallback equals the text seeded into the report (single RUN_FAILED_FALLBACK_ERROR),
    // upholding the "shown == reported" invariant when a failed run carries no error message.
    expect(errorBoxText()).toContain('The run failed with no error message.')
    // Still reportable — the affordance follows the failure status, not the presence of text.
    expect(reportButton()).not.toBeNull()
  })

  it('shows only the transient actionError, without a Report button, for a non-failed session', () => {
    renderPanel({
      activeSession: { ...errorSession, status: 'idle', error: undefined },
      actionError: 'Could not send message'
    })
    expect(errorBoxText()).toContain('Could not send message')
    expect(reportButton()).toBeNull()
  })

  it('shows both a transient actionError and the run failure, keeping the Report button', () => {
    // Both present: each error gets its own row, and the run failure keeps its report entry — a
    // transient error must not suppress the ability to report the actual failure.
    renderPanel({ activeSession: errorSession, actionError: 'Could not send message' })
    const text = errorBoxText()
    expect(text).toContain('Could not send message')
    expect(text).toContain('Run failed: connection reset')
    expect(reportButton()).not.toBeNull()
  })

  it('opens the report dialog when the Report button is clicked', () => {
    renderPanel({ activeSession: errorSession })
    act(() => {
      reportButton()?.click()
    })
    // Dialog renders into a portal on document.body.
    const title = Array.from(document.body.querySelectorAll('*')).find(
      (el) => el.textContent === 'Report this error' && el.children.length === 0
    )
    expect(title).toBeTruthy()
  })

  it('seeds the dialog with the same fallback text the box shows when a run has no error', () => {
    // shown == reported: the textarea the user reviews must carry the exact string shown in the box.
    renderPanel({ activeSession: { ...errorSession, error: undefined } })
    const shown = errorBoxText()
    act(() => {
      reportButton()?.click()
    })
    const textarea = document.body.querySelector(
      'textarea[aria-label="Error details"]'
    ) as HTMLTextAreaElement | null
    expect(textarea?.value).toBe('The run failed with no error message.')
    expect(shown).toContain(textarea?.value ?? '')
  })

  it('uses the shared fallback for a whitespace-only persisted error', () => {
    renderPanel({ activeSession: { ...errorSession, error: '   ' } })
    expect(errorBoxText()).toContain('The run failed with no error message.')

    act(() => {
      reportButton()?.click()
    })

    const textarea = document.body.querySelector(
      'textarea[aria-label="Error details"]'
    ) as HTMLTextAreaElement | null
    expect(textarea?.value).toBe('The run failed with no error message.')
  })

  it('hides the Report button for an app-crafted, actionable failure', () => {
    // A recognized failure keeps its message but is not a bug worth a GitHub issue.
    renderPanel({
      activeSession: {
        ...errorSession,
        error: 'Session workspace is missing; start a new conversation.'
      }
    })
    expect(errorBoxText()).toContain('Session workspace is missing')
    expect(reportButton()).toBeNull()
  })

  it('hides the Report button for a model-provider error (tagged non-reportable at the ACP layer)', () => {
    // A provider/model failure is tagged structurally (errorReportable: false), not by its text —
    // the raw provider message is kept visible but is not a bug worth a GitHub issue.
    renderPanel({
      activeSession: {
        ...errorSession,
        error: 'Invalid API key',
        errorReportable: false
      }
    })
    expect(errorBoxText()).toContain('Invalid API key')
    expect(reportButton()).toBeNull()
  })

  it('shows the Report button when a persisted error predates the reportable flag (undefined)', () => {
    // Old sessions have no errorReportable; fall back to classifying the text — an opaque failure
    // stays reportable, an app-crafted reminder does not.
    renderPanel({
      activeSession: {
        ...errorSession,
        error: 'Run failed: connection reset',
        errorReportable: undefined
      }
    })
    expect(reportButton()).not.toBeNull()
  })
})
