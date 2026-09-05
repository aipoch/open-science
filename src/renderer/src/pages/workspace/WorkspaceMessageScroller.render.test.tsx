import { renderToStaticMarkup } from 'react-dom/server'
import type { JSX, PropsWithChildren } from 'react'
import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'
import type { JobSummary } from '../../../../shared/compute'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource
} from '../../../../shared/handoff-lifecycle'
import { describe, expect, it, vi } from 'vitest'

import type { ToolActivityDetails } from './workspace-tool-activity-details'

const reviewStoreMock = vi.hoisted(() => ({ loadError: undefined as string | undefined }))

vi.mock('./WorkspaceRunMarks', () => ({
  WorkspaceRunMarks: ({ items }: { items: readonly unknown[] }) => (
    <div data-testid="workspace-run-marks" data-item-count={items.length} />
  )
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('@/components/streamdown/use-smooth-streaming-content', () => ({
  useSmoothStreamingContent: (
    content: string,
    sourceOpen: boolean,
    animateOnMount = sourceOpen
  ) => ({ content, isPresenting: animateOnMount })
}))

vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: PropsWithChildren): JSX.Element => <div>{children}</div>
  const Item = ({
    children,
    disableContainment,
    messageId
  }: PropsWithChildren<{ disableContainment?: boolean; messageId?: string }>): JSX.Element => (
    <div data-message-id={messageId} data-disable-containment={disableContainment || undefined}>
      {children}
    </div>
  )
  const Button = (): JSX.Element => <button type="button">Scroll to end</button>

  return {
    MessageScrollerProvider: Wrapper,
    MessageScroller: Wrapper,
    MessageScrollerViewport: Wrapper,
    MessageScrollerContent: Wrapper,
    MessageScrollerItem: Item,
    MessageScrollerButton: Button,
    useMessageScroller: () => ({
      scrollToEnd: vi.fn(),
      scrollToMessage: vi.fn(),
      scrollToStart: vi.fn()
    })
  }
})

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' '),
  formatByteSize: (size: number | undefined) =>
    typeof size === 'number' && size >= 0 ? `${size} B` : undefined
}))

// Stub the highlighted/diff blocks so SSR output stays deterministic without loading Shiki.
vi.mock('./WorkspaceToolCodeBlock', () => ({
  WorkspaceToolCodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="tool-code-block" data-language={language}>
      {code}
    </pre>
  )
}))

vi.mock('./WorkspaceToolDiffBlock', () => ({
  WorkspaceToolDiffBlock: ({
    section
  }: {
    section: { oldText: string | null; newText: string }
  }) => (
    <pre data-testid="tool-diff-block">
      {section.oldText}
      {section.newText}
    </pre>
  )
}))

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ upsertAndActivateItem: vi.fn() })
  },
  createSessionReviewerPreviewItem: vi.fn(() => ({
    id: 'tool:session-1:reviewer',
    sessionId: 'session-1',
    type: 'tool',
    toolKind: 'reviewer',
    title: 'Session Reviewer'
  }))
}))

vi.mock('@/stores/review-store', () => ({
  selectProjectSessionReviews: () => [],
  selectProjectSessionReviewLoadError: () => reviewStoreMock.loadError,
  selectReviewRunsForMessage: () => [],
  useReviewStore: (
    selector: (state: {
      reviewsBySession: Record<string, never[]>
      loadReviewsForSession: () => Promise<void>
    }) => unknown
  ) =>
    selector({
      reviewsBySession: {},
      loadReviewsForSession: () => Promise.resolve()
    })
}))

vi.mock('@/components/ReviewerCard', () => ({
  ReviewerCard: () => null
}))

// Stub CompletedJobCard so we can detect renders by data-testid without Lucide imports.
vi.mock('@/components/CompletedJobCard', () => ({
  CompletedJobCard: ({ job }: { job: JobSummary }) => (
    <div data-testid="completed-job-card" data-job-id={job.job_id}>
      {job.intent}
    </div>
  )
}))

// Stub JobDetailModal — not relevant to timeline rendering tests.
vi.mock('@/components/JobDetailModal', () => ({
  JobDetailModal: () => null
}))

// Default session-job-store mock: no jobs. Override per-test with mockJobsById assignment.
let mockJobsById: Map<string, JobSummary> = new Map()

vi.mock('@/stores/session-job-store', () => ({
  useSessionJobStore: (
    selector: (s: {
      jobsById: Map<string, JobSummary>
      loadErrorBySession: Map<string, string>
      hydrate: () => Promise<void>
    }) => unknown
  ) =>
    selector({
      jobsById: mockJobsById,
      loadErrorBySession: new Map(),
      hydrate: () => Promise.resolve()
    })
}))

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Session',
  cwd: '/workspace',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-search-1',
  kind: 'tool',
  title: '"top news July 6 2026"',
  status: 'completed',
  eventIds: ['event-1'],
  sortIndex: 2,
  toolKind: 'fetch',
  createdAt: 1710000000001,
  updatedAt: 1710000000001,
  ...overrides
})

const createUpload = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-1',
  name: 'first.png',
  originalName: 'first.png',
  path: '/Users/example/.open-science/uploads/default-project/session-1/first.png',
  mimeType: 'image/png',
  size: 1024,
  ...overrides
})

const renderScroller = async (
  session: ChatSession,
  props: {
    credentialPending?: boolean
    isResumingSession?: boolean
    optimisticMessage?: ChatMessage
  } = {}
): Promise<string> => {
  const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')

  return renderToStaticMarkup(
    <WorkspaceMessageScroller
      activeSession={session}
      credentialPending={props.credentialPending}
      isResumingSession={props.isResumingSession}
      optimisticMessage={props.optimisticMessage}
      onSendEditedMessage={vi.fn()}
    />
  )
}

describe('WorkspaceMessageScroller optimistic send render', () => {
  it('renders a sending user bubble before the authoritative Message is admitted', async () => {
    const html = await renderScroller(createSession({ status: 'idle' }), {
      optimisticMessage: createMessage({
        id: 'optimistic-session-1-1',
        content: 'Follow-up request',
        createdAt: 0,
        updatedAt: 0
      })
    })

    expect(html).toContain('data-message-id="optimistic-session-1-1"')
    expect(html).toContain('data-slot="user-message-bubble"')
    expect(html).toContain('Follow-up request')
    expect(html).toContain('Sending…')
  })
})

describe('WorkspaceMessageScroller Run Marks render', () => {
  it('passes the presented conversation to Run Marks', async () => {
    const oneRun = await renderScroller(
      createSession({ messages: [createMessage({ id: 'prompt-1', content: 'First prompt' })] })
    )
    expect(oneRun).toContain('data-testid="workspace-run-marks"')
    expect(oneRun).toContain('data-item-count="1"')

    const twoRuns = await renderScroller(
      createSession({
        activeRun: { promptMessageId: 'prompt-2', startedAt: 1710000000200 },
        messages: [
          createMessage({ id: 'prompt-1', content: 'First prompt' }),
          createMessage({
            id: 'response-1',
            role: 'agent',
            content: 'First response',
            responseToMessageId: 'prompt-1'
          }),
          createMessage({ id: 'prompt-2', content: 'Second prompt' })
        ]
      })
    )
    expect(twoRuns).toContain('data-item-count="3"')
  })
})

describe('WorkspaceMessageScroller empty conversation banner', () => {
  it('shows the banner for a new conversation with no messages', async () => {
    const html = await renderScroller(createSession({}))

    expect(html).toContain('data-testid="empty-conversation-banner"')
    expect(html).toContain('What will you research in Open Science?')
  })

  it('hides the banner once the conversation has messages', async () => {
    const html = await renderScroller(
      createSession({ messages: [createMessage({ id: 'prompt-1', content: 'First prompt' })] })
    )

    expect(html).not.toContain('data-testid="empty-conversation-banner"')
  })

  it('hides the banner while a session is resuming', async () => {
    const html = await renderScroller(createSession({}), { isResumingSession: true })

    expect(html).not.toContain('data-testid="empty-conversation-banner"')
  })
})

