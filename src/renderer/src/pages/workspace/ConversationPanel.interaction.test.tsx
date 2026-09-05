// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationPanel } from './ConversationPanel'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'
import { subscribeAnnotationReveal } from './annotations/annotation-reveal'
import { emptyDoc, type ComposerDoc } from './composer/composer-doc'

import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import type { DelegatedQuestionRequest } from '../../../../shared/session-persistence'
import { VISION_MODEL_NOT_CONFIGURED_MESSAGE } from '../../../../shared/run-error-classification'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'

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
  DropdownMenuSub: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    ...rest
  }: PropsWithChildren<{ 'data-testid'?: string }>): React.JSX.Element => (
    <div {...rest}>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
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
  TooltipTrigger: ({
    children,
    onFocus
  }: PropsWithChildren<{
    onFocus?: (event: React.FocusEvent<HTMLElement>) => void
  }>): React.JSX.Element => (onFocus ? <span onFocus={onFocus}>{children}</span> : <>{children}</>),
  TooltipContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

vi.mock('./ComposerModelPicker', () => ({
  ComposerModelPicker: (): React.JSX.Element => (
    <button type="button" data-testid="mock-model-picker">
      Model
    </button>
  )
}))

vi.mock('./ComposerAgentControlsMenu', () => ({
  ComposerAgentControlsMenu: (props: {
    readOnly?: boolean
    memoryReadOnly?: boolean
    delegationReadOnly?: boolean
    delegationHasLiveAttempts?: boolean
    delegationDisabledReason?: string
    autoReviewReadOnly?: boolean
    permissionProfileReadOnly?: boolean
    grantActionsReadOnly?: boolean
    autoReviewDisabled?: boolean
    specialistReadOnly?: boolean
    openRequest?: number
  }): React.JSX.Element => (
    <button
      type="button"
      data-testid="mock-agent-controls"
      data-read-only={String(props.readOnly === true)}
      data-memory-read-only={String(props.memoryReadOnly)}
      data-delegation-read-only={String(props.delegationReadOnly)}
      data-delegation-live={String(props.delegationHasLiveAttempts)}
      data-delegation-disabled-reason={props.delegationDisabledReason}
      data-auto-review-read-only={String(props.autoReviewReadOnly)}
      data-permission-read-only={String(props.permissionProfileReadOnly === true)}
      data-grants-read-only={String(props.grantActionsReadOnly === true)}
      data-auto-review-disabled={String(props.autoReviewDisabled === true)}
      data-specialist-read-only={String(props.specialistReadOnly)}
      data-open-request={props.openRequest ?? 0}
    >
      Agent controls
    </button>
  )
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
  WorkspaceMessageScroller: ({
    credentialPending,
    isResumingSession,
    visiblePermissionPending,
    pendingElicitations = []
  }: {
    credentialPending?: boolean
    isResumingSession?: boolean
    visiblePermissionPending?: boolean
    pendingElicitations?: unknown[]
  }): React.JSX.Element => (
    <>
      {isResumingSession ? (
        <span data-testid="resume-progress-indicator">Resuming session</span>
      ) : null}
      <span data-testid="scroller-pending-elicitations">{pendingElicitations.length}</span>
      <span data-testid="scroller-credential-pending">{String(credentialPending ?? false)}</span>
      <span data-testid="scroller-visible-permission-pending">
        {String(visiblePermissionPending ?? false)}
      </span>
    </>
  )
}))

vi.mock('./PermissionApprovalControls', () => ({
  PermissionApprovalControls: ({ requests }: { requests: unknown[] }): React.JSX.Element | null =>
    requests.length > 0 ? <span data-testid="permission-approval-controls" /> : null
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

const delegatedQuestionSession = (): ChatSession => ({
  id: 'session-delegated-question',
  projectId: 'project-a',
  title: 'Delegated question',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  activities: [],
  createdAt: 1,
  updatedAt: 3,
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root',
    activeFrameId: 'root',
    frames: [
      {
        id: 'root',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'root-branch',
        createdAt: 1
      },
      {
        id: 'child',
        parentFrameId: 'root',
        originMessageId: 'root-prompt',
        originBindingState: 'validated',
        kind: 'delegate',
        delegateName: 'Researcher',
        status: 'completed',
        activeBranchId: 'child-branch',
        createdAt: 2
      }
    ],
    branches: [
      {
        id: 'root-branch',
        agentFrameId: 'root',
        headMessageId: 'root-prompt',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-branch',
        agentFrameId: 'child',
        headMessageId: 'child-message',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    messages: [
      {
        id: 'root-prompt',
        role: 'user',
        content: 'Research this topic',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'root',
        introducedOnBranchId: 'root-branch',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-message',
        role: 'agent',
        content: 'I need one detail.',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'child',
        introducedOnBranchId: 'child-branch',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: []
  },
  runtimeContext: {
    version: 1,
    revision: 1,
    delegatedWork: {
      records: [],
      questionRequests: [
        {
          requestId: 'question-1',
          canonicalDigest: 'a'.repeat(64),
          sourceFrameId: 'child',
          sourceAttemptId: 'attempt-1',
          sourceRuntimeSegmentId: 'runtime-1',
          sourceMessageBranchId: 'child-branch',
          rootOriginMessageId: 'root-prompt',
          rootBranchId: 'root-branch',
          sourceName: 'Researcher',
          questions: [
            { question: 'Which scope?', options: [{ label: 'Narrow' }, { label: 'Broad' }] }
          ],
          sequence: 1,
          askedAt: 2,
          status: 'pending',
          draftAnswers: [],
          draftQuestionIndex: 0
        }
      ]
    }
  }
})

describe('ConversationPanel annotation composer integration', () => {
  it('renders a compact annotation chip, reveals its source, returns focus on Esc, and removes it', async () => {
    const removeAnnotation = vi.fn()
    renderPanel({
      composer: {
        view: {
          annotations: [
            {
              id: 'annotation-1',
              kind: 'text',
              target: 'agent',
              quote: 'Quoted Agent evidence',
              note: 'Explain this evidence.',
              source: {
                kind: 'agent-message',
                sessionId: 'session-1',
                messageId: 'message-1'
              }
            }
          ]
        },
        actions: { removeAnnotation }
      }
    })

    const card = container.querySelector('[aria-label="Annotations for Agent"]')
    const chip = card?.querySelector('[data-annotation-draft-chip]')
    const chipBody = chip?.querySelector<HTMLButtonElement>('[data-annotation-quote]')
    expect(chipBody?.querySelector('span')?.textContent).toBe('Explain this evidence.')
    expect(chip?.getAttribute('data-annotation-hover-label')).toBe(
      'Explain this evidence. - Agent Message'
    )

    // The draft cards live INSIDE the composer input card, above the editor —
    // like the attachments strip — not above the composer box.
    const form = container.querySelector('[data-testid="ordinary-composer-form"]')
    expect(form).not.toBeNull()
    expect(form?.contains(card!)).toBe(true)

    // The compact label shows the note; its body still reveals the quoted
    // source through the cross-surface annotation reveal seam.
    const reveal = vi.fn()
    const unsubscribe = subscribeAnnotationReveal(reveal)
    await act(async () => chipBody?.click())
    expect(reveal).toHaveBeenCalledWith('annotation-1')
    unsubscribe()

    const edit = card?.querySelector<HTMLButtonElement>('[aria-label="Edit annotation note"]')
    await act(async () => edit?.click())
    const note = document.body.querySelector<HTMLTextAreaElement>(
      '[data-annotation-note-editor] textarea[id^="edit-annotation-"]'
    )
    expect(note).not.toBeNull()
    expect(chip?.contains(note ?? null)).toBe(false)
    await act(async () => {
      note?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(edit)

    act(() => {
      card?.querySelector<HTMLButtonElement>('[aria-label="Remove annotation"]')?.click()
    })
    expect(removeAnnotation).toHaveBeenCalledWith('annotation-1')
  })
})

type PanelProps = Parameters<typeof ConversationPanel>[0]
type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends readonly unknown[]
    ? T[Key]
    : T[Key] extends (...args: infer Args) => infer Result
      ? (...args: Args) => Result
      : T[Key] extends object
        ? DeepPartial<T[Key]>
        : T[Key]
}

type DraftSubmitCallbacks = {
  send?: (forcedSkillIds: string[]) => void
  planFirst?: (forcedSkillIds: string[]) => void
  branch?: (forcedSkillIds: string[]) => void
  reconfigure?: () => void
}

const routeDraftSubmit =
  ({
    send = vi.fn(),
    planFirst = vi.fn(),
    branch = vi.fn(),
    reconfigure = vi.fn()
  }: DraftSubmitCallbacks): PanelProps['conversation']['actions']['submit']['draft'] =>
  ({ forcedSkillIds, mode = 'continue' }): void => {
    if (mode === 'plan-first') planFirst(forcedSkillIds)
    else if (mode === 'branch') branch(forcedSkillIds)
    else if (mode === 'retry-reconfigure') reconfigure()
    else send(forcedSkillIds)
  }

const createPanelDefaults = (): PanelProps => ({
  view: {
    activeSession: undefined,
    canEditDraft: true,
    actionError: null
  },
  composer: {
    view: {
      doc: emptyDoc,
      annotations: [],
      attachments: [],
      transfers: [],
      error: null,
      historyStatus: '',
      isHistoryBrowsing: false,
      isUploading: false,
      caretRequest: undefined,
      readingContext: {
        bindings: [],
        pendingBindingId: undefined,
        isPending: false,
        automaticAttachmentCount: 0
      }
    },
    actions: {
      changeDoc: vi.fn(),
      addAnnotation: vi.fn(),
      updateAnnotationNote: vi.fn(),
      removeAnnotation: vi.fn(),
      navigateHistory: vi.fn(() => false),
      stageFiles: onStageAttachmentFiles,
      stagePastedText: vi.fn(),
      cancelTransfer: vi.fn(),
      removeAttachment: vi.fn(),
      restorePastedText: vi.fn(),
      undo: vi.fn(() => false),
      redo: vi.fn(() => false),
      setError: vi.fn(),
      linkReadingContext: vi.fn().mockResolvedValue(undefined),
      openReadingContext: vi.fn(),
      unlinkReadingContext: vi.fn(),
      dismissAutomaticReading: vi.fn()
    }
  },
  conversation: {
    optimisticMessage: undefined,
    planProjectionRecoveryError: false,
    availability: {
      submit: false,
      submitMode: undefined,
      revise: true,
      resume: true,
      branch: true
    },
    actions: {
      submit: {
        draft: vi.fn(),
        restoredPlan: vi.fn().mockResolvedValue(undefined)
      },
      revise: vi.fn(),
      branch: vi.fn(),
      sideChat: { start: vi.fn() },
      resume: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
      delete: vi.fn()
    },
    queue: {
      items: [],
      announcement: '',
      hasPendingWork: false,
      actions: {
        move: vi.fn(),
        moveTo: vi.fn(),
        remove: vi.fn(),
        edit: vi.fn(),
        sendNow: vi.fn().mockResolvedValue(undefined)
      }
    },
    admitApplicationMessage: vi.fn().mockResolvedValue(undefined)
  },
  sideChat: {
    view: undefined,
    start: vi.fn().mockResolvedValue(false),
    send: vi.fn().mockResolvedValue(false),
    setDraft: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn()
  },
  specialist: {
    view: {
      specialist: {
        newConversationId: undefined,
        historyId: undefined,
        unavailable: false,
        hasPendingSwitch: false,
        barrierInFlight: false,
        sendAvailable: true,
        reconfigureError: null
      }
    },
    actions: {
      selectSpecialist: vi.fn(),
      retrySpecialistSelection: vi.fn(() => false),
      chooseOtherSpecialist: vi.fn(),
      useMainAgent: vi.fn()
    }
  },
  layout: {
    isPreviewPanelCollapsed: false,
    togglePreviewPanel: vi.fn(),
    openSidebar: vi.fn()
  },
  permissions: {
    requests: [],
    credentialRequests: [],
    permissionProfile: 'ask',
    permissionProfileState: undefined,
    permissionGrants: [],
    canChangePermissionProfile: true,
    respond: vi.fn(),
    changeProfile: vi.fn(),
    revokeGrant: vi.fn(),
    clearGrants: vi.fn()
  },
  elicitation: {
    requests: [],
    respond: vi.fn()
  },
  agentControls: {
    canChange: true,
    canChangeAutoReview: true,
    canChangeMemory: true,
    canChangeSpecialist: true,
    autoReviewEnabled: true,
    enabledComputeHosts: [],
    selectedComputeHosts: [],
    toggleAutoReview: vi.fn(),
    setComputeHostEnabled: vi.fn(),
    setComputeHostSelected: vi.fn()
  },
  contextWindow: {
    usage: undefined,
    canCompact: false,
    compactDisabledReason: '',
    compact: vi.fn()
  },
  workflows: {
    artifactFinalization: {
      running: false,
      request: vi.fn()
    },
    review: {
      disabled: false,
      running: false,
      request: vi.fn()
    },
    saveAsSkill: {
      disabled: false,
      running: false,
      request: vi.fn()
    }
  },
  sessionTools: {
    notebookReference: undefined,
    openNotebook: vi.fn(),
    openJobs: vi.fn()
  },
  subagents: {
    stop: vi.fn()
  }
})

const mergePanelProps = (defaults: PanelProps, overrides: DeepPartial<PanelProps>): PanelProps => {
  const merge = (base: unknown, override: unknown): unknown => {
    if (override === undefined) return base
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
      return override
    }
    const baseRecord =
      base !== null && typeof base === 'object' && !Array.isArray(base)
        ? (base as Record<string, unknown>)
        : {}
    const merged: Record<string, unknown> = { ...baseRecord }
    for (const [key, value] of Object.entries(override)) {
      merged[key] = merge(baseRecord[key], value)
    }
    return merged
  }

  return merge(defaults, overrides) as PanelProps
}

const renderPanel = (props: DeepPartial<PanelProps> = {}): void => {
  const panelProps = mergePanelProps(createPanelDefaults(), props)
  act(() => {
    root.render(<ConversationPanel {...panelProps} />)
  })
}

const getComposerForm = (): HTMLElement => {
  const form = container.querySelector('[data-testid="ordinary-composer-form"]')
  if (!form) throw new Error('composer form not found')
  return form as HTMLElement
}

const expectComposerCoveredByBlockingOverlay = (): void => {
  const form = getComposerForm()
  expect(form.hidden).toBe(false)
  expect(form.getAttribute('aria-hidden')).toBe('true')
  expect(form.hasAttribute('inert')).toBe(true)
  expect(form.classList.contains('invisible')).toBe(true)
  expect(form.classList.contains('pointer-events-none')).toBe(true)

  const overlay = container.querySelector('[data-testid="blocking-composer-overlay"]')
  expect(overlay).not.toBeNull()
  expect(overlay?.classList.contains('absolute')).toBe(true)
  expect(overlay?.classList.contains('bottom-0')).toBe(true)
}

const expectComposerChromeCovered = (selector: string): void => {
  const element = container.querySelector(selector)
  expect(element).not.toBeNull()
  const chrome = element?.closest('[aria-hidden="true"]')
  expect(chrome?.hasAttribute('inert')).toBe(true)
  expect(chrome?.classList.contains('invisible')).toBe(true)
  expect(chrome?.classList.contains('pointer-events-none')).toBe(true)
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
    const messageButton = getConversationHeader().querySelector<HTMLButtonElement>(
      '[aria-label^="Messages,"]'
    )
    expect(messageButton).not.toBeNull()
    expect(messageButton?.className.split(' ')).toContain('md:hidden')
    const surfaceFade = container.querySelector('[data-testid="composer-surface-fade"]')
    expect(surfaceFade?.classList.contains('-top-12')).toBe(true)
    expect(surfaceFade?.classList.contains('h-12')).toBe(true)
  })
})

describe('ConversationPanel composer errors', () => {
  it('uses the shared ErrorNotice with the semantic failure tone', () => {
    renderPanel({ composer: { view: { error: 'Annotation payload is too large.' } } })

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Annotation payload is too large.')
    expect(alert?.querySelector('section')).not.toBeNull()
    expect(alert?.querySelector('.bg-status-failure-surface')).not.toBeNull()
    expect(alert?.className).not.toContain('bg-red-50')
  })

  it('offers an immediate retry when Artifact publication fails', () => {
    const request = vi.fn()
    const pendingPath = '/data/artifacts/project-a/artifact-session-1/.pending/run-1/report.md'
    const activeSession: ChatSession = {
      id: 'session-artifact-retry',
      projectId: 'project-a',
      title: 'Artifact retry',
      cwd: '/workspace',
      status: 'error',
      error: 'Generated file finalization failed: disk temporarily unavailable',
      errorReportable: true,
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'Created the report.',
          status: 'complete',
          eventIds: ['artifact-event-1'],
          artifactIds: ['artifact-session-1:run-1:report.md'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      artifacts: [
        {
          id: 'artifact-session-1:run-1:report.md',
          kind: 'managed-file',
          name: 'report.md',
          path: pendingPath,
          fileUrl: `file://${pendingPath}`,
          size: 10,
          mtimeMs: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }

    renderPanel({
      view: { activeSession },
      workflows: { artifactFinalization: { request } }
    })

    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry Artifact publication"]'
    )
    const report = container.querySelector<HTMLButtonElement>('[aria-label="Report this error"]')
    const error = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === activeSession.error
    )
    expect(retry).not.toBeNull()
    expect(report).not.toBeNull()
    expect(error?.parentElement?.classList.contains('flex-col')).toBe(true)
    expect(retry?.parentElement?.classList.contains('flex-wrap')).toBe(true)
    expect(retry?.parentElement?.classList.contains('self-end')).toBe(true)
    act(() => retry?.click())
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not offer retry when Artifact provenance proof is invalid', () => {
    const activeSession: ChatSession = {
      id: 'session-artifact-invalid-proof',
      projectId: 'project-a',
      title: 'Artifact proof failure',
      cwd: '/workspace',
      status: 'error',
      error:
        'Generated file finalization cannot be retried: Artifact run claim is missing complete provenance context.',
      errorReportable: true,
      messages: [],
      createdAt: 1,
      updatedAt: 2
    }

    renderPanel({ view: { activeSession } })

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Retry Artifact publication"]')
    ).toBeNull()
  })
})

describe('ConversationPanel session loading presentation', () => {
  it('replaces the transcript with a skeleton until lazy Session content is hydrated', () => {
    const loadingSession: ChatSession = {
      id: 'session-loading',
      projectId: 'project-a',
      title: 'Loading conversation',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      contentLoaded: false,
      activeMessageCount: 12,
      createdAt: 1,
      updatedAt: 2
    }

    renderPanel({ view: { activeSession: loadingSession } })

    expect(container.querySelector('[data-testid="session-switch-skeleton"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="scroller-pending-elicitations"]')).toBeNull()

    renderPanel({
      view: {
        activeSession: {
          ...loadingSession,
          contentLoaded: undefined,
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Loaded content',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        }
      }
    })

    expect(container.querySelector('[data-testid="session-switch-skeleton"]')).toBeNull()
    expect(container.querySelector('[data-testid="scroller-pending-elicitations"]')).not.toBeNull()
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
  useSettingsStore.setState(createInitialSettingsState())
  useSpecialistStore.setState({ items: [], isLoaded: true })
  mockHasRunningJobs = false
  mockAllJobs = []
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  container.remove()
})

describe('ConversationPanel Specialist reconfigure recovery', () => {
  const activeSession: ChatSession = {
    id: 'session-specialist-retry',
    projectId: 'project-a',
    title: 'Specialist retry',
    cwd: '/workspace',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }

  const clickRetry = (): void => {
    const banner = container.querySelector('[data-testid="reconfigure-error-banner"]')
    const retryButton = Array.from(banner?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Retry'
    )
    act(() => retryButton?.click())
  }

  const errorView = {
    sessionId: activeSession.id,
    specialistName: 'Specialist B',
    message: 'switch rejected',
    committed: false
  }

  it('retries an idle Specialist selection without submitting the draft', () => {
    const retrySpecialistSelection = vi.fn(() => true)
    const retryDraftReconfigure = vi.fn()
    renderPanel({
      view: { activeSession },
      specialist: {
        view: { specialist: { reconfigureError: errorView } },
        actions: { retrySpecialistSelection }
      },
      conversation: {
        actions: {
          submit: { draft: routeDraftSubmit({ reconfigure: retryDraftReconfigure }) }
        }
      }
    })

    const banner = container.querySelector('[data-testid="reconfigure-error-banner"]')
    expect(banner?.textContent).toContain('Could not switch to Specialist B')
    clickRetry()

    expect(retrySpecialistSelection).toHaveBeenCalledOnce()
    expect(retryDraftReconfigure).not.toHaveBeenCalled()
  })

  it('keeps send-barrier Retry routed through draft submission', () => {
    const retrySpecialistSelection = vi.fn(() => false)
    const retryDraftReconfigure = vi.fn()
    renderPanel({
      view: { activeSession },
      specialist: {
        view: { specialist: { reconfigureError: errorView } },
        actions: { retrySpecialistSelection }
      },
      conversation: {
        actions: {
          submit: { draft: routeDraftSubmit({ reconfigure: retryDraftReconfigure }) }
        }
      }
    })

    clickRetry()

    expect(retrySpecialistSelection).toHaveBeenCalledOnce()
    expect(retryDraftReconfigure).toHaveBeenCalledOnce()
  })
})

describe('ConversationPanel composer intake', () => {
  it('previews automatic Reading before send and keeps the PDF attached when dismissed', () => {
    const dismissAutomaticReading = vi.fn()
    renderPanel({
      composer: {
        view: {
          attachments: [
            {
              id: 'upload-1',
              sessionId: '.pending',
              name: 'paper.pdf',
              originalName: 'paper.pdf',
              path: '/uploads/.pending/paper.pdf',
              mimeType: 'application/pdf',
              size: 42
            }
          ],
          readingContext: { automaticAttachmentCount: 1 }
        },
        actions: { dismissAutomaticReading }
      }
    })

    const suggestion = container.querySelector('[data-testid="automatic-reading-suggestion"]')
    expect(suggestion?.textContent).toContain('Reading')
    expect(suggestion?.textContent).toContain('1 PDF will be linked when sent')
    expect(container.textContent).toContain('paper.pdf')

    act(() =>
      suggestion?.querySelector<HTMLButtonElement>('[aria-label="Keep as attachments"]')?.click()
    )
    expect(dismissAutomaticReading).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('paper.pdf')
  })

  it('shows automatic Reading follow-ups alongside linked PDF context', () => {
    const dismissAutomaticReading = vi.fn()
    renderPanel({
      view: {
        activeSession: {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Reading session',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      },
      composer: {
        view: {
          readingContext: {
            bindings: [
              {
                version: 1,
                bindingId: 'binding-1',
                sourceKind: 'artifact-version',
                sourceFileId: 'artifact-1',
                sourceVersionId: 'version-1',
                sourceSessionId: 'source-session',
                name: 'first.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 12,
                checksum: 'checksum-1',
                linkedAt: 1
              }
            ],
            automaticAttachmentCount: 1
          }
        },
        actions: { dismissAutomaticReading }
      }
    })

    expect(container.querySelector('[data-testid="pdf-context-bar"]')).not.toBeNull()
    const suggestion = container.querySelector('[data-testid="automatic-reading-suggestion"]')
    expect(suggestion?.textContent).toContain('1 PDF will be linked when sent')
    act(() =>
      suggestion?.querySelector<HTMLButtonElement>('[aria-label="Keep as attachments"]')?.click()
    )
    expect(dismissAutomaticReading).toHaveBeenCalledOnce()
  })

  it('shows linked PDF context as a single-line chip that opens its preview', () => {
    const open = vi.fn()
    const unlink = vi.fn()
    renderPanel({
      view: {
        activeSession: {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Reading session',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      },
      composer: {
        view: {
          readingContext: {
            bindings: [
              {
                version: 1,
                bindingId: 'binding-1',
                sourceKind: 'artifact-version',
                sourceFileId: 'artifact-1',
                sourceVersionId: 'version-1',
                sourceSessionId: 'source-session',
                name: 'paper.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 12,
                checksum: 'checksum-1',
                linkedAt: 1
              },
              {
                version: 1,
                bindingId: 'binding-2',
                sourceKind: 'upload-version',
                sourceFileId: 'upload-2',
                sourceVersionId: 'version-2',
                sourceSessionId: 'source-session',
                name: 'second.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 13,
                checksum: 'checksum-2',
                linkedAt: 2
              },
              {
                version: 1,
                bindingId: 'binding-3',
                sourceKind: 'upload-version',
                sourceFileId: 'upload-3',
                sourceVersionId: 'version-3',
                sourceSessionId: 'source-session',
                name: 'third.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 14,
                checksum: 'checksum-3',
                linkedAt: 3
              }
            ],
            pendingBindingId: undefined,
            isPending: false
          }
        },
        actions: { openReadingContext: open, unlinkReadingContext: unlink }
      }
    })

    const bar = container.querySelector('[data-testid="pdf-context-bar"]')
    expect(bar?.className.split(/\s+/)).toContain('rounded-t-2xl')
    expect(bar?.textContent).toContain('Reading')
    expect(bar?.textContent).toContain('paper.pdf')
    expect(bar?.textContent).toContain('second.pdf')
    expect(bar?.textContent).toContain('third.pdf')
    expect(bar?.querySelector('[aria-label="Choose PDFs for Reading"]')).not.toBeNull()
    expect(bar?.querySelectorAll('[aria-label^="Open PDF context "]')).toHaveLength(3)
    // The page-position line is gone: the disclosure moved to the chip's tooltip.
    expect(bar?.textContent).not.toContain('Page')
    expect(bar?.textContent).not.toContain('Open the PDF')
    expect(bar?.textContent).toContain(
      'Linked to this conversation. The Agent reads only the pages needed for your question.'
    )
    const openButton = bar?.querySelector<HTMLButtonElement>(
      '[aria-label="Open PDF context paper.pdf"]'
    )
    act(() => openButton?.click())
    expect(open).toHaveBeenCalledWith('binding-1')

    const remove = bar?.querySelector<HTMLButtonElement>(
      '[aria-label="Remove PDF context paper.pdf"]'
    )
    expect(remove?.disabled).toBe(false)
    act(() => remove?.click())
    expect(unlink).toHaveBeenCalledWith('binding-1')
  })

  it('disables PDF context removal while the command is pending', () => {
    renderPanel({
      composer: {
        view: {
          readingContext: {
            bindings: [
              {
                version: 1,
                bindingId: 'binding-1',
                sourceKind: 'upload-version',
                sourceFileId: 'upload-1',
                sourceVersionId: 'version-1',
                sourceSessionId: 'source-session',
                name: 'paper.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 12,
                checksum: 'checksum-1',
                linkedAt: 1
              }
            ],
            pendingBindingId: 'binding-1',
            isPending: true
          }
        },
        actions: { openReadingContext: vi.fn() }
      }
    })

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Remove PDF context paper.pdf"]')
        ?.disabled
    ).toBe(true)
  })

  it('focuses the ordinary composer when the draft context changes', () => {
    renderPanel({
      view: {
        composerFocusKey: 'session-a'
      }
    })
    expect(document.activeElement).toBe(getComposerEditor())

    const navigationButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open navigation"]'
    )!
    navigationButton.focus()
    expect(document.activeElement).toBe(navigationButton)

    renderPanel({
      view: {
        composerFocusKey: 'session-b'
      }
    })
    expect(document.activeElement).toBe(getComposerEditor())
  })

  it('focuses the composer when a preview surface requests it', () => {
    renderPanel({
      view: {
        composerFocusKey: 'session-a'
      }
    })
    expect(document.activeElement).toBe(getComposerEditor())

    const navigationButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open navigation"]'
    )!
    navigationButton.focus()
    expect(document.activeElement).toBe(navigationButton)

    act(() => {
      window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT))
    })
    expect(document.activeElement).toBe(getComposerEditor())
  })

  it('does not focus the hidden composer while a blocking interaction owns its lane', () => {
    renderPanel({
      view: {
        composerFocusKey: 'session-a'
      }
    })
    const navigationButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open navigation"]'
    )!
    navigationButton.focus()

    renderPanel({
      view: {
        composerFocusKey: 'session-blocked'
      },
      permissions: {
        requests: [{ requestId: 'permission-focus' } as never]
      }
    })

    expectComposerCoveredByBlockingOverlay()
    expect(document.activeElement).toBe(navigationButton)
  })

  it('does not refocus the composer when draft editing becomes available', () => {
    renderPanel({
      view: {
        composerFocusKey: 'session-preparing',
        canEditDraft: false
      }
    })
    const navigationButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open navigation"]'
    )!
    navigationButton.focus()

    renderPanel({
      view: {
        composerFocusKey: 'session-preparing',
        canEditDraft: true
      }
    })

    expect(document.activeElement).toBe(navigationButton)
  })

  it('keeps the Main composer available while a delegated question is pending', () => {
    renderPanel({
      view: {
        activeSession: delegatedQuestionSession()
      },
      conversation: {
        availability: {
          submit: true
        }
      }
    })

    expect(container.textContent).toContain('Asked by Researcher')
    expect(container.textContent).toContain('Which scope?')
    expect(getComposerEditor().getAttribute('contenteditable')).toBe('true')
    expect(getComposerForm().contains(getComposerEditor())).toBe(true)
  })

  it('keeps delegated Permission in the transcript without taking the main Composer lane', () => {
    const activeSession: ChatSession = {
      id: 'session-delegated-permission',
      projectId: 'project-a',
      title: 'Delegated permission',
      cwd: '/workspace',
      status: 'waiting-permission',
      interactionState: { permission: true, elicitation: false, plan: false },
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    renderPanel({
      view: { activeSession },
      conversation: { availability: { submit: true } },
      permissions: {
        requests: [
          {
            requestId: 'permission-delegated',
            sessionId: activeSession.id,
            toolCallId: 'tool-delegated',
            title: 'Run delegated command',
            options: [],
            delegated: {
              frameId: 'child-frame',
              attemptId: 'attempt-1',
              childTitle: 'Researcher',
              riskScope: 'This call only'
            }
          }
        ]
      }
    })

    expect(container.querySelector('[data-testid="permission-composer"]')).toBeNull()
    expect(container.querySelector('[data-testid="permission-approval-controls"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="scroller-visible-permission-pending"]')?.textContent
    ).toBe('true')
    expect(getComposerForm().hidden).toBe(false)
    expect(getComposerEditor().getAttribute('contenteditable')).toBe('true')
  })

  it('advances to the next Subagent request after Finish and removes an empty queue', async () => {
    const firstSession = delegatedQuestionSession()
    const graph = firstSession.conversationGraph!
    graph.frames.push({
      id: 'child-two',
      parentFrameId: 'root',
      originMessageId: 'root-prompt',
      originBindingState: 'validated',
      kind: 'delegate',
      delegateName: 'Reviewer',
      status: 'completed',
      activeBranchId: 'child-two-branch',
      createdAt: 3
    })
    graph.branches.push({
      id: 'child-two-branch',
      agentFrameId: 'child-two',
      headMessageId: 'child-two-message',
      createdAt: 3,
      updatedAt: 3
    })
    graph.messages.push({
      id: 'child-two-message',
      role: 'agent',
      content: 'I need the result format.',
      status: 'complete',
      eventIds: [],
      agentFrameId: 'child-two',
      introducedOnBranchId: 'child-two-branch',
      createdAt: 3,
      updatedAt: 3
    })
    const secondRequest: DelegatedQuestionRequest = {
      requestId: 'question-2',
      canonicalDigest: 'b'.repeat(64),
      sourceFrameId: 'child-two',
      sourceAttemptId: 'attempt-2',
      sourceRuntimeSegmentId: 'runtime-2',
      sourceMessageBranchId: 'child-two-branch',
      rootOriginMessageId: 'root-prompt',
      rootBranchId: 'root-branch',
      sourceName: 'Reviewer',
      questions: [
        { question: 'Which format?', options: [{ label: 'Narrative' }, { label: 'Table' }] }
      ],
      sequence: 2,
      askedAt: 3,
      status: 'pending',
      draftAnswers: [],
      draftQuestionIndex: 0
    }
    Object.assign(firstSession, {
      runtimeContext: {
        ...firstSession.runtimeContext!,
        delegatedWork: {
          ...firstSession.runtimeContext!.delegatedWork!,
          questionRequests: [
            ...firstSession.runtimeContext!.delegatedWork!.questionRequests!,
            secondRequest
          ]
        }
      }
    })
    const onRespondToElicitation = vi.fn().mockResolvedValue(undefined)
    const buttonNamed = (name: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === name
      )

    renderPanel({
      view: {
        activeSession: firstSession
      },
      elicitation: {
        respond: onRespondToElicitation
      }
    })
    expect(container.textContent).toContain('Asked by Researcher')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Narrow"]')?.click()
    )
    await act(async () => buttonNamed('Finish')?.click())
    expect(onRespondToElicitation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: 'question-1',
        delegatedQuestion: expect.objectContaining({ action: 'confirm' })
      })
    )

    const secondSession = structuredClone(firstSession)
    Object.assign(secondSession, {
      runtimeContext: {
        ...secondSession.runtimeContext!,
        delegatedWork: {
          ...secondSession.runtimeContext!.delegatedWork!,
          questionRequests: secondSession.runtimeContext!.delegatedWork!.questionRequests!.slice(1)
        }
      }
    })
    renderPanel({
      view: {
        activeSession: secondSession
      },
      elicitation: {
        respond: onRespondToElicitation
      }
    })
    expect(container.textContent).toContain('Asked by Reviewer')
    expect(container.textContent).toContain('Which format?')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Narrative"]')?.click()
    )
    await act(async () => buttonNamed('Finish')?.click())
    expect(onRespondToElicitation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: 'question-2',
        delegatedQuestion: expect.objectContaining({ action: 'confirm' })
      })
    )

    const emptySession = structuredClone(secondSession)
    Object.assign(emptySession, {
      runtimeContext: {
        ...emptySession.runtimeContext!,
        delegatedWork: {
          ...emptySession.runtimeContext!.delegatedWork!,
          questionRequests: []
        }
      }
    })
    renderPanel({
      view: {
        activeSession: emptySession
      },
      elicitation: {
        respond: onRespondToElicitation
      }
    })
    expect(container.querySelector('[data-testid="delegated-question-card"]')).toBeNull()
  })

  it.each([
    ['darwin', '⌘K'],
    ['win32', 'Ctrl+K'],
    ['linux', 'Ctrl+K']
  ])('shows the %s global-search shortcut in the placeholder', (platform, shortcut) => {
    const previousApi = window.api
    window.api = { platform } as Window['api']

    renderPanel()

    expect(getComposerEditor().getAttribute('data-placeholder')).toBe(
      `Ask anything — / skills · @ files · # sessions · ${shortcut} search · ↑↓ history`
    )
    window.api = previousApi
  })

  it('shows structured input in a content-bounded lane without notebook chrome', () => {
    const fields = [
      {
        id: 'question_0',
        label: 'Skill type',
        kind: 'single-select' as const,
        options: [
          { value: 'integration', label: 'Multi-omics integration' },
          { value: 'clinical', label: 'Clinical statistics' }
        ]
      },
      {
        id: 'question_0_custom',
        label: 'Other',
        kind: 'text' as const
      }
    ]
    const activeSession: ChatSession = {
      id: 'session-elicitation',
      projectId: 'project-a',
      title: 'Structured input',
      cwd: '/workspace',
      status: 'running',
      messages: [],
      activities: [
        {
          id: 'tool-ask-1',
          kind: 'tool',
          title: 'AskUserQuestion',
          status: 'in_progress',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1,
          updatedAt: 1,
          elicitation: {
            message: 'What kind of skill are you trying to create?',
            fields,
            state: 'pending'
          }
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    mockAllJobs = [{ job_id: 'job-1', status: 'done', created_at: 1 }]
    renderPanel({
      view: {
        activeSession: activeSession
      },
      sessionTools: {
        notebookReference: {
          sessionId: activeSession.id,
          projectId: activeSession.projectId,
          workspaceCwd: '/workspace',
          notebookSessionRoot: '/notebook',
          dataRoot: '/data',
          runtimeRoot: '/runtime',
          runJsonPath: '/notebook/run.json'
        }
      },
      elicitation: {
        requests: [
          {
            requestId: 'elicitation-1',
            sessionId: activeSession.id,
            toolCallId: 'tool-ask-1',
            message: 'What kind of skill are you trying to create?',
            fields
          }
        ]
      }
    })

    const elicitationComposer = container.querySelector('[data-testid="elicitation-composer"]')
    expect(elicitationComposer).not.toBeNull()
    expect(elicitationComposer?.classList.contains('max-h-[min(70dvh,44rem)]')).toBe(true)
    expect(elicitationComposer?.classList.contains('overflow-visible')).toBe(true)
    expect(elicitationComposer?.classList.contains('px-px')).toBe(true)
    expect(elicitationComposer?.classList.contains('pb-px')).toBe(true)
    const resizeHandle = container.querySelector(
      '[aria-label="Resize question panel"]'
    ) as HTMLButtonElement
    expect(resizeHandle).not.toBeNull()
    expect(resizeHandle.classList.contains('touch-none')).toBe(true)
    expect(resizeHandle.classList.contains('[@media(pointer:coarse)]:h-11')).toBe(true)
    const scrollSurface = container.querySelector(
      '[data-testid="elicitation-composer-scroll"]'
    ) as HTMLDivElement
    expect(scrollSurface.classList.contains('overflow-y-auto')).toBe(true)
    expect(scrollSurface.classList.contains('overscroll-contain')).toBe(true)
    expect(scrollSurface.classList.contains('border-border-200')).toBe(true)
    expect(scrollSurface.classList.contains('shadow-sm')).toBe(true)
    expect(scrollSurface.classList.contains('shadow-card-opaque')).toBe(false)
    expectComposerChromeCovered('[aria-label="Open notebook"]')
    expectComposerChromeCovered('[data-testid="remote-job-badge"]')

    const optionRows = container.querySelectorAll<HTMLElement>(
      '[data-elicitation-option-row="true"]'
    )
    expect(optionRows).toHaveLength(2)
    ;(elicitationComposer as HTMLElement).getBoundingClientRect = () => ({ height: 480 }) as DOMRect
    scrollSurface.getBoundingClientRect = () => ({ top: 32 }) as DOMRect
    optionRows[1].getBoundingClientRect = () => ({ bottom: 180 }) as DOMRect

    act(() => {
      resizeHandle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 })
      )
      resizeHandle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 200 }))
    })
    expect((elicitationComposer as HTMLElement).style.height).toBe('380px')

    act(() => {
      resizeHandle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 400 }))
      resizeHandle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 400 }))
    })
    expect((elicitationComposer as HTMLElement).style.height).toBe('288px')

    ;(elicitationComposer as HTMLElement).getBoundingClientRect = () => ({ height: 288 }) as DOMRect
    act(() => {
      resizeHandle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }))
    })
    expect((elicitationComposer as HTMLElement).style.height).toBe('288px')

    Object.defineProperties(scrollSurface, {
      clientHeight: { configurable: true, value: 256 },
      scrollHeight: { configurable: true, value: 400 }
    })
    act(() => {
      resizeHandle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }))
    })
    expect((elicitationComposer as HTMLElement).style.height).toBe('320px')

    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 568 })
    ;(elicitationComposer as HTMLElement).getBoundingClientRect = () => ({ height: 300 }) as DOMRect
    Object.defineProperties(scrollSurface, {
      clientHeight: { configurable: true, value: 250 },
      scrollHeight: { configurable: true, value: 500 }
    })
    act(() => {
      resizeHandle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 })
      )
      resizeHandle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 0 }))
      resizeHandle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 0 }))
    })
    expect((elicitationComposer as HTMLElement).style.height).toBe('398px')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })

    renderPanel({
      view: {
        activeSession: {
          ...activeSession,
          activities: [
            {
              ...activeSession.activities![0],
              id: 'tool-ask-2',
              elicitation: {
                message: 'Choose the next skill type.',
                fields,
                state: 'pending'
              }
            }
          ]
        }
      },
      elicitation: {
        requests: [
          {
            requestId: 'elicitation-2',
            sessionId: activeSession.id,
            toolCallId: 'tool-ask-2',
            message: 'Choose the next skill type.',
            fields
          }
        ]
      }
    })

    const nextElicitationComposer = container.querySelector(
      '[data-testid="elicitation-composer"]'
    ) as HTMLDivElement
    expect(nextElicitationComposer).not.toBe(elicitationComposer)
    expect(nextElicitationComposer.style.height).toBe('')

    const surfaceFade = container.querySelector('[data-testid="composer-surface-fade"]')
    expect(surfaceFade?.classList.contains('-top-18')).toBe(true)
    expect(surfaceFade?.classList.contains('h-18')).toBe(true)
    expect(surfaceFade?.classList.contains('bg-gradient-to-t')).toBe(true)
    expect(surfaceFade?.classList.contains('from-bg-10')).toBe(true)
    expect(surfaceFade?.classList.contains('to-bg-10/0')).toBe(true)
    expect(
      container
        .querySelector('[data-testid="composer-card-backdrop"]')
        ?.classList.contains('hidden')
    ).toBe(true)
    expectComposerCoveredByBlockingOverlay()
    expect(
      container
        .querySelector('[aria-label="Cancel run"]')
        ?.closest('form')
        ?.classList.contains('invisible')
    ).toBe(true)

    renderPanel({
      view: {
        activeSession: {
          ...activeSession,
          status: 'idle',
          activities: activeSession.activities?.map((activity) => ({
            ...activity,
            status: 'completed',
            elicitation: activity.elicitation
              ? {
                  ...activity.elicitation,
                  state: 'answered',
                  answers: [{ fieldId: 'question_0', value: 'integration' }]
                }
              : undefined
          }))
        }
      },
      elicitation: {
        requests: []
      }
    })

    expect(container.querySelector('[data-testid="elicitation-composer"]')).toBeNull()
    expect(container.querySelector('[role="textbox"]')?.closest('form')?.hidden).toBe(false)
  })

  it('puts permission approval ahead of Ask-User in a content-bounded composer lane', () => {
    const activeSession: ChatSession = {
      id: 'session-existing',
      projectId: 'project-a',
      title: 'Permission request',
      cwd: '/workspace',
      status: 'waiting-permission',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    mockAllJobs = [{ job_id: 'job-1', status: 'done', created_at: 1 }]
    renderPanel({
      view: {
        activeSession: activeSession
      },
      sessionTools: {
        notebookReference: {
          sessionId: activeSession.id,
          projectId: activeSession.projectId,
          workspaceCwd: '/workspace',
          notebookSessionRoot: '/notebook',
          dataRoot: '/data',
          runtimeRoot: '/runtime',
          runJsonPath: '/notebook/run.json'
        }
      },
      permissions: {
        requests: [{ requestId: 'permission-1' } as never]
      },
      elicitation: {
        requests: [
          {
            requestId: 'elicitation-after-permission',
            sessionId: 'session-existing',
            toolCallId: 'tool-ask-after-permission',
            message: 'Which scope should the agent use?',
            fields: [
              {
                id: 'question_0',
                label: 'Scope',
                kind: 'single-select',
                options: [{ value: 'focused', label: 'Focused' }]
              }
            ]
          }
        ]
      }
    })

    const permissionComposer = container.querySelector(
      '[data-testid="permission-composer"]'
    ) as HTMLDivElement
    const scrollSurface = container.querySelector(
      '[data-testid="permission-composer-scroll"]'
    ) as HTMLDivElement
    const resizeHandle = container.querySelector(
      '[aria-label="Resize permission panel"]'
    ) as HTMLButtonElement

    expect(permissionComposer).not.toBeNull()
    expect(scrollSurface.classList.contains('overflow-y-auto')).toBe(true)
    expect(resizeHandle).not.toBeNull()
    expect(resizeHandle.classList.contains('active:bg-bg-200')).toBe(false)
    expect(container.querySelector('[data-testid="permission-approval-controls"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="elicitation-composer"]')).toBeNull()
    expectComposerChromeCovered('[aria-label="Open notebook"]')
    expectComposerChromeCovered('[data-testid="remote-job-badge"]')
    expectComposerCoveredByBlockingOverlay()
    expect(
      container
        .querySelector('[data-testid="composer-surface-fade"]')
        ?.classList.contains('-top-18')
    ).toBe(true)

    permissionComposer.getBoundingClientRect = () => ({ height: 320 }) as DOMRect
    Object.defineProperties(scrollSurface, {
      clientHeight: { configurable: true, value: 280 },
      scrollHeight: { configurable: true, value: 280 }
    })

    act(() => {
      resizeHandle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 })
      )
      resizeHandle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 0 }))
      resizeHandle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 0 }))
    })
    expect(permissionComposer.style.height).toBe('320px')

    Object.defineProperty(scrollSurface, 'scrollHeight', { configurable: true, value: 620 })
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
    act(() => {
      resizeHandle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 300 })
      )
      resizeHandle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: -300 }))
      resizeHandle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: -300 }))
    })
    expect(permissionComposer.style.height).toBe('660px')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })

    renderPanel({
      permissions: {
        requests: [{ requestId: 'permission-2' } as never]
      }
    })
    const nextPermissionComposer = container.querySelector(
      '[data-testid="permission-composer"]'
    ) as HTMLDivElement
    expect(nextPermissionComposer).not.toBe(permissionComposer)
    expect(nextPermissionComposer.style.height).toBe('')
  })

  it('puts Session credential recovery in the content-bounded Composer lane', () => {
    const activeSession: ChatSession = {
      id: 'session-credential',
      projectId: 'project-a',
      title: 'OpenAlex credential',
      cwd: '/workspace',
      status: 'running',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    renderPanel({
      view: { activeSession },
      permissions: {
        ...createPanelDefaults().permissions,
        credentialRequests: [
          {
            id: 'credential-1',
            credentialId: 'openalex',
            connector: 'literature',
            method: 'openalex_search_works',
            sessionId: activeSession.id
          }
        ]
      },
      elicitation: {
        requests: [
          {
            requestId: 'elicitation-after-credential',
            sessionId: activeSession.id,
            toolCallId: 'tool-ask-after-credential',
            message: 'Which scope should the agent use?',
            fields: []
          }
        ]
      }
    })

    expect(container.querySelector('[data-testid="credential-composer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="credential-composer-scroll"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Resize credential panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="connector-credential-controls"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="scroller-credential-pending"]')?.textContent
    ).toBe('true')
    expect(container.querySelector('[data-testid="elicitation-composer"]')).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expectComposerCoveredByBlockingOverlay()
  })

  it('serializes a pending question ahead of Plan approval in the shared blocking lane', () => {
    const fields = [
      {
        id: 'question_0',
        label: 'Scope',
        kind: 'single-select' as const,
        options: [
          { value: 'focused', label: 'Focused' },
          { value: 'broad', label: 'Broad' }
        ]
      },
      { id: 'question_0_custom', label: 'Other', kind: 'text' as const }
    ]
    const pendingActivity: NonNullable<ChatSession['activities']>[number] = {
      id: 'tool-choice-before-plan',
      kind: 'tool',
      title: 'Choose a scope',
      status: 'in_progress',
      eventIds: [],
      sortIndex: 1,
      promptMessageId: 'interaction-1',
      createdAt: 1,
      updatedAt: 1,
      elicitation: {
        message: 'Which scope should the Plan use?',
        fields,
        state: 'pending',
        durable: { kind: 'agent-user-choice', requestId: 'choice-before-plan' }
      }
    }
    const session: ChatSession = {
      id: 'session-choice-before-plan',
      projectId: 'project-a',
      title: 'Choice before Plan',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      activeRun: { promptMessageId: 'interaction-1', startedAt: 1 },
      messages: planOriginMessages(),
      activities: [pendingActivity],
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      },
      createdAt: 1,
      updatedAt: 2
    }

    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: false
      }
    })

    expect(container.querySelector('[data-testid="elicitation-composer"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="elicitation-composer"] h3')?.textContent).toBe(
      'Scope'
    )
    expect(container.textContent).not.toContain('Plan ready for review')
    expectComposerCoveredByBlockingOverlay()

    renderPanel({
      view: {
        activeSession: {
          ...session,
          activities: [
            {
              ...pendingActivity,
              status: 'completed',
              elicitation: {
                ...pendingActivity.elicitation!,
                state: 'answered',
                answers: [{ fieldId: 'question_0', value: 'focused' }]
              }
            }
          ]
        },
        canEditDraft: false
      }
    })

    expect(container.querySelector('[data-testid="elicitation-composer"]')).toBeNull()
    expect(container.textContent).toContain('Plan ready for review')
    expectComposerCoveredByBlockingOverlay()
  })

  it('restores a durable pending choice from the persisted activity', async () => {
    const onRespondToElicitation = vi.fn().mockResolvedValue(undefined)
    const fields = [
      {
        id: 'question_0',
        label: 'Approach',
        kind: 'single-select' as const,
        options: [
          { value: 'minimal', label: 'Minimal' },
          { value: 'expanded', label: 'Expanded' }
        ]
      },
      { id: 'question_0_custom', label: 'Other', kind: 'text' as const }
    ]
    const activeSession: ChatSession = {
      id: 'session-restored-choice',
      projectId: 'project-a',
      title: 'Restored choice',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      activities: [
        {
          id: 'tool-choice-1',
          kind: 'tool',
          title: 'Choose an approach',
          status: 'failed',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1,
          updatedAt: 1,
          elicitation: {
            message: 'Choose an approach',
            fields,
            state: 'pending',
            durable: { kind: 'agent-user-choice', requestId: 'choice-1' }
          }
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    renderPanel({
      view: {
        activeSession: activeSession
      },
      elicitation: {
        requests: [],
        respond: onRespondToElicitation
      }
    })

    const option = container.querySelector<HTMLButtonElement>(
      '[data-testid="elicitation-option-minimal"]'
    )
    expect(option).not.toBeNull()
    await act(async () => option?.click())
    expect(option?.getAttribute('data-selected')).toBe('true')
    expect(onRespondToElicitation).not.toHaveBeenCalled()
    const finish = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Finish'
    )
    await act(async () => finish?.click())

    expect(onRespondToElicitation).toHaveBeenCalledWith({
      requestId: 'choice-1',
      action: 'accept',
      answers: [{ fieldId: 'question_0', value: 'minimal' }],
      request: {
        requestId: 'choice-1',
        sessionId: 'session-restored-choice',
        toolCallId: 'tool-choice-1',
        message: 'Choose an approach',
        fields,
        durable: { kind: 'agent-user-choice', requestId: 'choice-1' }
      }
    })
  })

  it('scopes live Ask-User requests to the active session', () => {
    const fields = [
      {
        id: 'question_0',
        label: 'Course priority',
        kind: 'multi-select' as const,
        options: [
          { value: 'statistics', label: 'Statistics' },
          { value: 'visualization', label: 'Visualization' }
        ]
      },
      { id: 'question_0_custom', label: 'Other', kind: 'text' as const }
    ]
    const activeSession: ChatSession = {
      id: 'session-active-choice',
      projectId: 'project-a',
      title: 'Active choice',
      cwd: '/workspace',
      status: 'waiting-for-user',
      messages: [],
      activities: [
        {
          id: 'tool-active-choice',
          kind: 'tool',
          title: 'Choose course priorities',
          status: 'in_progress',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1,
          updatedAt: 1,
          elicitation: {
            message: 'Which courses should be prioritized?',
            fields,
            state: 'pending',
            durable: { kind: 'agent-user-choice', requestId: 'active-choice' }
          }
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    renderPanel({
      view: { activeSession },
      elicitation: {
        requests: [
          {
            requestId: 'foreign-choice',
            sessionId: 'session-foreign-choice',
            toolCallId: 'tool-foreign-choice',
            message: 'Choose a foreign option',
            fields: [
              {
                id: 'foreign',
                label: 'Foreign option',
                kind: 'single-select',
                required: true,
                options: [{ value: 'foreign', label: 'Foreign' }]
              }
            ]
          }
        ]
      }
    })

    expect(container.querySelector('[data-testid="elicitation-option-statistics"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Choose a foreign option')
  })

  it('does not block the composer for an orphaned non-durable Ask-User activity', () => {
    const activeSession: ChatSession = {
      id: 'session-orphaned-choice',
      projectId: 'project-a',
      title: 'Orphaned choice',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      activities: [
        {
          id: 'tool-orphaned-choice',
          kind: 'tool',
          title: 'Choose course priorities',
          status: 'completed',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1,
          updatedAt: 1,
          elicitation: {
            message: 'Which courses should be prioritized?',
            fields: [
              {
                id: 'courses',
                label: 'Courses',
                kind: 'multi-select',
                options: [
                  { value: 'statistics', label: 'Statistics' },
                  { value: 'visualization', label: 'Visualization' }
                ]
              }
            ],
            state: 'pending'
          }
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    renderPanel({
      view: { activeSession },
      elicitation: { requests: [] }
    })

    expect(container.querySelector('[data-testid="elicitation-composer"]')).toBeNull()
    expect(getComposerForm().hidden).toBe(false)
    expect(container.textContent).not.toContain('Waiting for a response')
  })

  it('keeps attachment limits discoverable in the tooltip and touch fallback', () => {
    renderPanel()

    const guidance = 'Any file type · 10 GB per file. Large files are linked, not embedded.'
    expect(container.querySelector('[data-testid="menu-attach-files"]')?.textContent).toBe(
      'Attach files'
    )
    expect(
      [...container.querySelectorAll('[data-testid="tooltip-content"]')].some(
        (node) => node.textContent === guidance
      )
    ).toBe(true)

    const fallback = container.querySelector('[data-testid="attachment-limits-touch"]')
    expect(fallback?.textContent).toBe(guidance)
    expect(fallback?.className).toContain('hidden')
    expect(fallback?.className).toContain('[@media(pointer:coarse)]:block')

    renderPanel({
      view: {
        canEditDraft: false
      }
    })
    expect(fallback?.className).toContain('block')
    expect(fallback?.className).not.toContain('hidden')
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

    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: true
      }
    })

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
      composer: {
        view: {
          transfers: [transfer],
          isUploading: true
        },
        actions: {
          cancelTransfer: onCancelAttachmentTransfer
        }
      }
    })

    const progress = container.querySelector('[role="progressbar"]')
    const cancel = container.querySelector(
      'button[aria-label="Cancel attachment large.csv"]'
    ) as HTMLButtonElement | null

    expect(progress?.getAttribute('aria-valuenow')).toBe('25')
    expect(container.textContent).toContain('25% of 100 B')
    expect(cancel).not.toBeNull()
    expect(cancel?.parentElement?.className).toContain('h-9')
    expect(cancel?.parentElement?.className).not.toContain('h-11')
    act(() => cancel?.click())
    expect(onCancelAttachmentTransfer).toHaveBeenCalledWith(transfer)
  })

  it('renders a reversible pasted-text attachment and routes restore and close separately', () => {
    const pastedTextName = 'Pastedtext-div-class-contents-l.txt'
    const attachment = {
      id: 'upload-paste',
      sessionId: '.pending',
      name: pastedTextName,
      originalName: pastedTextName,
      path: `/uploads/${pastedTextName}`,
      mimeType: 'text/plain',
      size: 12_000
    }
    const restorePastedText = vi.fn()
    const removeAttachment = vi.fn()
    renderPanel({
      composer: {
        view: {
          doc: {
            nodes: [
              { type: 'text', text: 'before ' },
              {
                type: 'pasted-text',
                id: 'paste-1',
                text: '<div class="contents">long payload',
                attachmentId: attachment.id
              },
              { type: 'text', text: ' after' }
            ]
          },
          attachments: [attachment]
        },
        actions: { restorePastedText, removeAttachment }
      }
    })

    const card = container.querySelector<HTMLElement>('[data-pasted-text-attachment="true"]')
    if (!card) throw new Error('pasted-text attachment not found')
    const restore = Array.from(card?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Show in text field')
    )
    const remove = card?.querySelector<HTMLButtonElement>(
      `button[aria-label="Remove attachment ${pastedTextName}"]`
    )

    expect(card?.getAttribute('data-state')).toBe('success')
    expect(card?.id).toBe('composer-pasted-text-attachment-paste-1')
    expect(card?.className).toContain('h-9')
    expect(card?.className).not.toContain('h-12')
    expect(card?.textContent).toContain('<div class="conte...')
    expect(card?.textContent).not.toContain(pastedTextName)
    expect(restore?.querySelector('span')?.className).toContain('whitespace-nowrap')
    const scrollIntoView = vi.fn()
    const animate = vi.fn()
    Object.defineProperty(card, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    Object.defineProperty(card, 'animate', { configurable: true, value: animate })
    const marker = getComposerEditor().querySelector<HTMLElement>('[data-pasted-text-id="paste-1"]')
    act(() => marker?.click())
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    })
    expect(animate).toHaveBeenCalledOnce()
    act(() => restore?.click())
    expect(restorePastedText).toHaveBeenCalledWith('paste-1')
    act(() => remove?.click())
    expect(removeAttachment).toHaveBeenCalledWith(attachment)
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
    renderPanel({
      view: {
        canEditDraft: false
      }
    })

    dispatchDrag('dragenter', ['Files'])
    expect(hasDropOverlay()).toBe(false)
  })

  it('submits on Enter through the editor with the picked skill ids', () => {
    const onSendMessage = vi.fn()
    renderPanel({
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ send: onSendMessage })
          }
        }
      }
    })

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
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ planFirst: onPlanFirst })
          }
        }
      },
      composer: {
        view: {
          doc: {
            nodes: [
              { type: 'skill', id: 'skill-analysis', name: 'analysis' },
              { type: 'text', text: ' analyze this dataset' }
            ]
          }
        }
      }
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
      view: {
        activeSession: session
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ planFirst: vi.fn(), branch: vi.fn() })
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'analyze this dataset' }] }
        }
      }
    })

    expect(
      (container.querySelector('[data-testid="menu-plan-first"]') as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (container.querySelector('[data-testid="menu-branch-in-new-session"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it('keeps send, Plan first, and Branch available for a pending replay', () => {
    const session: ChatSession = {
      id: 'session-replay',
      projectId: 'project-a',
      title: 'Replay pending',
      cwd: '/workspace',
      status: 'idle',
      pendingHistoryReplay: { kind: 'all' },
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2
    }
    renderPanel({
      view: {
        activeSession: session
      },
      conversation: {
        availability: {
          submit: true,
          branch: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ planFirst: vi.fn(), branch: vi.fn() })
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'continue from this branch' }] }
        }
      }
    })

    expect(
      (container.querySelector('[data-testid="menu-plan-first"]') as HTMLButtonElement).disabled
    ).toBe(false)
    expect(
      (container.querySelector('[data-testid="menu-branch-in-new-session"]') as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it('threads replay-independent agent controls separately from provider controls', () => {
    renderPanel({
      agentControls: {
        canChange: false,
        canChangeAutoReview: true,
        canChangeMemory: true,
        canChangeSpecialist: true,
        canChangeDelegation: true,
        delegationHasLiveAttempts: true
      }
    })

    const controls = container.querySelector('[data-testid="mock-agent-controls"]')
    expect(controls?.getAttribute('data-read-only')).toBe('true')
    expect(controls?.getAttribute('data-memory-read-only')).toBe('false')
    expect(controls?.getAttribute('data-auto-review-read-only')).toBe('false')
    expect(controls?.getAttribute('data-delegation-read-only')).toBe('false')
    expect(controls?.getAttribute('data-delegation-live')).toBe('true')
    expect(controls?.getAttribute('data-specialist-read-only')).toBe('false')
  })

  it('offers Side chat between Plan first and Branch for a text-only existing Session draft', () => {
    const onStartSideChat = vi.fn()
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
      view: {
        activeSession: session
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          sideChat: {
            start: onStartSideChat
          },
          submit: {
            draft: routeDraftSubmit({ planFirst: vi.fn(), branch: vi.fn() })
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'Ask on the side' }] }
        }
      }
    })

    const items = [...container.querySelectorAll('[role="menuitem"], [data-testid^="menu-"]')]
      .filter((element) =>
        ['menu-plan-first', 'menu-side-chat', 'menu-branch-in-new-session'].includes(
          element.getAttribute('data-testid') ?? ''
        )
      )
      .map((element) => element.getAttribute('data-testid'))
    const side = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement

    expect(items).toEqual(['menu-plan-first', 'menu-side-chat', 'menu-branch-in-new-session'])
    expect(side.disabled).toBe(false)
    act(() => side.click())
    expect(onStartSideChat).toHaveBeenCalledOnce()
  })

  it('offers Side chat for an annotation-only existing Session draft', () => {
    const onStartSideChat = vi.fn()
    renderPanel({
      view: {
        activeSession: {
          id: 'session-existing',
          projectId: 'project-a',
          title: 'Existing session',
          cwd: '/workspace',
          status: 'idle',
          messages: planOriginMessages(),
          createdAt: 1,
          updatedAt: 2
        }
      },
      conversation: {
        availability: { submit: true },
        actions: { sideChat: { start: onStartSideChat } }
      },
      composer: {
        view: {
          doc: { nodes: [] },
          annotations: [
            {
              id: 'annotation-side-chat',
              kind: 'text',
              target: 'agent',
              quote: 'Quoted Agent evidence',
              source: {
                kind: 'agent-message',
                sessionId: 'session-existing',
                messageId: 'message-1'
              }
            }
          ]
        }
      }
    })

    const side = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement
    expect(side.disabled).toBe(false)
    act(() => side.click())
    expect(onStartSideChat).toHaveBeenCalledOnce()
  })

  it('keeps Side chat available while running without reopening its tooltip', () => {
    const onStartSideChat = vi.fn()
    renderPanel({
      view: {
        activeSession: {
          id: 'session-running',
          projectId: 'project-a',
          title: 'Running session',
          cwd: '/workspace',
          status: 'running',
          messages: planOriginMessages(),
          createdAt: 1,
          updatedAt: 2
        },
        canEditDraft: true
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          sideChat: {
            start: onStartSideChat
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'Ask while main runs' }] }
        }
      }
    })

    const trigger = container.querySelector(
      '[data-testid="running-side-chat-menu-trigger"]'
    ) as HTMLButtonElement
    const item = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement
    expect(trigger.disabled).toBe(false)
    expect(item.disabled).toBe(false)
    const focusReturn = new FocusEvent('focusin', { bubbles: true, cancelable: true })
    act(() => trigger.dispatchEvent(focusReturn))
    expect(focusReturn.defaultPrevented).toBe(true)
    act(() => item.click())
    expect(onStartSideChat).toHaveBeenCalledOnce()
  })

  it.each(['waiting-for-user', 'waiting-permission'] as const)(
    'keeps Side chat disabled while the main Session is %s',
    (status) => {
      const onStartSideChat = vi.fn()
      renderPanel({
        view: {
          activeSession: {
            id: 'session-waiting',
            projectId: 'project-a',
            title: 'Waiting session',
            cwd: '/workspace',
            status,
            messages: planOriginMessages(),
            createdAt: 1,
            updatedAt: 2
          },
          canEditDraft: true
        },
        conversation: {
          availability: {
            submit: false
          },
          actions: {
            sideChat: {
              start: onStartSideChat
            }
          }
        },
        composer: {
          view: {
            doc: { nodes: [{ type: 'text', text: 'Ask on the side' }] }
          }
        }
      })

      const trigger = container.querySelector(
        '[data-testid="running-side-chat-menu-trigger"]'
      ) as HTMLButtonElement
      const item = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement
      expect(trigger.disabled).toBe(true)
      expect(item.disabled).toBe(true)
      act(() => item.click())
      expect(onStartSideChat).not.toHaveBeenCalled()
    }
  )

  it('keeps Side chat disabled while the main Session is waiting-plan-approval', () => {
    const onStartSideChat = vi.fn()
    renderPanel({
      view: {
        activeSession: {
          id: 'session-plan-waiting',
          projectId: 'project-a',
          title: 'Waiting Plan',
          cwd: '/workspace',
          status: 'waiting-plan-approval',
          messages: planOriginMessages(),
          createdAt: 1,
          updatedAt: 2
        },
        canEditDraft: true
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          sideChat: {
            start: onStartSideChat
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'Ask on the side' }] }
        }
      }
    })

    const item = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement
    expect(item.disabled).toBe(true)
    act(() => item.click())
    expect(onStartSideChat).not.toHaveBeenCalled()
  })

  it('explains why strict Side chat is unavailable for an unsupported backend', () => {
    const reason = 'Strict tool isolation is unavailable.'
    renderPanel({
      view: {
        activeSession: {
          id: 'session-existing',
          projectId: 'project-a',
          title: 'Existing session',
          cwd: '/workspace',
          status: 'idle',
          messages: planOriginMessages(),
          createdAt: 1,
          updatedAt: 2
        },
        sideChatDisabledReason: reason
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          sideChat: {
            start: vi.fn()
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'Ask on the side' }] }
        }
      }
    })

    const item = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement
    expect(item.disabled).toBe(true)
    expect(item.textContent).toContain(reason)
  })

  it('offers an explicit retry when Side chat hydration fails', () => {
    const retryHydration = vi.fn()
    const onStartSideChat = vi.fn()
    const reason = 'Could not restore Side chats: IPC still unavailable'
    renderPanel({
      view: {
        activeSession: {
          id: 'session-existing',
          projectId: 'project-a',
          title: 'Existing session',
          cwd: '/workspace',
          status: 'idle',
          messages: planOriginMessages(),
          createdAt: 1,
          updatedAt: 2
        },
        sideChatDisabledReason: reason
      },
      conversation: {
        actions: {
          sideChat: {
            start: onStartSideChat
          }
        }
      },
      sideChat: {
        retryHydration
      }
    })

    const item = container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement
    expect(item.disabled).toBe(false)
    expect(item.textContent).toContain('Retry Side chat restore')
    expect(item.textContent).toContain(reason)

    act(() => item.click())

    expect(retryHydration).toHaveBeenCalledOnce()
    expect(onStartSideChat).not.toHaveBeenCalled()
  })

  it('keeps Side chat disabled until the Session has a normal main conversation', () => {
    renderPanel({
      view: {
        activeSession: {
          id: 'session-empty',
          projectId: 'project-a',
          title: 'Empty session',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 2
        }
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          sideChat: {
            start: vi.fn()
          }
        }
      },
      composer: {
        view: {
          doc: { nodes: [{ type: 'text', text: 'Ask on the side' }] }
        }
      }
    })

    expect(
      (container.querySelector('[data-testid="menu-side-chat"]') as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('covers the ordinary composer with an overlay Side chat panel', () => {
    const onCloseSideChat = vi.fn()
    renderPanel({
      sessionTools: {
        notebookReference: {
          sessionId: 'session-existing',
          projectId: 'project-a',
          workspaceCwd: '/workspace',
          notebookSessionRoot: '/notebook',
          dataRoot: '/data',
          runtimeRoot: '/runtime',
          runJsonPath: '/notebook/run.json'
        }
      },
      sideChat: {
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: '',
          running: false,
          entries: [{ id: 'user-1', kind: 'message', role: 'user', text: 'Side prompt' }]
        },
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: onCloseSideChat
      }
    })

    const panel = container.querySelector('[data-testid="side-chat-panel"]')
    const surface = container.querySelector('[data-testid="side-chat-panel-scroll"]')
    const resizeHandle = container.querySelector('[aria-label="Resize Side chat panel"]')

    expect(panel).not.toBeNull()
    expect(panel?.classList.contains('relative')).toBe(true)
    expect(panel?.classList.contains('absolute')).toBe(false)
    expect(panel?.classList.contains('pt-0')).toBe(true)
    expect(resizeHandle?.classList.contains('-translate-y-1/2')).toBe(true)
    expect(resizeHandle?.classList.contains('bg-gradient-to-b')).toBe(true)
    expect(surface?.classList.contains('overflow-hidden')).toBe(true)
    expect(surface?.classList.contains('shadow-none')).toBe(true)
    expect(surface?.classList.contains('shadow-sm')).toBe(false)
    expectComposerChromeCovered('[aria-label="Open notebook"]')
    expectComposerCoveredByBlockingOverlay()
    const sideChatPanel = panel as HTMLElement
    const plus = sideChatPanel.querySelector('[data-testid="side-chat-plus-button"]')
    const agentControls = sideChatPanel.querySelector('[data-testid="mock-agent-controls"]')
    const modelPicker = sideChatPanel.querySelector('[data-testid="mock-model-picker"]')
    expect(plus?.getAttribute('aria-disabled')).toBe('true')
    expect((plus as HTMLButtonElement).disabled).toBe(false)
    expect(agentControls?.getAttribute('data-read-only')).toBe('true')
    expect(agentControls?.getAttribute('data-permission-read-only')).toBe('true')
    expect(agentControls?.getAttribute('data-grants-read-only')).toBe('true')
    expect(agentControls?.getAttribute('data-auto-review-disabled')).toBe('true')
    expect(agentControls?.getAttribute('data-specialist-read-only')).toBe('true')
    expect(modelPicker).toBeNull()
    const followUp = container.querySelector('textarea[placeholder="Follow up…"]')
    expect(followUp).not.toBeNull()
    expect(document.activeElement).toBe(followUp)
    act(() =>
      (container.querySelector('[aria-label="Close Side chat"]') as HTMLButtonElement).click()
    )
    expect(onCloseSideChat).toHaveBeenCalledOnce()
    renderPanel({
      sideChat: {
        close: onCloseSideChat
      }
    })
    expect(document.activeElement).toBe(getComposerEditor())

    const navigationButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open navigation"]'
    )!
    navigationButton.focus()
    renderPanel({
      view: {
        composerFocusKey: 'session-blocked-after-side-chat'
      },
      permissions: {
        requests: [{ requestId: 'permission-after-side-chat' } as never]
      }
    })

    expectComposerCoveredByBlockingOverlay()
    expect(document.activeElement).toBe(navigationButton)
  })

  it('keeps the Side chat input fixed and pins streamed output to the bottom', () => {
    const sideChatProps = {
      sideChat: {
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      }
    }
    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: 'Keep this draft',
          running: true,
          entries: [{ id: 'user-1', kind: 'message', role: 'user', text: 'Side prompt' }]
        }
      }
    })

    const messageScroll = container.querySelector(
      '[data-testid="side-chat-message-scroll"]'
    ) as HTMLDivElement
    const messageScrollViewport = messageScroll.querySelector(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLDivElement
    const header = container.querySelector('[data-testid="side-chat-header"]') as HTMLDivElement
    const viewport = container.querySelector(
      '[data-testid="side-chat-message-viewport"]'
    ) as HTMLDivElement
    const composer = container.querySelector('[data-testid="side-chat-composer"]') as HTMLDivElement
    const topFade = container.querySelector('[data-testid="side-chat-message-fade-top"]')
    const bottomFade = container.querySelector('[data-testid="side-chat-message-fade-bottom"]')

    expect(
      container
        .querySelector('[data-testid="side-chat-panel"]')
        ?.classList.contains('h-[min(70dvh,44rem)]')
    ).toBe(true)
    expect(viewport.previousElementSibling).toBe(header)
    expect(viewport.nextElementSibling).toBe(composer)
    expect(messageScroll.parentElement).toBe(viewport)
    expect(header.classList.contains('shrink-0')).toBe(true)
    expect(composer.classList.contains('shrink-0')).toBe(true)
    expect(viewport.classList.contains('overflow-hidden')).toBe(true)
    expect(messageScroll.getAttribute('data-slot')).toBe('scroll-area')
    expect(messageScrollViewport).not.toBeNull()
    expect(topFade?.classList.contains('bg-gradient-to-b')).toBe(true)
    expect(bottomFade?.classList.contains('bg-gradient-to-t')).toBe(true)
    Object.defineProperty(messageScrollViewport, 'scrollHeight', {
      configurable: true,
      value: 640
    })
    messageScrollViewport.scrollTop = 0

    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: 'Keep this draft',
          running: true,
          entries: [
            { id: 'user-1', kind: 'message', role: 'user', text: 'Side prompt' },
            { id: 'assistant-1', kind: 'message', role: 'assistant', text: 'Streaming output' }
          ]
        }
      }
    })

    const followUp = container.querySelector(
      'textarea[placeholder="Follow up…"]'
    ) as HTMLTextAreaElement
    expect(messageScrollViewport.scrollTop).toBe(640)
    expect(followUp.value).toBe('Keep this draft')
    expect(followUp.disabled).toBe(false)
    expect(container.querySelector('[aria-label="Send Side chat follow up"]')).toBeNull()
    expect(container.querySelector('[aria-label="Cancel Side chat response"]')).not.toBeNull()
  })

  it('presents complete user annotation text consistently and leaves invalid or assistant text raw', () => {
    const annotationText =
      'Compare these observations.\n\n[Annotations]\n' +
      '{"items":[{"type":"quote","content":"Quoted evidence","instruction":"Explain this caveat."},{"type":"image-point","source":{"kind":"artifact-version","artifactId":"artifact-1","versionId":"version-1","name":"figure.png"},"x":500,"y":200,"instruction":"Inspect the peak."}]}'
    const malformedText = '[Annotations]\n{"items":[{"type":"quote","content":"Broken"}] trailing'
    const sideChatProps = {
      sideChat: {
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      }
    }
    const sideChatView = (
      entries: NonNullable<NonNullable<PanelProps['sideChat']>['view']>['entries']
    ): NonNullable<NonNullable<PanelProps['sideChat']>['view']> => ({
      generation: 1,
      parentSessionId: 'session-existing',
      projectId: 'project-a',
      sideSessionId: 'side-1',
      draft: '',
      running: false,
      entries
    })

    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: sideChatView([
          { id: 'optimistic-user', kind: 'message', role: 'user', text: annotationText }
        ])
      }
    })

    expect(container.textContent).toContain('Compare these observations.')
    expect(container.textContent).toContain('Quoted evidence')
    expect(container.textContent).toContain('Explain this caveat.')
    expect(container.textContent).toContain('figure.png')
    expect(container.textContent).toContain('artifact-1')
    expect(container.textContent).toContain('version-1')
    expect(container.textContent).toContain('Point 1 at 500, 200')
    expect(container.textContent).not.toContain('"items"')
    expect(container.querySelectorAll('[data-side-chat-annotation-card]')).toHaveLength(2)

    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: sideChatView([
          { id: 'hydrated-user', kind: 'message', role: 'user', text: annotationText },
          { id: 'invalid-user', kind: 'message', role: 'user', text: malformedText },
          { id: 'assistant-raw', kind: 'message', role: 'assistant', text: annotationText }
        ])
      }
    })

    expect(container.querySelectorAll('[data-side-chat-annotation-card]')).toHaveLength(2)
    expect(container.textContent).toContain(malformedText)
    expect(
      container
        .querySelector('[data-side-chat-raw-message]')
        ?.classList.contains('whitespace-pre-wrap')
    ).toBe(true)
    expect(container.textContent?.match(/"items"/g)).toHaveLength(2)
  })

  it('paces only the live Side chat turn and keeps its tool behind visible text', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const sideChatProps = {
      sideChat: {
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      }
    }
    const entries = [
      { id: 'user-history', kind: 'message' as const, role: 'user' as const, text: 'Old prompt' },
      {
        id: 'assistant-history',
        kind: 'message' as const,
        role: 'assistant' as const,
        text: 'Historical answer'
      },
      { id: 'user-live', kind: 'message' as const, role: 'user' as const, text: 'New prompt' },
      {
        id: 'assistant-live',
        kind: 'message' as const,
        role: 'assistant' as const,
        text: 'Flow'
      }
    ]

    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: '',
          running: true,
          entries: entries.slice(0, -1)
        }
      }
    })
    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: '',
          running: true,
          entries
        }
      }
    })

    expect(container.textContent).toContain('Historical answer')
    expect(container.textContent).not.toContain('Flow')
    expect(container.querySelectorAll('.agent-markdown-streaming')).toHaveLength(1)

    await act(async () => vi.advanceTimersByTimeAsync(496))
    expect(container.textContent).not.toContain('Flow')
    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(container.textContent).toContain('F')

    const nextAssistant = {
      id: 'assistant-after-tool',
      kind: 'message' as const,
      role: 'assistant' as const,
      text: 'Next'
    }

    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: '',
          running: true,
          entries: [
            ...entries,
            {
              id: 'tool-live',
              kind: 'tool',
              title: 'Tool after current answer',
              status: 'in_progress'
            },
            nextAssistant
          ]
        }
      }
    })
    expect(container.textContent).not.toContain('Tool after current answer')
    expect(container.textContent).not.toContain(nextAssistant.text)

    await act(async () => vi.advanceTimersByTimeAsync(96))
    expect(container.textContent).toContain('Flow')
    expect(container.textContent).toContain('Tool after current answer')
    expect(container.textContent).not.toContain(nextAssistant.text)
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.textContent).toContain('N')
    expect(container.textContent).not.toContain(nextAssistant.text)
  })

  it('does not replay a buffered Side chat answer after the panel reopens', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const sideChatProps = {
      sideChat: {
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      }
    }
    const userEntry = {
      id: 'user-reopen',
      kind: 'message' as const,
      role: 'user' as const,
      text: 'Keep going'
    }
    const assistantEntry = {
      id: 'assistant-reopen',
      kind: 'message' as const,
      role: 'assistant' as const,
      text: 'Resume without replay'
    }
    const sideChat = {
      generation: 2,
      parentSessionId: 'session-existing',
      projectId: 'project-a',
      sideSessionId: 'side-2',
      draft: '',
      running: true,
      entries: [userEntry, assistantEntry]
    }

    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: { ...sideChat, entries: [userEntry] }
      }
    })
    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: sideChat
      }
    })
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.textContent).toContain('R')
    expect(container.textContent).not.toContain(assistantEntry.text)

    renderPanel()
    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: sideChat
      }
    })

    expect(container.textContent).toContain(assistantEntry.text)

    const continuedAnswer = `${assistantEntry.text}, then continue`
    renderPanel({
      ...sideChatProps,
      sideChat: {
        ...sideChatProps.sideChat,
        view: {
          ...sideChat,
          entries: [userEntry, { ...assistantEntry, text: continuedAnswer }]
        }
      }
    })
    expect(container.textContent).not.toContain(continuedAnswer)
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.textContent).toContain(`${assistantEntry.text},`)
  })

  it('keeps main approval and ask-user surfaces waiting while Side chat is open', () => {
    const activeSession: ChatSession = {
      id: 'session-existing',
      projectId: 'project-a',
      title: 'Existing session',
      cwd: '/workspace',
      status: 'waiting-permission',
      interrupted: true,
      messages: planOriginMessages(),
      createdAt: 1,
      updatedAt: 2
    }
    const pendingPermissions = [{} as never]
    const pendingElicitations = [{ sessionId: activeSession.id } as never]

    renderPanel({
      view: {
        activeSession: activeSession
      },
      permissions: {
        requests: pendingPermissions
      },
      elicitation: {
        requests: pendingElicitations
      },
      sideChat: {
        view: {
          generation: 1,
          parentSessionId: 'session-existing',
          projectId: 'project-a',
          sideSessionId: 'side-1',
          draft: '',
          running: false,
          entries: []
        },
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      }
    })

    expect(container.querySelector('[data-testid="permission-approval-controls"]')).toBeNull()
    expect(container.querySelector('[aria-label="Resume session"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="scroller-pending-elicitations"]')?.textContent
    ).toBe('0')
    expectComposerCoveredByBlockingOverlay()

    renderPanel({
      view: {
        activeSession: activeSession
      },
      permissions: {
        requests: pendingPermissions
      },
      elicitation: {
        requests: pendingElicitations
      }
    })

    expect(container.querySelector('[data-testid="permission-approval-controls"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="elicitation-composer"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="scroller-pending-elicitations"]')?.textContent
    ).toBe('1')
  })

  it('reveals a waiting Plan immediately after Side chat closes', () => {
    const activeSession: ChatSession = {
      id: 'session-plan-under-side-chat',
      projectId: 'project-a',
      title: 'Plan under Side chat',
      cwd: '/workspace',
      status: 'waiting-plan-approval',
      messages: planOriginMessages(),
      activePlanProjection: {
        ...completedPlanProjection,
        approval: 'pending',
        lifecycle: 'awaiting_approval'
      },
      createdAt: 1,
      updatedAt: 2
    }

    renderPanel({
      view: {
        activeSession: activeSession
      },
      sideChat: {
        view: {
          generation: 1,
          parentSessionId: activeSession.id,
          projectId: activeSession.projectId,
          sideSessionId: 'side-plan',
          draft: '',
          running: false,
          entries: []
        },
        send: vi.fn(async () => true),
        setDraft: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn()
      }
    })

    expect(container.querySelector('[data-testid="plan-composer"]')).toBeNull()

    renderPanel({
      view: {
        activeSession: activeSession
      }
    })

    expect(container.querySelector('[data-testid="plan-composer"]')).not.toBeNull()
  })

  it('disables Plan first for an attachment-only draft', () => {
    renderPanel({
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ planFirst: vi.fn() })
          }
        }
      },
      composer: {
        view: {
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
          ]
        }
      }
    })

    expect(
      (container.querySelector('[data-testid="menu-plan-first"]') as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('adds a branch option beside Send only when a branch handler is available', () => {
    const onBranchInNewSession = vi.fn()
    const activeSession = delegatedQuestionSession()
    renderPanel({
      view: {
        activeSession
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ branch: onBranchInNewSession })
          }
        }
      }
    })

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
    const activeSession = delegatedQuestionSession()
    renderPanel({
      view: {
        activeSession
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ branch: onBranchInNewSession })
          }
        }
      }
    })

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
    renderPanel({
      composer: {
        actions: {
          changeDoc: onDraftDocChange
        }
      }
    })

    const editor = getComposerEditor()
    editor.textContent = 'hello'
    act(() => {
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onDraftDocChange).toHaveBeenCalledWith({ nodes: [{ type: 'text', text: 'hello' }] })
  })
})