describe('WorkspaceMessageScroller Reviewer load error', () => {
  it('renders an alert with a retry action', async () => {
    reviewStoreMock.loadError = 'db down'
    let html: string
    try {
      html = await renderScroller(createSession({}))
    } finally {
      reviewStoreMock.loadError = undefined
    }

    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not load review history.')
    expect(html).toContain('Retry')
  })
})

describe('WorkspaceMessageScroller Reviewer Correction lifecycle', () => {
  const correction = createMessage({
    id: 'correction-1',
    content: '[Auditor] Durable correction instructions',
    attribution: {
      kind: 'application',
      feature: 'reviewer',
      purpose: 'correction',
      causeReviewId: 'review-1'
    }
  })

  it('animates only the active correction before an Agent response exists', async () => {
    const active = await renderScroller(
      createSession({
        activeRun: { promptMessageId: correction.id, startedAt: correction.createdAt },
        messages: [correction]
      })
    )
    expect(active).toContain('data-active="true"')
    expect(active).toContain('Agent is addressing the feedback')
    expect(active).toContain('motion-reduce:animate-none')
    expect(active).not.toContain(correction.content)

    const responded = await renderScroller(
      createSession({
        activeRun: { promptMessageId: correction.id, startedAt: correction.createdAt },
        messages: [
          correction,
          createMessage({
            id: 'correction-response',
            role: 'agent',
            content: 'Correction complete.',
            status: 'streaming',
            responseToMessageId: correction.id,
            createdAt: correction.createdAt + 1,
            updatedAt: correction.updatedAt + 1
          })
        ]
      })
    )
    expect(responded).toContain('Corrections requested')
    expect(responded).toContain('Handed off to the Agent · response started')
    expect(responded).toContain('data-active="true"')
    expect(responded).not.toContain('Agent is addressing the feedback')
    expect(responded).not.toContain(correction.content)
  })

  it('marks a reloaded historical correction without a durable response as failed', async () => {
    const html = await renderScroller(
      createSession({ status: 'idle', activeRun: undefined, messages: [correction] })
    )
    expect(html).toContain('Corrections requested')
    expect(html).toContain('Response failed.')
    expect(html).toContain('reviewer-correction-failed-icon')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain(correction.content)
  })

  it('marks a correction with a durable Agent response as completed', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        activeRun: undefined,
        messages: [
          correction,
          createMessage({
            id: 'correction-response',
            role: 'agent',
            content: 'Correction complete.',
            responseToMessageId: correction.id,
            createdAt: correction.createdAt + 1,
            updatedAt: correction.updatedAt + 1
          })
        ]
      })
    )
    expect(html).toContain('Corrections requested')
    expect(html).toContain('Response completed.')
    expect(html).toContain('reviewer-correction-settled-icon')
    expect(html).not.toContain('animate-spin')
  })

  it('marks an inactive correction with a dangling streaming response as failed', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        activeRun: undefined,
        messages: [
          correction,
          createMessage({
            id: 'dangling-correction-response',
            role: 'agent',
            content: 'Partial correction.',
            status: 'streaming',
            responseToMessageId: correction.id,
            createdAt: correction.createdAt + 1,
            updatedAt: correction.updatedAt + 1
          })
        ]
      })
    )
    expect(html).toContain('Corrections requested')
    expect(html).toContain('Response failed.')
    expect(html).toContain('reviewer-correction-failed-icon')
    expect(html).not.toContain('animate-spin')
  })

  it('keeps a reloaded Compute completion as a system event', async () => {
    const compute = createMessage({
      id: 'compute-completion-1',
      content: 'A remote job has finished. Please analyze the results.',
      presentation: { kind: 'compute-job-completion' }
    })
    const html = await renderScroller(
      createSession({ status: 'idle', activeRun: undefined, messages: [compute] })
    )

    expect(html).toContain('data-testid="compute-job-completion-event"')
    expect(html).toContain('Remote job completed')
    expect(html).toContain('Analysis started automatically')
    expect(html).not.toContain(compute.content)
    expect(html).not.toContain('data-slot="user-message-bubble"')
  })
})

const planDocument: ActivePlanProjection['document'] = {
  schema_version: 1,
  task_summary: 'Prepare the publication package',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Evidence',
          steps: [{ title: 'Inspect sources', description: 'Check every primary source.' }]
        }
      ]
    }
  ],
  desired_outputs: ['PDF report'],
  feasibility: { confidence: 'high', rationale: 'The sources are available.' }
}

const createPlanAuthoritySession = (
  activities: ToolActivity[],
  overrides: Partial<ChatSession> = {},
  materializedAt = 1710000000100
): ChatSession => {
  const artifactChecksum = 'a'.repeat(64)
  const activePlanProjection: ActivePlanProjection = {
    artifactId: 'artifact-plan',
    artifactVersionId: 'version-plan',
    artifactChecksum,
    originatingPromptMessageId: 'prompt-plan',
    materializedAt,
    revision: 1,
    approval: 'pending',
    lifecycle: 'awaiting_approval',
    document: planDocument,
    stepStatuses: {},
    stepStates: { 'Inspect sources': { status: 'not_started' } },
    counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
  }

  return createSession({
    id: 'session-plan-authority',
    status: 'waiting-plan-approval',
    activities,
    artifacts: [
      {
        id: 'version-plan',
        artifactId: 'artifact-plan',
        versionId: 'version-plan',
        kind: 'managed-file',
        path: '/workspace/plan.json',
        name: 'plan.json',
        mtimeMs: 1710000000100,
        sha256: artifactChecksum
      }
    ],
    runtimeContext: {
      version: 1,
      revision: 1,
      plan: {
        artifactId: 'artifact-plan',
        artifactVersionId: 'version-plan',
        artifactChecksum,
        originatingPromptMessageId: 'prompt-plan',
        materializedAt,
        approval: 'pending',
        stepStatuses: {}
      }
    },
    activePlanProjection,
    ...overrides
  })
}

const createGeneratePlanActivity = (
  status: ToolActivity['status'],
  overrides: Partial<ToolActivity> = {}
): ToolActivity =>
  createActivity({
    id: `generate-plan-${status}`,
    title: 'generate_plan',
    providerToolName: 'mcp__open-science-plan__generate_plan',
    promptMessageId: 'prompt-plan',
    status,
    rawInput: planDocument,
    createdAt: 1710000000050,
    updatedAt: 1710000000050,
    ...overrides
  })

describe('WorkspaceMessageScroller durable Plan activity render', () => {
  it.each(['in_progress', 'failed'] as const)(
    'renders a %s generation call as created once its matching Plan authority exists',
    async (status) => {
      const html = await renderScroller(
        createPlanAuthoritySession([createGeneratePlanActivity(status)])
      )

      expect(html).toContain('Created execution Plan')
      expect(html).not.toContain('Creating execution Plan')
      expect(html).not.toContain('Failed to create execution Plan')
    }
  )

  it('uses the authoritative Plan projection before Artifact metadata is published', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([createGeneratePlanActivity('in_progress')], {
        artifacts: undefined
      })
    )

    expect(html).toContain('Created execution Plan')
    expect(html).not.toContain('Creating execution Plan')
  })

  it('uses a live Plan projection before renderer runtime authority is synchronized', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([createGeneratePlanActivity('in_progress')], {
        artifacts: undefined,
        runtimeContext: undefined
      })
    )

    expect(html).toContain('Created execution Plan')
    expect(html).not.toContain('Creating execution Plan')
  })

  it('prefers a replacement Plan projection over stale renderer runtime authority', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([createGeneratePlanActivity('in_progress')], {
        artifacts: undefined,
        runtimeContext: {
          version: 1,
          revision: 0,
          plan: {
            artifactId: 'old-artifact',
            artifactVersionId: 'old-version',
            artifactChecksum: 'b'.repeat(64),
            originatingPromptMessageId: 'old-prompt',
            materializedAt: 1,
            approval: 'pending',
            stepStatuses: {}
          }
        }
      })
    )

    expect(html).toContain('Created execution Plan')
    expect(html).not.toContain('Creating execution Plan')
  })

  it('keeps a failed generation call failed without matching Plan authority', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        activities: [createGeneratePlanActivity('failed')]
      })
    )

    expect(html).toContain('Failed to create execution Plan')
    expect(html).not.toContain('Created execution Plan')
  })

  it('does not assign an earlier Plan artifact to a later retry from the same prompt', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([
        createGeneratePlanActivity('failed', { id: 'original-plan-call' }),
        createGeneratePlanActivity('failed', {
          id: 'later-plan-retry',
          createdAt: 1710000000200,
          updatedAt: 1710000000200
        })
      ])
    )

    expect(html.match(/Created execution Plan/gu)).toHaveLength(1)
    expect(html.match(/Failed to create execution Plan/gu)).toHaveLength(1)
  })

  it('keeps the durable Plan created while projecting a legacy already-pending retry neutrally', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([
        createGeneratePlanActivity('failed', {
          id: 'original-plan-call',
          rawOutput: 'UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error'
        }),
        createGeneratePlanActivity('failed', {
          id: 'invalid-plan-retry',
          rawInput: { ...planDocument, phases: [{ delegations: [] }] },
          rawOutput: 'phases[0].name is required',
          createdAt: 1710000000200,
          updatedAt: 1710000000200
        }),
        createGeneratePlanActivity('failed', {
          id: 'legacy-already-pending-plan-retry',
          rawOutput: 'A Session Plan is already awaiting approval.',
          createdAt: 1710000000300,
          updatedAt: 1710000000300
        })
      ])
    )

    expect(html.match(/data-testid="plan-call-record"/gu)).toHaveLength(3)
    expect(html.match(/Created execution Plan/gu)).toHaveLength(1)
    expect(html.match(/Failed to create execution Plan/gu)).toHaveLength(1)
    expect(html).toContain('Execution Plan already awaiting approval')
    expect(html.match(/lucide-circle-alert/gu)).toHaveLength(1)
    expect(html).not.toContain('A Session Plan is already awaiting approval.')
  })

  it('projects a structured live approval waiter conflict neutrally without exposing its payload', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([
        createGeneratePlanActivity('failed', {
          id: 'original-plan-call',
          rawOutput: 'UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error'
        }),
        createGeneratePlanActivity('failed', {
          id: 'structured-already-pending-retry',
          rawOutput: {
            isError: true,
            structuredContent: {
              error: {
                code: 'approval-already-pending',
                message: 'Internal live interaction waiter call_123 is still registered.'
              }
            },
            content: [
              {
                type: 'text',
                text: '{"error":{"code":"approval-already-pending","message":"Internal live interaction waiter call_123 is still registered."}}'
              }
            ]
          },
          createdAt: 1710000000200,
          updatedAt: 1710000000200
        })
      ])
    )

    expect(html.match(/Created execution Plan/gu)).toHaveLength(1)
    expect(html).toContain('Execution Plan already awaiting approval')
    expect(html).toContain('lucide-circle size-3.5 text-text-300')
    expect(html).not.toContain('Failed to create execution Plan')
    expect(html).not.toContain('approval-already-pending')
    expect(html).not.toContain('Internal live interaction waiter')
    expect(html).not.toContain('call_123')
  })

  it('warns that a different pending Plan revision was not submitted from its structured code', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession([
        createGeneratePlanActivity('failed', {
          id: 'original-plan-call',
          rawOutput: 'UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error'
        }),
        createGeneratePlanActivity('failed', {
          id: 'different-plan-retry',
          rawInput: { ...planDocument, task_summary: 'Prepare a different report' },
          rawOutput: {
            isError: true,
            structuredContent: {
              error: {
                code: 'plan-review-pending',
                message: 'Internal checksum conflict for Artifact version-plan.'
              }
            },
            content: [
              {
                type: 'text',
                text: '{"error":{"code":"plan-review-pending","message":"Internal checksum conflict for Artifact version-plan."}}'
              }
            ]
          },
          createdAt: 1710000000200,
          updatedAt: 1710000000200
        })
      ])
    )

    expect(html.match(/Created execution Plan/gu)).toHaveLength(1)
    expect(html).toContain('Plan revision not submitted')
    expect(html).toContain(
      'Review or dismiss the current execution Plan before submitting a revision.'
    )
    expect(html).toContain('lucide-triangle-alert')
    expect(html).not.toContain('Failed to create execution Plan')
    expect(html).not.toContain('Execution Plan already awaiting approval')
    expect(html).not.toContain('plan-review-pending')
    expect(html).not.toContain('Internal checksum conflict')
    expect(html).not.toContain('version-plan')
  })

  it('uses the materialization boundary to assign a successful same-document retry', async () => {
    const html = await renderScroller(
      createPlanAuthoritySession(
        [
          createGeneratePlanActivity('failed', { id: 'failed-plan-call' }),
          createGeneratePlanActivity('in_progress', {
            id: 'successful-plan-retry',
            createdAt: 1710000000200,
            updatedAt: 1710000000200
          })
        ],
        { artifacts: undefined },
        1710000000250
      )
    )

    expect(html.match(/Created execution Plan/gu)).toHaveLength(1)
    expect(html).toContain('Failed to create execution Plan')
    expect(html).not.toContain('Creating execution Plan')
  })
})

describe('WorkspaceMessageScroller structured input render', () => {
  it('renders a completed custom answer as a standalone transcript card', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        activities: [
          createActivity({
            id: 'tool-ask-1',
            title: 'AskUserQuestion',
            elicitation: {
              message: 'What kind of skill are you trying to create?',
              fields: [{ id: 'question_0_custom', label: 'Other', kind: 'text' }],
              state: 'answered',
              answers: [{ fieldId: 'question_0_custom', value: 'A literature review skill' }]
            }
          })
        ]
      })
    )

    expect(html).toContain('data-testid="elicitation-card"')
    expect(html).toContain('What kind of skill are you trying to create?')
    expect(html).toContain('A literature review skill')
    expect(html).not.toContain('data-testid="tool-group"')
  })

  it('renders the selected option label instead of its protocol value', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        activities: [
          createActivity({
            id: 'tool-ask-1',
            elicitation: {
              message: 'Choose an approach',
              fields: [
                {
                  id: 'approach',
                  label: 'Approach',
                  kind: 'single-select',
                  options: [{ value: 'minimal', label: 'Minimal change' }]
                }
              ],
              state: 'answered',
              answers: [{ fieldId: 'approach', value: 'minimal' }]
            }
          })
        ]
      })
    )

    expect(html).toContain('Minimal change')
    expect(html).not.toContain('>minimal<')
  })
})