describe('ConversationPanel interrupted Session recovery', () => {
  it('shows message-area progress while the Session resume is in flight', async () => {
    let resolveResume: (() => void) | undefined
    const onResumeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve
        })
    )
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
      view: {
        activeSession: interruptedSession
      },
      conversation: {
        actions: {
          resume: onResumeSession
        }
      }
    })

    const resumeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume session"]'
    )
    await act(async () => resumeButton?.click())

    expect(onResumeSession).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="resume-progress-indicator"]')).not.toBeNull()

    await act(async () => resolveResume?.())

    expect(container.querySelector('[data-testid="resume-progress-indicator"]')).toBeNull()
  })

  it('does not show one Session resume progress on another active Session', async () => {
    let resolveResume: (() => void) | undefined
    const onResumeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve
        })
    )
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
      view: {
        activeSession: interruptedSession
      },
      conversation: {
        actions: {
          resume: onResumeSession
        }
      }
    })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Resume session"]')?.click()
    )
    expect(container.querySelector('[data-testid="resume-progress-indicator"]')).not.toBeNull()

    renderPanel({
      view: {
        activeSession: { ...interruptedSession, id: 'session-other', interrupted: undefined }
      },
      conversation: {
        actions: {
          resume: onResumeSession
        }
      }
    })
    expect(container.querySelector('[data-testid="resume-progress-indicator"]')).toBeNull()

    await act(async () => resolveResume?.())
  })

  it('does not show Session resume progress for a new conversation with no active Session', () => {
    // Regression: `activeSession?.id === resumingSessionId` is true when both are undefined, which
    // marked every brand-new conversation as "resuming" and suppressed the empty-state banner.
    renderPanel()

    expect(container.querySelector('[data-testid="resume-progress-indicator"]')).toBeNull()
  })

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
      view: {
        activeSession: interruptedSession
      },
      conversation: {
        availability: {
          resume: false
        },
        actions: {
          resume: onResumeSession
        }
      }
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
  it('renders Context window as the separated final menu item', () => {
    renderPanel()

    const attachItem = container.querySelector('[data-testid="menu-attach-files"]')
    const contextWindowItem = container.querySelector('[data-testid="menu-context-window"]')
    const reviewItem = container.querySelector('[data-testid="menu-request-review"]')
    const saveAsSkillItem = container.querySelector('[data-testid="menu-save-as-skill"]')

    expect(attachItem).not.toBeNull()
    expect(contextWindowItem).not.toBeNull()
    expect(reviewItem).not.toBeNull()
    expect(saveAsSkillItem).not.toBeNull()
    expect(reviewItem?.compareDocumentPosition(saveAsSkillItem as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(saveAsSkillItem?.compareDocumentPosition(contextWindowItem as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(reviewItem?.compareDocumentPosition(contextWindowItem as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(contextWindowItem?.previousElementSibling?.tagName).toBe('HR')
  })

  it('describes the composer add icon with a tooltip', () => {
    renderPanel()

    expect(
      [...container.querySelectorAll('[data-testid="tooltip-content"]')].some(
        (node) =>
          node.textContent ===
          'Add attachment, save as skill, view context window, or request review'
      )
    ).toBe(true)
  })

  it('covers the composer with a pending Plan card and restores it immediately after approval', async () => {
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
    mockAllJobs = [{ job_id: 'job-1', status: 'done', created_at: 1 }]
    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: false
      },
      sessionTools: {
        notebookReference: {
          sessionId: session.id,
          projectId: session.projectId,
          workspaceCwd: '/workspace',
          notebookSessionRoot: '/notebook',
          dataRoot: '/data',
          runtimeRoot: '/runtime',
          runJsonPath: '/notebook/run.json'
        }
      }
    })

    const pendingEditor = container.querySelector('[role="textbox"]')
    expect(pendingEditor?.closest('form')?.classList.contains('invisible')).toBe(true)
    expectComposerCoveredByBlockingOverlay()
    expect(container.textContent).toContain('Plan ready for review')
    const planComposer = container.querySelector('[data-testid="plan-composer"]') as HTMLDivElement
    const planScrollSurface = container.querySelector(
      '[data-testid="plan-composer-scroll"]'
    ) as HTMLDivElement
    const planResizeHandle = container.querySelector(
      '[aria-label="Resize Plan panel"]'
    ) as HTMLButtonElement
    expect(planComposer).not.toBeNull()
    expect(planScrollSurface.classList.contains('overflow-y-auto')).toBe(true)
    expect(planResizeHandle).not.toBeNull()
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent === 'Dismiss'
      )
    ).toBe(false)
    expectComposerChromeCovered('[aria-label="Open notebook"]')
    expectComposerChromeCovered('[data-testid="remote-job-badge"]')
    const pendingPlanCard = [...container.querySelectorAll('article')].find((article) =>
      article.textContent?.includes('Plan ready for review')
    )
    expect(pendingPlanCard?.classList.contains('border-0')).toBe(true)
    expect(pendingPlanCard?.classList.contains('shadow-none')).toBe(true)
    expect(
      container
        .querySelector('[data-testid="composer-plus-trigger"]')
        ?.closest('form')
        ?.classList.contains('invisible')
    ).toBe(true)

    planComposer.getBoundingClientRect = () => ({ height: 260 }) as DOMRect
    Object.defineProperties(planScrollSurface, {
      clientHeight: { configurable: true, value: 228 },
      scrollHeight: { configurable: true, value: 228 }
    })
    act(() => {
      planResizeHandle.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 100 })
      )
      planResizeHandle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 0 }))
      planResizeHandle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 0 }))
    })
    expect(planComposer.style.height).toBe('260px')

    act(() => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Open')
        ?.click()
    })
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('open')
    // The pending card's Open must reuse the version-scoped Plan tab id, so the bottom
    // progress chip and the "view plan" menu entry land on this same tab instead of a duplicate.
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      `tool:${session.id}:plan:${completedPlanProjection.artifactVersionId}`
    )

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
    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()

    renderPanel({
      view: {
        activeSession: {
          ...session,
          status: 'idle',
          activePlanProjection: completedPlanProjection
        }
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
    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: false
      }
    })

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
    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: false
      }
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Approved for execution')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea
        .closest('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(respondToSessionPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-plan-text-approval' }),
      { feedback: 'Approved for execution' }
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

    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: false
      },
      conversation: {
        actions: {
          submit: {
            restoredPlan: onRespondToRestoredPlan
          }
        }
      }
    })

    expect(container.textContent).toContain('Plan ready for review')
    expectComposerCoveredByBlockingOverlay()

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
      view: {
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
      view: {
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
      }
    })

    expect(container.querySelector('[data-testid="menu-view-plan"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Open plan, step"]')).toBeNull()
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'tool:session-plan-branches:plan:version-b'
    )
  })

  it('routes restored Plan approval through the durable decision API', async () => {
    const session: ChatSession = {
      id: 'session-restored-approved',
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
    renderPanel({
      view: {
        activeSession: session,
        canEditDraft: false
      },
      conversation: {
        actions: {
          submit: {
            restoredPlan: onRespondToRestoredPlan
          }
        }
      }
    })

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Approve')
        ?.click()
      await Promise.resolve()
    })

    expect(onRespondToRestoredPlan).toHaveBeenCalledWith({ decision: 'approved' })
    expect(respondToSessionPlanMock).not.toHaveBeenCalled()
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
    renderPanel({
      workflows: {
        review: {
          request: onRequestReview,
          disabled: false
        }
      }
    })

    const reviewItem = container.querySelector('[data-testid="menu-request-review"]')
    expect(reviewItem).not.toBeNull()
    act(() => {
      ;(reviewItem as HTMLButtonElement).click()
    })

    expect(onRequestReview).toHaveBeenCalledTimes(1)
  })

  it('Save as skill calls its action only when enabled', () => {
    const request = vi.fn()
    renderPanel({ workflows: { saveAsSkill: { request, disabled: false } } })

    const item = container.querySelector<HTMLButtonElement>('[data-testid="menu-save-as-skill"]')
    act(() => item?.click())
    expect(request).toHaveBeenCalledOnce()

    renderPanel({
      workflows: {
        saveAsSkill: {
          request,
          disabled: true,
          disabledReason: 'Wait for the current agent activity to finish.'
        }
      }
    })
    const disabledItem = container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-save-as-skill"]'
    )
    expect(disabledItem?.disabled).toBe(false)
    expect(disabledItem?.getAttribute('aria-disabled')).toBe('true')
    act(() => disabledItem?.click())
    expect(request).toHaveBeenCalledOnce()
  })

  it('shows a running Save as skill without losing its disabled interaction contract', () => {
    renderPanel({
      workflows: {
        saveAsSkill: {
          disabled: true,
          disabledReason: 'Save as skill is running.',
          running: true
        }
      }
    })

    const item = container.querySelector<HTMLButtonElement>('[data-testid="menu-save-as-skill"]')
    expect(item?.disabled).toBe(false)
    expect(item?.getAttribute('aria-disabled')).toBe('true')
    expect(item?.getAttribute('aria-busy')).toBe('true')
    expect(item?.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    expect(item?.textContent).toBe('Saving as skill…')
  })

  it('Request review is disabled when isRequestReviewDisabled is true', () => {
    const onRequestReview = vi.fn()
    renderPanel({
      workflows: {
        review: {
          request: onRequestReview,
          disabled: true
        }
      }
    })

    const reviewItem = container.querySelector(
      '[data-testid="menu-request-review"]'
    ) as HTMLButtonElement
    expect(reviewItem.disabled).toBe(true)
    expect(reviewItem.getAttribute('aria-busy')).toBeNull()
    expect(reviewItem.textContent).toBe('Request review')
    expect(reviewItem.querySelector('svg')?.classList.contains('animate-spin')).toBe(false)

    act(() => {
      reviewItem.click()
    })

    // disabled button click should not call the handler
    expect(onRequestReview).not.toHaveBeenCalled()
  })

  it('shows a disabled loading state while the active session is being reviewed', () => {
    const onRequestReview = vi.fn()
    renderPanel({
      workflows: {
        review: {
          disabled: true,
          running: true,
          request: onRequestReview
        }
      }
    })

    const reviewItem = container.querySelector(
      '[data-testid="menu-request-review"]'
    ) as HTMLButtonElement
    const loadingIcon = reviewItem.querySelector('svg')

    expect(reviewItem.disabled).toBe(true)
    expect(reviewItem.getAttribute('aria-busy')).toBe('true')
    expect(reviewItem.textContent).toBe('Reviewing\u2026')
    expect(loadingIcon?.classList.contains('animate-spin')).toBe(true)
    expect(loadingIcon?.classList.contains('motion-reduce:animate-none')).toBe(true)

    act(() => {
      reviewItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onRequestReview).not.toHaveBeenCalled()
  })

  it('Request review is not called when disabled is true (onSelect guard)', () => {
    const onRequestReview = vi.fn()
    renderPanel({
      workflows: {
        review: {
          request: onRequestReview,
          disabled: true
        }
      }
    })

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

describe('ConversationPanel Your files menu', () => {
  const grantedRoot = {
    id: 'root-1',
    path: '/Users/roxi/data',
    name: 'data',
    access: 'ro' as const
  }

  beforeEach(() => {
    useGrantedFoldersStore.setState({
      ...createInitialGrantedFoldersState(),
      roots: [grantedRoot],
      loaded: true
    })
    ;(window as unknown as { api: unknown }).api = {
      platform: 'darwin',
      localFs: {
        listDir: vi.fn().mockResolvedValue({
          entries: [{ name: 'study.csv', isDirectory: false, size: 1, mtimeMs: 0 }],
          truncated: false,
          resolvedPath: grantedRoot.path
        }),
        listDrives: vi.fn(async () => [])
      }
    }
  })

  afterEach(() => {
    useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders the Your files submenu trigger in the + menu', () => {
    renderPanel()

    expect(container.querySelector('[data-testid="composer-your-files-trigger"]')).not.toBeNull()
  })

  it('appends a linked-folder mention to the owned draft doc when a file is sent', async () => {
    const onDraftDocChange = vi.fn()
    renderPanel({
      composer: {
        actions: {
          changeDoc: onDraftDocChange
        }
      }
    })

    await act(async () => {
      ;(
        container.querySelector('[data-testid="your-files-root-toggle-root-1"]') as HTMLElement
      ).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const send = container.querySelector('[data-testid="your-files-send-root-1-study.csv"]')
    expect(send).not.toBeNull()
    await act(async () => {
      ;(send as HTMLElement).click()
      await Promise.resolve()
    })

    expect(onDraftDocChange).toHaveBeenCalledWith({
      nodes: [
        expect.objectContaining({
          type: 'artifact',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'study.csv'
        })
      ]
    })
  })

  it('renders a linked-folder draft chip as a dark-gray @ pill', () => {
    const draftDoc: ComposerDoc = {
      nodes: [
        { type: 'text', text: 'analyze ' },
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv'
        }
      ]
    }
    renderPanel({
      composer: {
        view: {
          doc: draftDoc
        }
      }
    })

    const chip = container.querySelector('[data-mention-source="linked-folder"]')
    expect(chip?.className).toContain('bg-path-chip')
    expect(chip?.className).toContain('text-path-chip-foreground')
    expect(chip?.textContent).toBe('@data/study.csv')
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

  const detachedChildSession: ChatSession = {
    ...idleSession,
    status: 'idle',
    activeRun: undefined,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'detached-root',
      activeFrameId: 'detached-root',
      frames: [
        {
          id: 'detached-root',
          originBindingState: 'root',
          kind: 'root',
          status: 'completed',
          activeBranchId: 'detached-root-branch',
          createdAt: 1,
          completedAt: 2
        },
        {
          id: 'detached-child',
          parentFrameId: 'detached-root',
          originMessageId: 'detached-origin',
          originBindingState: 'validated',
          kind: 'delegate',
          status: 'running',
          activeBranchId: 'detached-child-branch',
          createdAt: 2
        }
      ],
      branches: [
        {
          id: 'detached-root-branch',
          agentFrameId: 'detached-root',
          headMessageId: 'detached-origin',
          createdAt: 1,
          updatedAt: 2
        },
        {
          id: 'detached-child-branch',
          agentFrameId: 'detached-child',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      messages: [
        {
          id: 'detached-origin',
          role: 'user',
          content: 'Delegate background work.',
          status: 'complete',
          eventIds: [],
          agentFrameId: 'detached-root',
          introducedOnBranchId: 'detached-root-branch',
          revisionRootMessageId: 'detached-origin',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    }
  }

  it('send button is disabled when canSendMessage is false (fix loop active)', () => {
    // canSendMessage is passed from outside (computed by WorkspacePage)
    renderPanel({
      view: {
        activeSession: idleSession
      },
      conversation: {
        availability: {
          submit: false
        }
      }
    })

    const sendButton = container.querySelector('[aria-label="Send message"]') as HTMLButtonElement
    expect(sendButton).not.toBeNull()
    expect(sendButton.disabled).toBe(true)
  })

  it('send button is enabled when canSendMessage is true (no fix loop)', () => {
    renderPanel({
      view: {
        activeSession: idleSession
      },
      conversation: {
        availability: {
          submit: true
        }
      }
    })

    const sendButton = container.querySelector('[aria-label="Send message"]') as HTMLButtonElement
    expect(sendButton).not.toBeNull()
    expect(sendButton.disabled).toBe(false)
  })

  it('send button stays disabled when typing does not change canSendMessage (fix loop active)', () => {
    const onDraftDocChange = vi.fn()
    renderPanel({
      view: {
        activeSession: lockedSession
      },
      conversation: {
        availability: {
          submit: false
        }
      },
      composer: {
        actions: {
          changeDoc: onDraftDocChange
        }
      }
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

  it('explains an unavailable Specialist and opens Agent controls to choose another', () => {
    renderPanel({
      view: {
        activeSession: { ...idleSession, specialistId: 'deleted-specialist' }
      },
      conversation: {
        availability: {
          submit: false
        }
      },
      specialist: {
        view: {
          specialist: {
            unavailable: true
          }
        }
      }
    })

    const notice = container.querySelector('[data-testid="specialist-unavailable-notice"]')
    expect(notice?.textContent).toContain('This Specialist is no longer available')
    expect(notice?.textContent).toContain('Choose another Specialist before sending a message.')
    expect(notice?.textContent).toContain('Your draft is preserved.')
    expect(
      container
        .querySelector('[data-testid="composer-card-backdrop"]')
        ?.classList.contains('hidden')
    ).toBe(true)

    const controls = container.querySelector('[data-testid="mock-agent-controls"]')
    const chooseButton = notice?.querySelector<HTMLButtonElement>('button')
    expect(chooseButton?.parentElement).toBe(notice)
    expect(chooseButton?.classList.contains('ml-auto')).toBe(true)
    expect(controls?.getAttribute('data-open-request')).toBe('0')
    act(() => {
      chooseButton?.click()
    })
    expect(controls?.getAttribute('data-open-request')).toBe('1')
  })

  it('does not show a Specialist unavailable notice for an available session', () => {
    renderPanel({
      view: {
        activeSession: { ...idleSession, specialistId: 'available-specialist' }
      },
      specialist: {
        view: {
          specialist: {
            unavailable: false
          }
        }
      }
    })

    expect(container.querySelector('[data-testid="specialist-unavailable-notice"]')).toBeNull()
  })

  it('adds the enhanced composer edge and compact picker for an available Specialist', () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'available-specialist',
          name: 'AVAILABLE_SPECIALIST',
          displayName: 'Available Specialist',
          colorKey: 'purple',
          description: 'Available for this session.',
          systemPrompt: 'Help the user.',
          enabled: true,
          capabilityMode: 'full',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ],
      isLoaded: true
    })

    renderPanel({
      view: {
        activeSession: { ...idleSession, specialistId: 'available-specialist' }
      }
    })

    const composer = container.querySelector<HTMLFormElement>('[data-specialist-color="#ede9fe"]')
    const specialistEdge = composer?.querySelector<HTMLElement>('.composer-specialist-color-in')
    expect(specialistEdge?.style.borderColor).toBe('rgb(237, 233, 254)')
    expect(
      container
        .querySelector('[data-testid="composer-specialist-picker-trigger"]')
        ?.getAttribute('aria-label')
    ).toContain('Available Specialist')
  })

  it('shows the selected Specialist while idle reconfiguration is in flight', () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'specialist-a',
          name: 'SPECIALIST_A',
          displayName: 'Specialist A',
          colorKey: 'blue',
          description: 'Currently applied.',
          systemPrompt: 'Help the user.',
          enabled: true,
          capabilityMode: 'full',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        },
        {
          kind: 'custom',
          id: 'specialist-b',
          name: 'SPECIALIST_B',
          displayName: 'Specialist B',
          colorKey: 'purple',
          description: 'Being configured.',
          systemPrompt: 'Help the user.',
          enabled: true,
          capabilityMode: 'full',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ],
      isLoaded: true
    })

    renderPanel({
      view: {
        activeSession: { ...idleSession, specialistId: 'specialist-a' }
      },
      specialist: {
        view: {
          specialist: {
            historyId: 'specialist-b',
            barrierInFlight: true
          }
        }
      }
    })

    expect(
      container
        .querySelector('[data-testid="composer-specialist-picker-trigger"]')
        ?.getAttribute('aria-label')
    ).toContain('Specialist B')
  })

  it('keeps the Specialist control visible while switching back to Main Agent', () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'specialist-a',
          name: 'SPECIALIST_A',
          displayName: 'Specialist A',
          colorKey: 'blue',
          description: 'Currently applied.',
          systemPrompt: 'Help the user.',
          enabled: true,
          capabilityMode: 'full',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
          revision: 1
        }
      ],
      isLoaded: true
    })

    renderPanel({
      view: {
        activeSession: { ...idleSession, specialistId: 'specialist-a' }
      },
      specialist: {
        view: {
          specialist: {
            historyId: undefined,
            barrierInFlight: true
          }
        }
      }
    })

    expect(
      container
        .querySelector('[data-testid="composer-specialist-picker-trigger"]')
        ?.getAttribute('aria-label')
    ).toContain('Specialist A')
  })

  it('cancel button is visible when session is running and calls onCancelRun', () => {
    const onCancelRun = vi.fn()
    const runningSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() }
    }
    renderPanel({
      view: {
        activeSession: runningSession
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          cancel: onCancelRun
        }
      }
    })

    const cancelButton = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    expect(cancelButton).not.toBeNull()
    act(() => {
      cancelButton.click()
    })

    expect(onCancelRun).toHaveBeenCalledTimes(1)
  })

  it('uses the running composer submit action to add the draft to the queue', () => {
    const onQueueMessage = vi.fn()
    const runningSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() }
    }
    renderPanel({
      view: { activeSession: runningSession },
      composer: { view: { doc: { nodes: [{ type: 'text', text: 'next prompt' }] } } },
      conversation: {
        availability: { submit: true, submitMode: 'queue' },
        actions: {
          submit: { draft: routeDraftSubmit({ send: onQueueMessage }) }
        }
      }
    })

    const queueSubmit = container.querySelector(
      '[data-testid="composer-queue-submit"]'
    ) as HTMLButtonElement
    expect(queueSubmit.disabled).toBe(false)
    act(() => queueSubmit.click())
    expect(onQueueMessage).toHaveBeenCalledWith([])
  })

  it('keeps Send and branch-scoped Stop together after a timed Main turn settles', () => {
    const onCancelRun = vi.fn()
    const onStopSubagents = vi.fn()
    renderPanel({
      view: {
        activeSession: detachedChildSession
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          cancel: onCancelRun
        }
      },
      subagents: {
        stop: onStopSubagents
      }
    })

    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="subagents-bar"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Running"]')).not.toBeNull()
    expect(container.textContent).not.toContain('1 subagent running')
    const stop = container.querySelector('[aria-label="Stop subagents"]') as HTMLButtonElement
    expect(stop).not.toBeNull()
    expect(
      [...container.querySelectorAll('[data-testid="tooltip-content"]')].some(
        (tooltip) => tooltip.textContent === 'Stop subagents'
      )
    ).toBe(true)

    act(() => stop.click())
    expect(onStopSubagents).toHaveBeenCalledOnce()
    expect(onCancelRun).not.toHaveBeenCalled()
  })

  it('preserves duplicate prevention, progress, and failure recovery for detached-only Stop', async () => {
    let rejectStop!: (error: Error) => void
    const onStopSubagents = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject
        })
    )
    renderPanel({
      view: {
        activeSession: detachedChildSession
      },
      conversation: {
        availability: {
          submit: true
        }
      },
      subagents: {
        stop: onStopSubagents
      }
    })

    const stop = container.querySelector('[aria-label="Stop subagents"]') as HTMLButtonElement
    act(() => {
      stop.click()
      stop.click()
    })
    expect(onStopSubagents).toHaveBeenCalledOnce()
    expect(stop.disabled).toBe(true)
    expect(stop.getAttribute('aria-label')).toBe('Stopping subagents')

    await act(async () => {
      rejectStop(new Error('detached cascade unavailable'))
      await Promise.resolve()
    })

    const retry = container.querySelector('[aria-label="Stop subagents"]') as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    const stopAlert = container.querySelector('[role="alert"]') as HTMLElement
    expect(stopAlert.textContent).toContain('detached cascade unavailable')
    expect(stopAlert.classList.contains('sr-only')).toBe(false)
  })

  it('uses the same disabled gate for mouse and Enter while branch Stop is pending', () => {
    const onSendMessage = vi.fn()
    const onStopSubagents = vi.fn(() => new Promise<void>(() => undefined))
    renderPanel({
      view: {
        activeSession: detachedChildSession
      },
      conversation: {
        availability: {
          submit: true
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ send: onSendMessage })
          }
        }
      },
      subagents: {
        stop: onStopSubagents
      }
    })
    const stop = container.querySelector('[aria-label="Stop subagents"]') as HTMLButtonElement
    act(() => stop.click())

    const send = container.querySelector('[aria-label="Send message"]') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    act(() => {
      send.click()
      getComposerEditor().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('shows cascade progress, prevents duplicate Stop, and restores the control after failure', async () => {
    let rejectStop!: (error: Error) => void
    const onCancelRun = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject
        })
    )
    const runningSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() }
    }
    renderPanel({
      view: {
        activeSession: runningSession
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          cancel: onCancelRun
        }
      }
    })

    const cancelButton = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    act(() => {
      cancelButton.click()
      cancelButton.click()
    })

    expect(onCancelRun).toHaveBeenCalledOnce()
    expect(cancelButton.disabled).toBe(true)
    expect(cancelButton.getAttribute('aria-label')).toBe('Stopping run and subagents')

    await act(async () => {
      rejectStop(new Error('cascade unavailable'))
      await Promise.resolve()
    })

    const retry = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(container.textContent).toContain('cascade unavailable')
  })

  it('does not carry a pending Stop state or its failure into another Session', async () => {
    let rejectFirstStop!: (error: Error) => void
    const cancelFirstSession = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstStop = reject
        })
    )
    const cancelSecondSession = vi.fn()
    const firstSession: ChatSession = {
      ...idleSession,
      id: 'session-a',
      title: 'Session A',
      status: 'running',
      activeRun: { promptMessageId: 'msg-a', startedAt: Date.now() }
    }
    const secondSession: ChatSession = {
      ...idleSession,
      id: 'session-b',
      title: 'Session B',
      status: 'running',
      activeRun: { promptMessageId: 'msg-b', startedAt: Date.now() }
    }

    renderPanel({
      view: { activeSession: firstSession },
      conversation: {
        availability: { submit: true, submitMode: 'queue' },
        actions: { cancel: cancelFirstSession }
      }
    })
    act(() => {
      const cancel = container.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement
      cancel.click()
    })

    renderPanel({
      view: { activeSession: secondSession },
      conversation: {
        availability: { submit: true, submitMode: 'queue' },
        actions: { cancel: cancelSecondSession }
      }
    })

    const secondSessionCancel = container.querySelector(
      'section[data-session-id="session-b"] [aria-label="Cancel run"], ' +
        'section[data-session-id="session-b"] [aria-label="Stopping run and subagents"]'
    )
    const secondSessionQueue = container.querySelector(
      '[data-testid="composer-queue-submit"]'
    ) as HTMLButtonElement
    const secondSessionState = {
      cancelLabel: secondSessionCancel?.getAttribute('aria-label'),
      cancelDisabled: (secondSessionCancel as HTMLButtonElement | null)?.disabled,
      queueDisabled: secondSessionQueue.disabled,
      firstSessionErrorVisible: false
    }

    act(() => {
      secondSessionCancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cancelSecondSession).toHaveBeenCalledOnce()

    await act(async () => {
      rejectFirstStop(new Error('Session A stop failed'))
      await Promise.resolve()
    })

    secondSessionState.firstSessionErrorVisible =
      container.textContent?.includes('Session A stop failed') ?? false
    expect(secondSessionState).toEqual({
      cancelLabel: 'Cancel run',
      cancelDisabled: false,
      queueDisabled: false,
      firstSessionErrorVisible: false
    })

    renderPanel({
      view: { activeSession: firstSession },
      conversation: {
        availability: { submit: true, submitMode: 'queue' },
        actions: { cancel: cancelFirstSession }
      }
    })
    expect(container.textContent).toContain('Session A stop failed')
  })

  it('keeps the split-send width while running so adjacent hover controls do not shift', () => {
    const runningSession: ChatSession = {
      ...idleSession,
      status: 'running',
      activeRun: { promptMessageId: 'msg-1', startedAt: Date.now() }
    }
    renderPanel({
      view: {
        activeSession: runningSession
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          submit: {
            draft: routeDraftSubmit({ branch: vi.fn() })
          }
        }
      }
    })

    const slot = container.querySelector(
      '[data-testid="composer-running-control-slot"]'
    ) as HTMLDivElement
    expect(slot.className.split(' ')).toEqual(
      expect.arrayContaining(['w-24', 'justify-end', '[@media(pointer:coarse)]:mx-3'])
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
      view: {
        activeSession: runningLockedSession
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          cancel: onCancelRun
        }
      }
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
    renderPanel({
      view: {
        activeSession: lockedSession
      },
      conversation: {
        availability: {
          submit: false
        },
        actions: {
          cancel: onCancelRun
        }
      }
    })

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
      view: {
        activeSession: compactingSession,
        actionError: 'Internal error: Request too large (max 32MB).'
      },
      conversation: {
        actions: {
          cancel: onCancelRun
        }
      }
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
    projectId: 'proj',
    workspaceCwd: '/workspace',
    notebookSessionRoot: '/nb',
    dataRoot: '/data',
    runtimeRoot: '/rt',
    runJsonPath: '/run.json'
  }

  it('hides the notebook bar when there is no notebookReference and no running job', () => {
    mockHasRunningJobs = false
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: undefined
      }
    })

    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).toBeNull()
  })

  it('keeps the Notebook chrome available when queued work exists before a notebook reference', () => {
    renderPanel({
      view: { activeSession: session },
      conversation: {
        queue: {
          items: [
            {
              id: 'queued-a',
              text: 'Analyze the next sample',
              attachmentCount: 0,
              phase: 'queued'
            }
          ]
        }
      }
    })

    const queueTrigger = container.querySelector('[data-testid="composer-queue-trigger"]')
    expect(queueTrigger).not.toBeNull()
    expect(queueTrigger?.parentElement?.classList.contains('min-h-[68px]')).toBe(true)
    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
  })

  it('shows only the Notebook button when notebookReference exists and no running job', () => {
    mockHasRunningJobs = false
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: notebookReference
      }
    })

    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).toBeNull()
  })

  it('places the queue disclosure at the right edge of the Notebook bar', () => {
    renderPanel({
      view: { activeSession: session },
      sessionTools: { notebookReference },
      conversation: {
        queue: {
          items: [
            {
              id: 'queued-a',
              text: 'Analyze the next sample',
              attachmentCount: 0,
              phase: 'queued'
            }
          ]
        }
      }
    })

    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement
    const queueTrigger = container.querySelector('[data-testid="composer-queue-trigger"]')
    expect(queueTrigger?.parentElement).toBe(notebookBar)
    expect(notebookBar?.lastElementChild).toBe(queueTrigger)
    expect(getComposerForm().contains(queueTrigger)).toBe(false)

    act(() => (queueTrigger as HTMLButtonElement).click())
    expect(getComposerForm().querySelector('[data-testid="composer-queue-item"]')).not.toBeNull()
  })

  it('animates the notebook bar upward when it appears', () => {
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: notebookReference
      }
    })

    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement

    expect(notebookBar?.className).toContain('motion-safe:animate-in')
    expect(notebookBar?.className).toContain('motion-safe:fade-in-0')
    expect(notebookBar?.className).toContain('motion-safe:slide-in-from-bottom-1')
  })

  it('shows a pointer cursor over the Notebook button', () => {
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: notebookReference
      }
    })

    const notebookButton = container.querySelector('[aria-label="Open notebook"]')

    expect(notebookButton?.className).toContain('cursor-pointer')
  })

  it('shows only the job badge when there is no notebookReference but there are running jobs', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: undefined
      }
    })

    expect(container.querySelector('[aria-label="Open notebook"]')).toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('keeps the job-only bar compact and static', () => {
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: undefined
      }
    })

    const jobBar = container.querySelector('[data-testid="remote-job-badge"]')?.parentElement

    expect(jobBar?.classList.contains('min-h-9')).toBe(true)
    expect(jobBar?.classList.contains('bg-bg-000')).toBe(true)
    expect(jobBar?.classList.contains('motion-safe:animate-in')).toBe(false)
  })

  it('remounts the bar when a Notebook appears after jobs', () => {
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: undefined
      }
    })
    const jobBar = container.querySelector('[data-testid="remote-job-badge"]')?.parentElement

    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: notebookReference
      }
    })
    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement

    expect(notebookBar).not.toBe(jobBar)
    expect(notebookBar?.classList.contains('motion-safe:animate-in')).toBe(true)
  })

  it('does not layer card shadows behind the composer border', () => {
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: notebookReference
      }
    })

    const notebookBar = container.querySelector('[aria-label="Open notebook"]')?.parentElement
    const composerBackdrop = getComposerForm().previousElementSibling

    expect(notebookBar?.classList.contains('shadow-card')).toBe(false)
    expect(composerBackdrop?.classList.contains('shadow-card')).toBe(false)
  })

  it('shows both the Notebook button and the job badge when both are present', () => {
    mockHasRunningJobs = true
    mockAllJobs = [{ job_id: 'job-1', status: 'running', created_at: Date.now() }]
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: notebookReference
      }
    })

    expect(container.querySelector('[aria-label="Open notebook"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="remote-job-badge"]')).not.toBeNull()
  })

  it('keeps the notebook bar visible when there are finished jobs but no running jobs', () => {
    mockHasRunningJobs = false
    mockAllJobs = [{ job_id: 'job-1', status: 'done', created_at: Date.now() }]
    renderPanel({
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: undefined
      }
    })

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
      view: {
        activeSession: session
      },
      sessionTools: {
        notebookReference: undefined,
        openJobs: handleOpenJobList
      }
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
    renderPanel({
      view: {
        activeSession: errorSession
      }
    })
    expect(errorBoxText()).toContain('Run failed: connection reset')
    expect(reportButton()).not.toBeNull()
  })

  it('renders the error box for a failed run even when it has no error text', () => {
    renderPanel({
      view: {
        activeSession: { ...errorSession, error: undefined }
      }
    })
    // The shown fallback equals the text seeded into the report (single RUN_FAILED_FALLBACK_ERROR),
    // upholding the "shown == reported" invariant when a failed run carries no error message.
    expect(errorBoxText()).toContain('The run failed with no error message.')
    // Still reportable — the affordance follows the failure status, not the presence of text.
    expect(reportButton()).not.toBeNull()
  })

  it('shows only the transient actionError, without a Report button, for a non-failed session', () => {
    renderPanel({
      view: {
        activeSession: { ...errorSession, status: 'idle', error: undefined },
        actionError: 'Could not send message'
      }
    })
    expect(errorBoxText()).toContain('Could not send message')
    expect(reportButton()).toBeNull()
  })

  it('opens Model settings from the image-support action error', () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel })
    renderPanel({
      view: {
        activeSession: { ...errorSession, status: 'idle', error: undefined },
        actionError: VISION_MODEL_NOT_CONFIGURED_MESSAGE
      }
    })

    expect(errorBoxText()).toContain("The selected model doesn't support images.")
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Model settings'
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(openSettingsToPanel).toHaveBeenCalledWith('model')
  })

  it('keeps the Model settings recovery action for a persisted legacy Vision error', () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel })
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          error: 'Configure a Vision model in Settings > Model before sending images to this model.'
        }
      }
    })

    expect(errorBoxText()).toContain("The selected model doesn't support images.")
    expect(reportButton()).toBeNull()
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Model settings'
    )
    act(() => button?.click())
    expect(openSettingsToPanel).toHaveBeenCalledWith('model')
  })

  it('opens Agent settings instead of reporting an unsupported Codex ACP version', () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel })
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          error:
            'Codex ACP adapter 1.1.4 is no longer supported. Update to 1.6.2 or later in settings.',
          errorReportable: true
        }
      }
    })

    expect(errorBoxText()).toContain('Codex ACP adapter 1.1.4 is no longer supported.')
    expect(reportButton()).toBeNull()
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Agent settings'
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(openSettingsToPanel).toHaveBeenCalledWith('agent')
  })

  it('opens Agent settings from an unsupported Codex ACP session resume failure', () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel })
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          interrupted: true,
          error:
            'Agent session resume failed: Codex ACP adapter 1.1.4 is no longer supported. Update to 1.6.2 or later in settings.'
        }
      }
    })

    expect(errorBoxText()).toContain('Agent session resume failed: Codex ACP adapter 1.1.4')
    expect(container.querySelector('[aria-label="Resume session"]')).toBeNull()
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Agent settings'
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(openSettingsToPanel).toHaveBeenCalledWith('agent')
  })

  it('keeps an unrelated session resume failure in the Resume banner', () => {
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          interrupted: true,
          error: 'Agent session resume failed: connection reset'
        }
      }
    })

    expect(container.querySelector('[aria-label="Resume session"]')).not.toBeNull()
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'Agent settings'
      )
    ).toBeUndefined()
  })

  it('shows both a transient actionError and the run failure, keeping the Report button', () => {
    // Both present: each error gets its own row, and the run failure keeps its report entry — a
    // transient error must not suppress the ability to report the actual failure.
    renderPanel({
      view: {
        activeSession: errorSession,
        actionError: 'Could not send message'
      }
    })
    const text = errorBoxText()
    expect(text).toContain('Could not send message')
    expect(text).toContain('Run failed: connection reset')
    expect(reportButton()).not.toBeNull()
  })

  it('keeps a reportable run action beside unsupported Codex action guidance', () => {
    renderPanel({
      view: {
        activeSession: { ...errorSession, errorReportable: true },
        actionError:
          'Codex ACP adapter 1.1.4 is no longer supported. Update to 1.6.2 or later in settings.'
      }
    })

    expect(reportButton()).not.toBeNull()
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (candidate) => candidate.textContent === 'Agent settings'
      )
    ).toBe(true)
  })

  it('opens the report dialog when the Report button is clicked', () => {
    renderPanel({
      view: {
        activeSession: errorSession
      }
    })
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
    renderPanel({
      view: {
        activeSession: { ...errorSession, error: undefined }
      }
    })
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
    renderPanel({
      view: {
        activeSession: { ...errorSession, error: '   ' }
      }
    })
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
      view: {
        activeSession: {
          ...errorSession,
          error: 'Session workspace is missing; start a new conversation.'
        }
      }
    })
    expect(errorBoxText()).toContain('Session workspace is missing')
    expect(reportButton()).toBeNull()
  })

  it('unwraps and localizes an app-owned Vision relay failure', () => {
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          error:
            "Error invoking remote method 'acp:send-prompt': Error: The Vision model returned invalid image evidence."
        }
      }
    })

    expect(errorBoxText()).toContain('The Vision model returned invalid image evidence.')
    expect(errorBoxText()).not.toContain('Error invoking remote method')
    expect(reportButton()).toBeNull()
  })

  it('hides the Report button for a model-provider error (tagged non-reportable at the ACP layer)', () => {
    // A provider/model failure is tagged structurally (errorReportable: false), not by its text —
    // the raw provider message is kept visible but is not a bug worth a GitHub issue.
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          error: 'Invalid API key',
          errorReportable: false
        }
      }
    })
    expect(errorBoxText()).toContain('Invalid API key')
    expect(reportButton()).toBeNull()
  })

  it('shows the Report button when a persisted error predates the reportable flag (undefined)', () => {
    // Old sessions have no errorReportable; fall back to classifying the text — an opaque failure
    // stays reportable, an app-crafted reminder does not.
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          error: 'Run failed: connection reset',
          errorReportable: undefined
        }
      }
    })
    expect(reportButton()).not.toBeNull()
  })

  it('hides the Report button for a persisted Claude API connection failure without the reportable flag', () => {
    renderPanel({
      view: {
        activeSession: {
          ...errorSession,
          error: 'Internal error: API Error: Unable to connect to API (ConnectionRefused)',
          errorReportable: undefined
        }
      }
    })
    expect(errorBoxText()).toContain('Unable to connect to API (ConnectionRefused)')
    expect(reportButton()).toBeNull()
  })
})