describe('WorkspaceMessageScroller loading render', () => {
  it('renders elapsed time beside the activity step count', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-read-1',
            title: 'Read file',
            toolKind: 'read',
            createdAt: 1_000,
            updatedAt: 1_250
          }),
          createActivity({
            id: 'tool-read-2',
            title: 'Read file',
            toolKind: 'read',
            sortIndex: 3,
            createdAt: 1_300,
            updatedAt: 2_650
          })
        ]
      })
    )

    expect(html).toContain('2 steps · 1s')
  })

  it('renders a coordinator-owned handoff status in the original turn timeline', async () => {
    const source: HandoffLifecycleEventSource = {
      getEvents: (): readonly HandoffLifecycleEvent[] => [
        {
          id: 'handoff-1',
          sessionId: 'session-1',
          sequence: 2,
          observedAt: 1710000000100,
          phase: 'reconfiguring',
          target: { kind: 'specialist', name: 'Data analyst' },
          provenance: {
            originatingTurnId: 'turn-1',
            originatingUserMessageId: 'prompt-1',
            attachmentIds: ['upload-1'],
            artifactIds: ['artifact-1']
          }
        }
      ],
      subscribe: () => () => undefined
    }
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const html = renderToStaticMarkup(
      <WorkspaceMessageScroller
        activeSession={createSession({
          messages: [
            createMessage({ id: 'prompt-1', createdAt: 1710000000000 }),
            createMessage({
              id: 'pre-handoff-output',
              role: 'agent',
              content: 'I will inspect the input first.',
              responseToMessageId: 'prompt-1',
              createdAt: 1710000000200
            })
          ]
        })}
        onSendEditedMessage={vi.fn()}
        handoffLifecycleSource={source}
      />
    )

    expect(html).toContain('Reconfiguring Data analyst')
    expect(html).toContain('data-originating-user-message-id="prompt-1"')
    expect(html.indexOf('Reconfiguring Data analyst')).toBeLessThan(
      html.indexOf('I will inspect the input first.')
    )
  })

  it('renders an accessible agent loading row before streamed text arrives', async () => {
    const html = await renderScroller(
      createSession({
        agentStatus: 'retrying root request…',
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Summarize this'
          })
        ]
      })
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('data-testid="open-science-thinking-indicator"')
    expect(html).toContain('>Thinking</span>')
    expect(html).toContain('retrying root request…')
    expect(html).toContain('data-message-id="session-1-agent-loading"')
    const loadingSurfaceClassName = html.match(
      /<div class="([^"]*max-w-\[56rem\][^"]*)"><div class="flex min-h-5/
    )?.[1]
    expect(loadingSurfaceClassName).toContain('px-0')
    expect(loadingSurfaceClassName).not.toContain('px-3')
  })

  it('shows tool interaction while a tool is running before the first agent token', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [createActivity({ status: 'in_progress' })]
      })
    )

    expect(html).toContain('data-testid="open-science-thinking-indicator"')
    expect(html).toContain('>Interacting with tools</span>')
    expect(html).not.toContain('>0:00</span>')
  })

  it('restores the loading row after a completed tool while the next agent token is pending', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [
          createMessage({ id: 'prompt-1', sortIndex: 1 }),
          createMessage({
            id: 'reply-before-tool',
            role: 'agent',
            content: 'I will save the file now.',
            responseToMessageId: 'prompt-1',
            sortIndex: 2
          })
        ],
        activities: [
          createActivity({
            id: 'tool-write-1',
            title: 'Saved a file',
            status: 'completed',
            promptMessageId: 'prompt-1',
            sortIndex: 3
          })
        ]
      })
    )

    expect(html).toContain('data-testid="open-science-thinking-indicator"')
    expect(html).toContain('>Thinking</span>')
  })

  it('keeps the loading row after multiple tool rounds while the run is still active', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [
          createMessage({ id: 'prompt-1', sortIndex: 1 }),
          createMessage({
            id: 'reply-after-first-tool',
            role: 'agent',
            content: 'The chart is ready. I will adjust it next.',
            status: 'streaming',
            streamId: 'assistant-message-1',
            responseToMessageId: 'prompt-1',
            sortIndex: 4,
            updatedAt: 1710000000400
          }),
          createMessage({
            id: 'reply-after-second-tool',
            role: 'agent',
            content: 'The chart looks good. Next I will generate the report.',
            status: 'streaming',
            streamId: 'assistant-message-2',
            responseToMessageId: 'prompt-1',
            sortIndex: 6,
            updatedAt: 1710000000600
          })
        ],
        activities: [
          createActivity({
            id: 'tool-read-1',
            title: 'Used tool: ToolRead',
            promptMessageId: 'prompt-1',
            sortIndex: 3,
            updatedAt: 1710000000300
          }),
          createActivity({
            id: 'tool-read-2',
            title: 'Used tool: ToolRead',
            promptMessageId: 'prompt-1',
            sortIndex: 5,
            updatedAt: 1710000000500
          })
        ]
      })
    )

    expect(html).toContain('The chart looks good. Next I will generate the report.')
    expect(html).toContain('data-testid="open-science-thinking-indicator"')
    expect(html).toContain('>Thinking</span>')
  })

  it('continues rendering loading after current-run agent text while the run remains active', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Answer text',
            status: 'streaming',
            streamId: 'assistant-message-1',
            responseToMessageId: 'prompt-1'
          })
        ]
      })
    )

    expect(html).toContain('data-testid="open-science-thinking-indicator"')
    expect(html).toContain('>Thinking</span>')
    expect(html).toContain('Answer text')
  })

  it('calculates elapsed time and keeps token totals behind the Usage summary', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1', createdAt: 1710000000000 }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Answer text',
            responseToMessageId: 'prompt-1',
            createdAt: 1710000030000,
            completedAt: 1710000125000,
            updatedAt: 1710000999000,
            turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90 }
          })
        ]
      })
    )

    expect(html).toContain('Completed ')
    expect(html).toContain('Elapsed 2m 5s')
    expect(html).toContain('>Calls</button>')
    expect(html).not.toContain('Input</dt>')
  })

  it('keeps persisted completed and failed timestamps outside live regions', async () => {
    const completedHtml = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-complete' }),
          createMessage({
            id: 'reply-complete',
            role: 'agent',
            content: 'Done',
            responseToMessageId: 'prompt-complete',
            completedAt: 1710000001000
          })
        ]
      })
    )
    const failedHtml = await renderScroller(
      createSession({
        status: 'error',
        messages: [
          createMessage({ id: 'prompt-failed' }),
          createMessage({
            id: 'reply-failed',
            role: 'agent',
            content: 'Could not finish',
            status: 'error',
            responseToMessageId: 'prompt-failed',
            failedAt: 1710000001000
          })
        ]
      })
    )

    const completedTimestamp = completedHtml.match(/<time[^>]*>Completed [^<]*<\/time>/)?.[0]
    const failedTimestamp = failedHtml.match(/<time[^>]*>Failed [^<]*<\/time>/)?.[0]

    expect(completedTimestamp).toBeDefined()
    expect(completedTimestamp).not.toContain('role=')
    expect(completedTimestamp).not.toContain('aria-live=')
    expect(failedTimestamp).toBeDefined()
    expect(failedTimestamp).not.toContain('role=')
    expect(failedTimestamp).not.toContain('aria-live=')
  })
  it('does not expose the fallback framework from a synthesized legacy graph', async () => {
    const messages = [
      createMessage({ id: 'prompt-1' }),
      createMessage({
        id: 'reply-1',
        role: 'agent',
        content: 'Legacy answer',
        completedAt: 1710000001000
      })
    ]
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages,
        conversationGraph: createLinearConversationGraph({
          sessionId: 'session-1',
          messages,
          createdAt: 1710000000000,
          updatedAt: 1710000001000
        })
      })
    )

    expect(html).not.toContain('>Calls</button>')
  })

  it('renders completion metadata once after the final assistant message fragment in a tool turn', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1', createdAt: 1710000000000, sortIndex: 1 }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'I loaded the skill.',
            responseToMessageId: 'prompt-1',
            createdAt: 1710000030000,
            completedAt: 1710000125000,
            sortIndex: 2
          }),
          createMessage({
            id: 'reply-2',
            role: 'agent',
            content: 'I found the baseline count.',
            responseToMessageId: 'prompt-1',
            createdAt: 1710000060000,
            completedAt: 1710000125000,
            sortIndex: 4
          }),
          createMessage({
            id: 'reply-3',
            role: 'agent',
            content: 'Here is the final answer.',
            responseToMessageId: 'prompt-1',
            createdAt: 1710000090000,
            completedAt: 1710000125000,
            sortIndex: 6
          })
        ],
        activities: [
          createActivity({
            id: 'activity-1',
            title: 'First tool action',
            sortIndex: 3,
            createdAt: 1710000045000,
            updatedAt: 1710000045000
          }),
          createActivity({
            id: 'activity-2',
            title: 'Second tool action',
            sortIndex: 5,
            createdAt: 1710000075000,
            updatedAt: 1710000075000
          })
        ]
      })
    )

    const timelineContent = [
      'I loaded the skill.',
      'data-message-id="activity-group-activity-1"',
      'I found the baseline count.',
      'data-message-id="activity-group-activity-2"',
      'Here is the final answer.'
    ]
    const timelinePositions = timelineContent.map((content) => html.indexOf(content))

    expect(timelinePositions.every((position) => position >= 0)).toBe(true)
    expect(timelinePositions).toEqual([...timelinePositions].sort((left, right) => left - right))
    expect(html.match(/data-slot="assistant-message-footer"/g)).toHaveLength(1)
    expect(html.indexOf('data-slot="assistant-message-footer"')).toBeGreaterThan(
      html.indexOf('Here is the final answer.')
    )
  })

  it('renders completion metadata after a tool that follows the final assistant fragment', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1', createdAt: 1710000000000, sortIndex: 1 }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Both kernels are ready. I will create the chart now.',
            responseToMessageId: 'prompt-1',
            createdAt: 1710000060000,
            completedAt: 1710000125000,
            sortIndex: 3
          })
        ],
        activities: [
          createActivity({
            id: 'activity-1',
            promptMessageId: 'prompt-1',
            sortIndex: 2,
            createdAt: 1710000030000,
            updatedAt: 1710000030000
          }),
          createActivity({
            id: 'activity-2',
            promptMessageId: 'prompt-1',
            sortIndex: 4,
            createdAt: 1710000090000,
            updatedAt: 1710000090000
          })
        ]
      })
    )

    const finalToolPosition = html.indexOf('data-message-id="activity-group-activity-2"')
    const footerPosition = html.indexOf('data-slot="assistant-message-footer"')

    expect(finalToolPosition).toBeGreaterThan(-1)
    expect(footerPosition).toBeGreaterThan(finalToolPosition)
  })

  it('hides only the current prompt footer while an ask-user continuation is running', async () => {
    const html = await renderScroller(
      createSession({
        status: 'running',
        activeRun: undefined,
        agentPromptInFlight: true,
        awaitingFirstAgentOutput: true,
        messages: [
          createMessage({ id: 'prompt-1', content: 'First prompt', sortIndex: 1 }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'First answer',
            responseToMessageId: 'prompt-1',
            completedAt: 1710000001000,
            sortIndex: 2
          }),
          createMessage({ id: 'prompt-2', content: 'Create a chart', sortIndex: 3 }),
          createMessage({
            id: 'reply-2',
            role: 'agent',
            content: 'Choose a chart type.',
            responseToMessageId: 'prompt-2',
            completedAt: 1710000003000,
            turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 },
            sortIndex: 4
          })
        ]
      })
    )

    expect(html).toContain('>Thinking</span>')
    expect(html.match(/data-slot="assistant-message-footer"/g)).toHaveLength(1)
    expect(html.indexOf('data-slot="assistant-message-footer"')).toBeGreaterThan(
      html.indexOf('First answer')
    )
    expect(html.indexOf('data-slot="assistant-message-footer"')).toBeLessThan(
      html.indexOf('Choose a chart type.')
    )
  })

  it('does not present an interrupted tool turn as completed before its final activity', async () => {
    const html = await renderScroller(
      createSession({
        status: 'error',
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: 'prompt-1'
        },
        messages: [
          createMessage({ id: 'prompt-1', interrupted: true, sortIndex: 1 }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'I will search PubMed now.',
            responseToMessageId: 'prompt-1',
            completedAt: 1710000007000,
            sortIndex: 2
          })
        ],
        activities: [
          createActivity({
            id: 'activity-1',
            status: 'failed',
            promptMessageId: 'prompt-1',
            sortIndex: 3,
            createdAt: 1710000008000,
            updatedAt: 1710000008000
          })
        ]
      })
    )

    expect(html).toContain('This turn was interrupted.')
    expect(html).not.toContain('Completed ')
    expect(html).not.toContain('data-slot="assistant-message-footer"')
  })

  it('keeps a user clarification before its streamed mixed Chinese Markdown response', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-2',
          startedAt: 1710000000300
        },
        messages: [
          createMessage({
            id: 'prompt-1',
            content: '找一篇疾病的生信文章',
            sortIndex: 1,
            createdAt: 1710000000000
          }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: '请选择疾病和分析类型。',
            responseToMessageId: 'prompt-1',
            sortIndex: 2,
            createdAt: 1710000000100
          }),
          createMessage({
            id: 'prompt-2',
            content: '癌症，转录组分析',
            sortIndex: 3,
            createdAt: 1710000000200
          }),
          createMessage({
            id: 'reply-2',
            role: 'agent',
            content: '明白：聚焦**癌症**，使用转录组分析。',
            status: 'streaming',
            streamId: 'stream-2',
            responseToMessageId: 'prompt-2',
            sortIndex: 4,
            createdAt: 1710000000300
          })
        ]
      })
    )

    const timelineContent = [
      '找一篇疾病的生信文章',
      '请选择疾病和分析类型。',
      '癌症，转录组分析',
      '明白：聚焦**癌症**，使用转录组分析。'
    ]
    const timelinePositions = timelineContent.map((content) => html.indexOf(content))

    expect(timelinePositions.every((position) => position >= 0)).toBe(true)
    expect(timelinePositions).toEqual([...timelinePositions].sort((left, right) => left - right))
    expect(html).toContain('data-message-id="reply-2" data-disable-containment="true"')
  })

  it('shows an approval wait during permission requests and hides ordinary loading without a run', async () => {
    const runningSession = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [createMessage({ id: 'prompt-1' })]
    })

    // Permission remains a user-facing approval wait before and after visible assistant output.
    await expect(
      renderScroller({ ...runningSession, status: 'waiting-permission' })
    ).resolves.toContain('>Waiting for your approval</span>')
    await expect(
      renderScroller({
        ...runningSession,
        status: 'waiting-permission',
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: "I'll inspect the files",
            status: 'streaming',
            streamId: 'stream-1',
            responseToMessageId: 'prompt-1'
          })
        ]
      })
    ).resolves.toContain('>Waiting for your approval</span>')
    await expect(
      renderScroller({ ...runningSession, activeRun: undefined })
    ).resolves.not.toContain('role="status"')
  })

  it.each([
    ['waiting-for-user', 'Waiting for your response'],
    ['waiting-plan-approval', 'Waiting for your approval']
  ] as const)(
    'shows the user wait for a %s session without an active run',
    async (status, label) => {
      await expect(
        renderScroller(
          createSession({
            status,
            activeRun: undefined,
            agentPromptInFlight: false,
            messages: [createMessage({ id: 'prompt-1' })]
          })
        )
      ).resolves.toContain(`>${label}</span>`)
    }
  )

  it('renders credential recovery as waiting for a response', async () => {
    await expect(
      renderScroller(
        createSession({
          status: 'running',
          activeRun: {
            promptMessageId: 'prompt-1',
            startedAt: 1710000000100
          },
          messages: [createMessage({ id: 'prompt-1' })]
        }),
        { credentialPending: true }
      )
    ).resolves.toContain('>Waiting for your response</span>')
  })

  it('renders the loading row for a follow-up prompt after a tool-calling turn', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-2',
          startedAt: 1710000000200
        },
        messages: [
          createMessage({ id: 'prompt-1', content: 'First prompt', sortIndex: 1 }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'First answer',
            status: 'complete',
            streamId: 'stream-1',
            responseToMessageId: 'prompt-1',
            sortIndex: 2
          }),
          createMessage({ id: 'prompt-2', content: 'Follow up', sortIndex: 4 })
        ],
        activities: [createActivity({ id: 'tool-1', sortIndex: 3 })]
      })
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('>Thinking</span>')
  })

  it('renders generated artifact gallery cards under agent messages', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Created the file',
            artifactIds: ['artifact-1']
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/Users/example/.open-science/artifacts/default-project/session-1/reply-1/result.txt',
            fileUrl:
              'file:///Users/example/.open-science/artifacts/default-project/session-1/reply-1/result.txt',
            name: 'result.txt',
            mimeType: 'text/plain',
            size: 2048,
            mtimeMs: 1710000000100
          }
        ]
      })
    )

    expect(html).toContain('Created the file')
    expect(html).toContain('GENERATED · 1')
    expect(html).toContain('type="button"')
    expect(html).not.toContain('href="file:///Users/example/.open-science')
    expect(html).toContain('result.txt')
    expect(html).toContain('aria-label="Preview generated file result.txt"')
    expect(html).toContain('TXT')
  })

  it('renders one generated card for legacy and native ids of the same Artifact Version', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Saved the script',
            artifactIds: ['session-1:reply-1:test_script.r', 'artifact-version-1']
          })
        ],
        artifacts: [
          {
            id: 'session-1:reply-1:test_script.r',
            artifactId: 'artifact-lineage-1',
            versionId: 'artifact-version-1',
            versionNumber: 1,
            kind: 'managed-file',
            path: '/managed/reply-1/test_script.r',
            name: 'test_script.r',
            mimeType: 'text/x-r',
            size: 227,
            mtimeMs: 1710000000100
          },
          {
            id: 'artifact-version-1',
            artifactId: 'artifact-lineage-1',
            versionId: 'artifact-version-1',
            versionNumber: 1,
            kind: 'managed-file',
            path: '/managed/.provenance/artifact-lineage-1/artifact-version-1/content',
            name: 'test_script.r',
            mimeType: 'text/x-r',
            size: 227,
            mtimeMs: 1710000000101,
            sha256: 'a'.repeat(64)
          }
        ]
      })
    )

    expect(html).toContain('GENERATED · 1')
    expect(html.match(/aria-label="Preview generated file test_script\.r"/g)).toHaveLength(1)
    expect(html).toContain(
      'title="/managed/.provenance/artifact-lineage-1/artifact-version-1/content"'
    )
    expect(html).not.toContain('title="/managed/reply-1/test_script.r"')
  })

  it('renders image cards and a more button for larger generated artifact sets without file urls', async () => {
    const artifacts = Array.from({ length: 7 }, (_, index) => ({
      id: `artifact-${index + 1}`,
      kind: 'managed-file' as const,
      path: `/Users/example/.open-science/artifacts/default-project/session-1/reply-1/file-${index + 1}.png`,
      fileUrl: `file:///Users/example/.open-science/artifacts/default-project/session-1/reply-1/file-${index + 1}.png`,
      name: `file-${index + 1}.png`,
      mimeType: 'image/png',
      size: 2048,
      mtimeMs: 1710000000100 + index
    }))

    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Created the files',
            artifactIds: artifacts.map((artifact) => artifact.id)
          })
        ],
        artifacts
      })
    )

    expect(html).toContain('GENERATED · 7')
    expect(html).not.toContain('src="file:///Users/example/.open-science')
    expect(html).toContain('PNG')
    expect(html).toContain('+2 more')
    expect(html).toContain('aria-label="Expand generated files"')
    expect(html).not.toContain('Close generated files')
  })

  it('does not render generated artifact files under user messages', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Please create a file',
            artifactIds: ['artifact-1']
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/Users/example/.open-science/artifacts/default-project/session-1/prompt-1/user-only.txt',
            fileUrl:
              'file:///Users/example/.open-science/artifacts/default-project/session-1/prompt-1/user-only.txt',
            name: 'user-only.txt',
            mimeType: 'text/plain',
            size: 1024,
            mtimeMs: 1710000000100
          }
        ]
      })
    )

    expect(html).toContain('Please create a file')
    expect(html).not.toContain('Generated files')
    expect(html).not.toContain('user-only.txt')
  })

  it('renders user-message uploads above prompt text in attachment order', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'What is in the first image',
            uploads: [
              createUpload({
                id: 'upload-1',
                name: 'pasted-image-2026-07-08T06-17-13.png',
                originalName: 'pasted-image-2026-07-08T06-17-13.png'
              }),
              createUpload({
                id: 'upload-2',
                name: 'pasted-image-2026-07-08T06-17-25.png',
                originalName: 'pasted-image-2026-07-08T06-17-25.png',
                path: '/Users/example/.open-science/uploads/default-project/session-1/pasted-image-2026-07-08T06-17-25.png'
              })
            ]
          })
        ]
      })
    )

    const firstIndex = html.indexOf('pasted-image-2026-07-08T06-17-13.png')
    const secondIndex = html.indexOf('pasted-image-2026-07-08T06-17-25.png', firstIndex + 1)
    const textIndex = html.indexOf('What is in the first image')

    expect(firstIndex).toBeGreaterThan(-1)
    expect(secondIndex).toBeGreaterThan(firstIndex)
    expect(textIndex).toBeGreaterThan(secondIndex)
    expect(html).toContain(
      'aria-label="Preview uploaded attachment pasted-image-2026-07-08T06-17-13.png"'
    )
    // Uploads are gray file pills without the legacy leading @ prefix.
    expect(html).toContain('bg-bg-200')
    expect(html).not.toContain('@pasted-image-2026-07-08T06-17-13.png')
  })

  it('renders user message parts as styled skill and artifact pills', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Run /forecast on @clinical trial03.pdf',
            parts: [
              { type: 'text', text: 'Run ' },
              { type: 'skill', id: 'skill-forecast', name: 'forecast' },
              { type: 'text', text: ' on ' },
              {
                type: 'artifact',
                id: 'artifact-1',
                name: 'clinical trial03.pdf',
                path: '/p/clinical trial03.pdf',
                source: 'artifact'
              }
            ]
          })
        ]
      })
    )

    // Skill pill is blue; artifact pill is green; labels keep their / and @ markers.
    expect(html).toContain('text-skill-chip-foreground')
    expect(html).toContain('/forecast')
    expect(html).toContain('bg-mention-chip')
    expect(html).toContain('text-mention-chip-foreground')
    expect(html).toContain('aria-label="Preview clinical trial03.pdf"')
    expect(html).toContain('file-name-extension')
  })

  it('renders plain content for user messages without structured parts', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1', content: 'Just plain text' })]
      })
    )

    expect(html).toContain('Just plain text')
    expect(html).not.toContain('text-mention-chip-foreground')
  })

  it('renders uploads as gray pills labeled by filename', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Look at this',
            uploads: [
              createUpload({
                id: 'upload-1',
                name: 'report.pdf',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                path: '/p/report.pdf'
              })
            ]
          })
        ]
      })
    )

    expect(html).toContain('bg-bg-200')
    expect(html).toContain('report.pdf')
    expect(html).not.toContain('@report.pdf')
    expect(html).toContain('aria-label="Preview uploaded attachment report.pdf"')
  })

  it('renders search activities as compact chips with details collapsed by default', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            providerToolName: 'WebSearch',
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    query: 'top news July 6 2026',
                    results: [
                      {
                        title: 'Result 1',
                        url: 'https://example.com/result-1'
                      },
                      {
                        title: 'Result 2',
                        url: 'https://example.com/result-2'
                      }
                    ]
                  })
                }
              }
            ]
          }),
          createActivity({
            id: 'tool-search-2',
            title: '"top headlines July 6 2026 breaking news"',
            providerToolName: 'WebSearch',
            sortIndex: 3,
            createdAt: 1710000000002,
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    query: 'top headlines July 6 2026 breaking news',
                    results: [
                      {
                        title: 'Breaking news result',
                        url: 'https://example.com/breaking-news'
                      }
                    ]
                  })
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('data-testid="tool-group"')
    expect(html).toContain('class="px-4 pb-0.5 pt-2.5 md:px-6"')
    expect(html).toContain('data-testid="tool-group-header"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Ran 2 searches')
    expect(html).toContain('2 steps')
    expect(html.match(/data-testid="tool-chip"/g)).toHaveLength(2)
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(html).toContain('Web Search')
    expect(html).toContain('top news July 6 2026')
    expect(html).toContain('top headlines July 6 2026 breaking news')
    expect(html).toContain('2 results')
    expect(html).toContain('aria-controls="tool-details-tool-search-1"')
    expect(html).not.toContain('id="tool-details-tool-search-1"')
    expect(html).not.toContain('query')
    expect(html).not.toContain('Result 1')
    expect(html).not.toContain('href="https://example.com/result-1"')
    expect(html).not.toContain('https://example.com/result-1')
    expect(html).not.toContain('Result 2')
    expect(html).not.toContain('https://example.com/result-2')
    expect(html).not.toContain('Breaking news result')
    expect(html).not.toContain('https://example.com/breaking-news')
  })

  it('renders a closed search permission as neutral and inactive', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            status: 'in_progress',
            providerToolName: 'WebSearch',
            toolDisposition: 'permission-closed',
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({ query: 'closed query', results: [] })
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Tool request ended')
    expect(html).toContain('>request ended<')
    expect(html).toContain('lucide-circle-minus')
    expect(html).not.toContain('animate-spin')
    expect(html.match(/<button[^>]*data-testid="tool-chip"[^>]*>/u)?.[0]).not.toContain('aria-live')
  })

  it('keeps Claude web search payload links collapsed by default', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            title: '"Typhoon Bavi landfall time forecast 2026"',
            providerToolName: 'WebSearch',
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: [
                    'Web search results for query: "Typhoon Bavi landfall time forecast 2026"',
                    '',
                    'Links: [{"title":"Live typhoon updates","url":"https://typhoon.slt.zj.gov.cn/"},{"title":"Typhoon No. 9 “Bavi” likely to make landfall in East China!","url":"https://finance.sina.com.cn/wm/2026-07-05/doc-inifuper9136723.shtml"}]',
                    '',
                    'Based on the search results, here is the latest on the predicted landfall time of Typhoon "Bavi".'
                  ].join('\n')
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a search')
    expect(html).toContain('1 step')
    expect(html).toContain('2 results')
    expect(html).toContain('Typhoon Bavi landfall time forecast 2026')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Live typhoon updates')
    expect(html).not.toContain('href="https://typhoon.slt.zj.gov.cn/"')
    expect(html).not.toContain('Typhoon No. 9 “Bavi” likely to make landfall in East China!')
    expect(html).not.toContain(
      'href="https://finance.sina.com.cn/wm/2026-07-05/doc-inifuper9136723.shtml"'
    )
  })

  it('infers ToolSearch activity groups from runtime titles when tool kind is missing', async () => {
    const html = await renderScroller(
      createSession({
        status: 'running',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-search-1',
            title: '"latest typhoon updates July 2026"',
            status: 'in_progress',
            toolKind: undefined,
            sortIndex: 3,
            createdAt: 1710000000002
          }),
          createActivity({
            id: 'tool-search-2',
            title: '"typhoon 2026 national weather bureau latest forecast"',
            status: 'in_progress',
            toolKind: undefined,
            sortIndex: 4,
            createdAt: 1710000000003
          })
        ]
      })
    )

    expect(html).toContain('Ran 2 searches')
    expect(html).toContain('2 steps')
    expect(html).not.toContain('Used tool: ToolSearch')
    expect(html).toContain('Web Search')
    expect(html).toContain('latest typhoon updates July 2026')
    expect(html).toContain('typhoon 2026 national weather bureau latest forecast')
    expect(html).not.toContain('&quot;latest typhoon updates July 2026&quot;')
    expect(html).not.toContain('&quot;typhoon 2026 national weather bureau latest forecast&quot;')
    expect(html).not.toContain('Using tool: &quot;latest typhoon updates July 2026&quot;')
    expect(html).not.toContain(
      'Using tool: &quot;typhoon 2026 national weather bureau latest forecast&quot;'
    )
  })

  it('renders ACP WebSearch fetch activities as web search entries after tool selection', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-web-search',
            title: '"India high temperature latest news"',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002,
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: [
                    'Web search results for query: "India high temperature latest news"',
                    '',
                    'Links: [{"title":"India heatwave latest","url":"https://example.com/india-heatwave"}]'
                  ].join('\n')
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a search')
    expect(html).toContain('1 step')
    expect(html).not.toContain('Used tool: ToolSearch')
    expect(html).toContain('Web Search')
    expect(html).toContain('India high temperature latest news')
    expect(html).toContain('1 result')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('India heatwave latest')
    expect(html).not.toContain('href="https://example.com/india-heatwave"')
  })

  it('does not infer quoted non-search activities from earlier explicit search activities', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-search-1',
            title: '"weather forecast"',
            providerToolName: 'WebSearch',
            toolKind: 'fetch',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-read-1',
            title: '"README.md"',
            toolKind: 'read',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a search')
    expect(html).toContain('2 steps')
    expect(html.match(/Web Search/g)).toHaveLength(1)
    expect(html).toContain('Used tool: ToolRead')
  })

  it('renders Claude Grep search-kind activities as ordinary tools without leaking title details', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-grep-1',
            title: 'grep "secret pattern" /workspace/private',
            providerToolName: 'Grep',
            toolKind: 'search',
            sortIndex: 2,
            createdAt: 1710000000001
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool')
    expect(html).toContain('Used tool: Grep')
    expect(html).not.toContain('Web Search')
    expect(html).not.toContain('secret pattern')
    expect(html).not.toContain('/workspace/private')
  })

  it('does not infer quoted non-search activities from an earlier ToolSearch wrapper', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-read-1',
            title: '"README.md"',
            toolKind: 'read',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, read a file')
    expect(html).toContain('2 steps')
    expect(html).toContain('Used tool: ToolSearch')
    expect(html).toContain('Used tool: ToolRead')
    expect(html).not.toContain('Used tool: &quot;README.md&quot;')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })

  it('does not infer completed quoted fetch activities without search payload evidence', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-fetch-1',
            title: '"https://example.com/resource"',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, fetched a page')
    expect(html).toContain('2 steps')
    expect(html).toContain('Used tool: ToolSearch')
    expect(html).toContain('Used tool: ToolFetch')
    expect(html).not.toContain('https://example.com/resource')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })

  it('does not infer completed quoted fetch activities from ordinary link content', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-fetch-1',
            title: '"https://example.com/resource"',
            providerToolName: 'WebFetch',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002,
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: '[Plain link](https://example.com/plain)'
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, fetched a page')
    expect(html).toContain('Used tool: ToolSearch')
    expect(html).toContain('Used tool: WebFetch')
    expect(html).not.toContain('https://example.com/resource')
    expect(html).not.toContain('Plain link')
    expect(html).not.toContain('https://example.com/plain')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })

  it('does not infer active quoted WebFetch activities from an earlier ToolSearch wrapper', async () => {
    const html = await renderScroller(
      createSession({
        status: 'running',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-fetch-1',
            title: '"https://example.com/resource"',
            status: 'in_progress',
            providerToolName: 'WebFetch',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, fetched a page')
    expect(html).toContain('Using tool: WebFetch')
    expect(html).not.toContain('https://example.com/resource')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })
})

describe('WorkspaceMessageScroller agent images', () => {
  it('renders bounded ACP message images as data URLs alongside text', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Generated chart',
            images: [{ id: 'event-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
          })
        ]
      })
    )

    expect(html).toContain('Generated chart')
    expect(html).toContain('src="data:image/png;base64,AQID"')
    expect(html).toContain('alt="Agent-generated image 1"')
  })
})

describe('WorkspaceMessageScroller tool detail rows', () => {
  it('renders execute tool activities collapsed by default', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-bash-1',
            providerToolName: 'Bash',
            toolKind: 'execute',
            title: 'ls -la',
            terminalExitCode: 0,
            sortIndex: 2,
            toolContent: [
              { type: 'content', content: { type: 'text', text: '```console\ntotal 8\n```' } }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a command')
    expect(html).toContain('Bash')
    expect(html).toContain('ls -la')
    expect(html).toContain('exit 0')
    // Detail rows below the group stay collapsed until the user expands them.
    expect(html).not.toContain('data-testid="tool-details"')
    expect(html).not.toContain('total 8')
  })
})

describe('WorkspaceActivityGroup header summaries', () => {
  it('renders generate_plan outside ordinary tool groups without counting it as a tool step', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'read-1',
            title: 'Read source',
            toolKind: 'read',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'plan-1',
            title: 'generate_plan',
            providerToolName: 'mcp__open-science-plan__generate_plan',
            sortIndex: 3,
            createdAt: 1710000000002,
            rawInput: {
              arguments: {
                task_summary: 'Prepare the report',
                phases: [
                  {
                    name: 'Delivery',
                    delegations: [
                      {
                        name: 'Writing',
                        steps: [{ title: 'Draft report', description: 'Write the findings.' }]
                      }
                    ]
                  }
                ],
                desired_outputs: ['Report'],
                feasibility: { confidence: 'high', rationale: 'Inputs are ready.' }
              }
            }
          })
        ]
      })
    )

    expect(html).toContain('data-testid="plan-call-record"')
    expect(html).toContain('Prepare the report')
    expect(html).toContain('Read a file')
    expect(html.match(/1 step/g)).toHaveLength(2)
    expect(html).not.toContain('2 steps')
  })

  it('summarizes a mixed group by tool category', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'cmd-1',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'load data',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'cmd-2',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'plot data',
            sortIndex: 3,
            createdAt: 1710000000002
          }),
          createActivity({
            id: 'skill-1',
            providerToolName: 'Skill',
            toolKind: 'other',
            title: 'figure-style',
            sortIndex: 4,
            createdAt: 1710000000003
          }),
          createActivity({
            id: 'call-1',
            providerToolName: 'request_network_access',
            toolKind: 'other',
            title: 'request access',
            sortIndex: 5,
            createdAt: 1710000000004
          })
        ]
      })
    )

    expect(html).toContain('Ran 2 commands, loaded a skill, made a call')
    expect(html).toContain('4 steps')
  })

  it('appends a failed-step count to the group step summary', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'cmd-ok',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'setup',
            status: 'completed',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'cmd-fail',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'run',
            status: 'failed',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran 2 commands')
    expect(html).toContain('2 steps · 1 failed')
  })

  it('summarizes an artifact-writing group as saving a file', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'cmd-1',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'render figure',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'artifact-1',
            providerToolName: 'write_artifact_file',
            toolKind: 'other',
            title: 'Write artifact file',
            sortIndex: 3,
            createdAt: 1710000000002,
            rawInput: {
              filename: 'figure.png',
              mimeType: 'image/png',
              content: 'x',
              encoding: 'base64'
            },
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    artifact: {
                      name: 'figure.png',
                      path: '/f/figure.png',
                      mimeType: 'image/png',
                      size: 4096
                    }
                  })
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a command, saved a file')
    expect(html).toContain('2 steps')
  })
})

describe('WorkspaceToolDetailsRow expanded rendering', () => {
  it.each([
    ['timeout', 'limit-reached', 'limit reached'],
    ['cancelled', 'cancelled', 'cancelled'],
    ['interrupted', 'interrupted', 'interrupted']
  ] as const)('renders the neutral Notebook %s status', async (status, phase, label) => {
    const { WorkspaceToolDetailsRow } = await import('./WorkspaceToolDetailsRow')
    const html = renderToStaticMarkup(
      <WorkspaceToolDetailsRow
        activity={createActivity({
          id: 'tool-notebook-1',
          providerToolName: 'mcp__open-science-notebook__notebook_execute'
        })}
        phase={phase}
        details={{ displayName: 'Notebook cell', metaLabel: 'success', sections: [] }}
        notebookRun={{
          runId: 'run-1',
          cellId: 'cell-1',
          source: 'agent',
          kernelKind: 'python',
          script: 'print(1)',
          status,
          startedAt: 1,
          endedAt: 2,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: []
        }}
        isExpanded={false}
        onToggle={() => {}}
      />
    )

    expect(html).toContain(label)
    expect(html).not.toContain('success')
  })

  it('renders command and output code blocks when expanded', async () => {
    const { WorkspaceToolDetailsRow } = await import('./WorkspaceToolDetailsRow')
    const details: ToolActivityDetails = {
      displayName: 'Bash',
      subtitle: 'ls -la',
      metaLabel: 'exit 0',
      sections: [
        { kind: 'code', label: 'Command', language: 'bash', text: 'ls -la' },
        { kind: 'code', label: 'Output', text: 'total 8' }
      ]
    }
    const html = renderToStaticMarkup(
      <WorkspaceToolDetailsRow
        activity={createActivity({ id: 'tool-bash-1', toolKind: 'execute' })}
        details={details}
        isExpanded
        onToggle={() => {}}
      />
    )

    expect(html).toContain('data-testid="tool-details"')
    expect(html).toContain('data-testid="tool-code-block"')
    expect(html).toContain('Command')
    expect(html).toContain('Output')
    expect(html).toContain('ls -la')
    expect(html).toContain('total 8')
  })

  it('renders diff blocks for edit tools when expanded', async () => {
    const { WorkspaceToolDetailsRow } = await import('./WorkspaceToolDetailsRow')
    const details: ToolActivityDetails = {
      displayName: 'Edit',
      subtitle: 'a.ts',
      metaLabel: '+1 −1',
      sections: [
        {
          kind: 'diff',
          label: 'a.ts',
          path: 'a.ts',
          oldText: 'const a = 1',
          newText: 'const a = 2',
          addedLines: 1,
          removedLines: 1
        }
      ]
    }
    const html = renderToStaticMarkup(
      <WorkspaceToolDetailsRow
        activity={createActivity({ id: 'tool-edit-1', toolKind: 'edit' })}
        details={details}
        isExpanded
        onToggle={() => {}}
      />
    )

    expect(html).toContain('data-testid="tool-diff-block"')
    expect(html).toContain('const a = 1')
    expect(html).toContain('const a = 2')
  })
})

// Helper to build a minimal JobSummary for tests.
const createJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  session_id: 'session-1',
  provider_id: 'provider-1',
  intent: 'run analysis',
  status: 'success',
  display_name: 'GPU Host',
  shape: 'gpu-small',
  created_at: 1710000000000,
  started_at: undefined,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined,
  featured_files: [],
  ...overrides
})

describe('WorkspaceMessageScroller unbound completed job deduplication', () => {
  it('renders an unbound completed job only once even when its created_at is before multiple messages', async () => {
    // Job was created BEFORE both messages — the buggy filter re-includes it for every message.
    const job = createJob({
      job_id: 'job-early',
      intent: 'run early analysis',
      created_at: 999_999_999, // earlier than both messages below
      status: 'success',
      session_id: 'session-1'
    })
    mockJobsById = new Map([[job.job_id, job]])

    const html = await renderScroller(
      createSession({
        id: 'session-1',
        status: 'idle',
        messages: [
          createMessage({ id: 'msg-1', createdAt: 1_000_000_000, updatedAt: 1_000_000_000 }),
          createMessage({ id: 'msg-2', createdAt: 1_000_000_001, updatedAt: 1_000_000_001 })
        ]
      })
    )

    // The card must appear exactly once in the timeline, not twice.
    const matches = html.match(/data-testid="completed-job-card"/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)

    // Cleanup for isolation between tests.
    mockJobsById = new Map()
  })
})
