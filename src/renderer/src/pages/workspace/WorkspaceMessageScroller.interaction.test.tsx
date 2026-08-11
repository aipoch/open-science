// @vitest-environment jsdom
import { act, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import {
  useSessionStore,
  type ChatMessage,
  type ChatSession,
  type ToolActivity
} from '@/stores/session-store'
import {
  createInitialReviewState,
  selectProjectSessionReviews,
  useReviewStore
} from '@/stores/review-store'
import { createUploadVersionReference, type UploadedAttachment } from '../../../../shared/uploads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewWithChecks } from '../../../../shared/reviewer'
import type { ArtifactVersionDescriptor } from '../../../../shared/artifact-provenance'
import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource
} from '../../../../shared/handoff-lifecycle'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import type { ComposerDoc } from './composer/composer-doc'

// pdfjs-dist references DOMMatrix at module load, which jsdom does not provide. This suite exercises
// click/scroll behavior, not PDF rendering, so stub the library to keep the import graph loadable.
vi.mock('pdfjs-dist', () => {
  class PDFDataRangeTransport {
    requestAllRanges(): void {
      /* no-op */
    }
  }
  return {
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 0, destroy: () => undefined }),
      destroy: () => undefined
    }),
    GlobalWorkerOptions: { workerSrc: '' },
    PDFDataRangeTransport,
    version: 'test'
  }
})

const { agentMarkdownRenderMock } = vi.hoisted(() => ({ agentMarkdownRenderMock: vi.fn() }))
const { flushSessionPersistenceMock } = vi.hoisted(() => ({
  flushSessionPersistenceMock: vi.fn(async (): Promise<void> => undefined)
}))

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  flushSessionPersistence: flushSessionPersistenceMock
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => {
    agentMarkdownRenderMock(content)
    return <div>{content}</div>
  }
}))

vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
  const Item = ({
    children,
    messageId
  }: PropsWithChildren<{ messageId?: string }>): React.JSX.Element => (
    <div data-message-id={messageId}>{children}</div>
  )
  const Button = (): React.JSX.Element => <button type="button">Scroll to end</button>

  return {
    MessageScrollerProvider: Wrapper,
    MessageScroller: Wrapper,
    MessageScrollerViewport: Wrapper,
    MessageScrollerContent: Wrapper,
    MessageScrollerItem: Item,
    MessageScrollerButton: Button
  }
})

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' '),
  formatByteSize: (size: number | undefined) =>
    typeof size === 'number' && size >= 0 ? `${size} B` : undefined
}))

const upsertAndActivateItem = vi.fn()
const listGrantedRoots = vi.fn()
const createSessionPlanPreviewItem = vi.fn((sessionId: string, projectId: string) => ({
  id: `tool:${sessionId}:plan`,
  sessionId,
  projectId,
  type: 'tool' as const,
  toolKind: 'plan' as const,
  title: 'Plan'
}))
const announceWindowFindReady = vi.fn(() => () => undefined)

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ upsertAndActivateItem })
  },
  createSessionPlanPreviewItem
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
  id: 'tool-1',
  kind: 'tool',
  title: 'Tool',
  status: 'in_progress',
  eventIds: ['event-1'],
  sortIndex: 1,
  createdAt: 1710000000001,
  updatedAt: 1710000000001,
  ...overrides
})

const createUpload = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-42',
  name: 'first.png',
  originalName: 'first.png',
  path: '/Users/example/.open-science/uploads/default-project/session-42/first.png',
  mimeType: 'image/png',
  size: 2048,
  ...overrides
})

const createDeferred = <Value,>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

class FakeHandoffLifecycleSource implements HandoffLifecycleEventSource {
  private events: readonly HandoffLifecycleEvent[] = []
  private readonly listeners = new Set<() => void>()

  getEvents(sessionId: string): readonly HandoffLifecycleEvent[] {
    return sessionId === 'session-1' ? this.events : EMPTY_HANDOFF_EVENTS
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: HandoffLifecycleEvent): void {
    this.events = [...this.events, event]
    for (const listener of this.listeners) listener()
  }
}

const EMPTY_HANDOFF_EVENTS: readonly HandoffLifecycleEvent[] = []

const createHandoffEvent = (
  sequence: number,
  phase: HandoffLifecycleEvent['phase']
): HandoffLifecycleEvent => ({
  id: `handoff-${sequence}`,
  sessionId: 'session-1',
  sequence,
  observedAt: 1710000000150,
  phase,
  target: { kind: 'specialist', name: 'Data analyst' },
  provenance: {
    originatingTurnId: 'turn-1',
    originatingUserMessageId: 'prompt-1',
    attachmentIds: ['upload-1'],
    artifactIds: ['artifact-1']
  }
})

describe('WorkspaceMessageScroller artifact click behavior', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    upsertAndActivateItem.mockClear()
    listGrantedRoots.mockReset().mockResolvedValue([])
    useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
    announceWindowFindReady.mockClear()
    flushSessionPersistenceMock.mockReset().mockResolvedValue(undefined)
    useReviewStore.setState(createInitialReviewState())
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      platform: 'darwin',
      localFs: {
        listGrantedRoots
      },
      previewResources: {
        acquire: vi.fn(({ path }: { path: string }) =>
          Promise.resolve({
            id: `resource:${path}`,
            url: `open-science-preview://resource/${encodeURIComponent(path)}`,
            size: 2048,
            mimeType: 'image/png',
            version: 1
          })
        ),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        readPreview: vi
          .fn()
          .mockResolvedValue({ content: '', encoding: 'utf8', size: 0, truncated: false }),
        openFile: vi.fn().mockResolvedValue(undefined),
        finalizeRunArtifacts: vi.fn()
      },
      uploads: {
        readPreview: vi
          .fn()
          .mockResolvedValue({ content: '', encoding: 'utf8', size: 0, truncated: false })
      },
      reviewer: {
        getForSession: vi.fn().mockResolvedValue([])
      },
      window: {
        announceWindowFindReady
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('reserves a read-only transcript card while structured input waits below', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const projection = {
      message: 'Choose an approach',
      fields: [
        {
          id: 'approach',
          label: 'Approach',
          kind: 'single-select' as const,
          required: true,
          options: [
            { value: 'minimal', label: 'Minimal change', description: 'Reuse the activity.' },
            { value: 'expanded', label: 'Expanded model' }
          ]
        }
      ],
      state: 'pending' as const
    }
    const session = createSession({
      activities: [createActivity({ id: 'tool-ask-1', elicitation: projection })]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={session}
          onSendEditedMessage={vi.fn()}
          pendingElicitations={[
            {
              requestId: 'elicitation-1',
              sessionId: session.id,
              toolCallId: 'tool-ask-1',
              message: projection.message,
              fields: projection.fields
            }
          ]}
        />
      )
    })

    expect(container.querySelector('[data-testid="elicitation-card"]')).not.toBeNull()
    expect(container.textContent).toContain('Choose an approach')
    expect(container.textContent).toContain('Awaiting your answer…')
    expect(
      container.querySelector('[data-testid="elicitation-pending-placeholder"]')
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="elicitation-option-minimal"]')).toBeNull()
  })

  it('rehydrates a durable answered question as a read-only message review', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const projection = {
      message: 'Choose an approach',
      fields: [
        {
          id: 'question_0',
          label: 'Approach',
          kind: 'single-select' as const,
          options: [
            { value: 'Minimal', label: 'Minimal change' },
            { value: 'Expanded', label: 'Expanded model' }
          ]
        },
        { id: 'question_0_custom', label: 'Other', kind: 'text' as const }
      ],
      state: 'answered' as const,
      durable: {
        kind: 'agent-user-choice' as const,
        requestId: 'elicitation-answered',
        promptMessageId: 'message-1'
      },
      answers: [{ fieldId: 'question_0', value: 'Minimal' }]
    }
    const session = createSession({
      status: 'idle',
      activities: [createActivity({ id: 'tool-ask-answered', elicitation: projection })]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    expect(container.textContent).toContain('Minimal change')
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-summary"]')
        ?.click()
    })
    expect(container.querySelector('[data-testid="elicitation-choice-review"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="elicitation-option-Expanded"]')).not.toBeNull()
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).not.toContain('Submit')
    expect(container.textContent).not.toContain('Finish')
  })

  it('updates the visible message-branch review card when a running review completes', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const { WorkspaceMessageEditStateProvider } = await import('./workspace-message-edit-state')
    const runningReview: ReviewWithChecks = {
      id: 'review-1',
      projectId: 'default',
      sessionId: 'session-1',
      turnMessageId: 'reply-1',
      scope: {
        turnMessageId: 'reply-1',
        messageBranchId: 'message-branch-1',
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'running',
      outcome: null,
      model: 'test-model',
      reviewerLog: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      checks: []
    }
    useReviewStore.getState().handleReviewUpdate({ review: runningReview })

    const session = createSession({
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-1' }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Completed work',
          responseToMessageId: 'prompt-1'
        })
      ]
    })
    useSessionStore.setState({ sessions: [session], selectedSessionId: session.id })

    const resendEditedMessage = vi.fn()
    const ReviewLifecycleParent = (): React.JSX.Element => {
      // Mirrors WorkspacePage: composer controls subscribe to the Session review lifecycle while the
      // transcript sits below that reactive parent.
      const isReviewing = useReviewStore((state) =>
        selectProjectSessionReviews(state.reviewsBySession, session.projectId, session.id).some(
          (review) => review.lifecycle === 'running'
        )
      )
      const activeSession = useSessionStore((state) =>
        state.sessions.find((candidate) => candidate.id === session.id)
      )
      const activeSessionId = activeSession?.id
      // Mirrors WorkspacePage: the edit handler is scoped to the durable session identity rather than
      // the ChatSession object, whose transient operation gates can change during reviewer updates.
      const onSendEditedMessage = useCallback(
        (messageId: string, doc: ComposerDoc) => {
          if (activeSessionId) resendEditedMessage(activeSessionId, messageId, doc)
        },
        [activeSessionId]
      )
      useEffect(() => {
        useSessionStore.getState().setBranchSwitchBlocked(session.id, isReviewing)
      }, [isReviewing])
      return (
        <div data-reviewing={isReviewing ? 'true' : 'false'}>
          <WorkspaceMessageEditStateProvider canEditMessage={!isReviewing}>
            <WorkspaceMessageScroller
              activeSession={activeSession}
              onSendEditedMessage={onSendEditedMessage}
            />
          </WorkspaceMessageEditStateProvider>
        </div>
      )
    }

    root = createRoot(container)
    await act(async () => {
      root.render(<ReviewLifecycleParent />)
    })
    expect(container.textContent).toContain('Reviewing...')
    expect(container.querySelector('[data-testid="reviewer-running-state"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="reviewer-card"]')).toBeNull()
    expect(container.querySelector('[data-reviewing="true"]')).not.toBeNull()
    agentMarkdownRenderMock.mockClear()

    await act(async () => {
      useReviewStore.getState().handleReviewUpdate({
        review: {
          ...runningReview,
          lifecycle: 'complete',
          outcome: 'pass',
          updatedAt: 2_000
        }
      })
    })

    expect(
      useReviewStore.getState().getReviewForTurn('session-1', 'reply-1', 'default')?.lifecycle
    ).toBe('complete')
    expect(container.textContent).toContain('No issues found')
    expect(container.textContent).not.toContain('Reviewing...')
    expect(container.querySelector('[data-testid="reviewer-running-state"]')).toBeNull()
    expect(container.querySelector('[data-testid="reviewer-card"]')).not.toBeNull()
    expect(container.querySelector('[data-reviewing="false"]')).not.toBeNull()
    // Reviewer pushes should update only the card. Re-rendering the complete rich transcript here made
    // large 0.9 sessions repeatedly rebuild every Markdown tree at end_turn on Windows.
    expect(agentMarkdownRenderMock).not.toHaveBeenCalled()
  })

  it('keeps streamed output and continuation in one real transcript turn across session updates', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const handoffSource = new FakeHandoffLifecycleSource()
    const originalMessages = [
      createMessage({
        id: 'prompt-1',
        role: 'user',
        content: 'Analyze the sample',
        createdAt: 1710000000000
      }),
      createMessage({
        id: 'reply-before-handoff',
        role: 'agent',
        content: 'I inspected the input first.',
        responseToMessageId: 'prompt-1',
        createdAt: 1710000000100
      })
    ]
    const session = createSession({ status: 'running', messages: originalMessages })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={session}
          onSendEditedMessage={vi.fn()}
          handoffLifecycleSource={handoffSource}
        />
      )
      handoffSource.emit(createHandoffEvent(1, 'switching'))
    })

    expect(container.textContent).toContain('Switching to Data analyst')

    await act(async () => {
      // A retained snapshot may skip intermediate broadcasts; coordinator execution is already done.
      handoffSource.emit({
        ...createHandoffEvent(4, 'continued'),
        continuation: {
          outcome: 'returned',
          switchReadback: { target: { kind: 'specialist', name: 'Data analyst' } }
        }
      })
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({
            status: 'idle',
            messages: [
              ...originalMessages,
              createMessage({
                id: 'reply-after-handoff',
                role: 'agent',
                content: 'Continuing with the approved specialist.',
                responseToMessageId: 'prompt-1',
                createdAt: 1710000000200
              })
            ]
          })}
          onSendEditedMessage={vi.fn()}
          handoffLifecycleSource={handoffSource}
        />
      )
    })

    const lifecycle = container.querySelector<HTMLElement>('[data-handoff-lifecycle]')
    expect(lifecycle?.dataset.originatingTurnId).toBe('turn-1')
    expect(lifecycle?.dataset.originatingUserMessageId).toBe('prompt-1')
    expect(lifecycle?.textContent).toContain('Continued with Data analyst')
    expect(container.textContent?.match(/Analyze the sample/gu)).toHaveLength(1)
    expect(container.textContent?.match(/I inspected the input first\./gu)).toHaveLength(1)
    expect(
      container.textContent?.match(/Continuing with the approved specialist\./gu)
    ).toHaveLength(1)
    expect(container.querySelectorAll('[data-handoff-lifecycle]')).toHaveLength(1)

    await act(async () => handoffSource.emit(createHandoffEvent(2, 'reconfiguring')))
    expect(lifecycle?.textContent).toContain('Continued with Data analyst')
  })

  it('upserts and activates the clicked artifact in the preview store, scoped to the active session', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      id: 'session-42',
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
          path: '/workspace/report.png',
          fileUrl: 'file:///workspace/report.png',
          name: 'report.png',
          mimeType: 'image/png',
          size: 2048,
          mtimeMs: 1710000000100
        }
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const card = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file report.png"]'
    )
    expect(card).not.toBeNull()

    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(upsertAndActivateItem).toHaveBeenCalledTimes(1)
    expect(upsertAndActivateItem).toHaveBeenCalledWith({
      id: 'artifact-1',
      sessionId: 'session-42',
      title: 'report.png',
      type: 'file',
      path: '/workspace/report.png',
      projectId: 'default',
      name: 'report.png',
      format: 'image',
      mimeType: 'image/png',
      size: 2048,
      mtimeMs: 1710000000100
    })
  })

  it('resolves copied generated Version metadata and previews the source Version owner', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'artifact-version-1',
      projectName: 'origin-project',
      sessionId: 'origin-session',
      name: 'sin.png',
      mimeType: 'image/png',
      size: 48128,
      mtimeMs: 1710000000100,
      artifactId: 'artifact-lineage-1',
      versionId: 'artifact-version-1',
      versionNumber: 2,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-03T14:43:07.000Z',
      state: 'finalized'
    }
    const resolveVersionDescriptors = vi.fn().mockResolvedValue([descriptor])
    window.api.artifacts.resolveVersionDescriptors = resolveVersionDescriptors
    const session = createSession({
      id: 'branched-session',
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-1' }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Created the chart',
          artifactIds: ['artifact-version-1']
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resolveVersionDescriptors).toHaveBeenCalledWith({
      projectId: 'default',
      appSessionId: 'branched-session',
      versionIds: ['artifact-version-1']
    })
    const card = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file sin.png"]'
    )
    expect(card).not.toBeNull()

    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(upsertAndActivateItem).toHaveBeenCalledWith({
      id: 'artifact-lineage-1',
      projectId: 'origin-project',
      sessionId: 'origin-session',
      title: 'sin.png',
      type: 'file',
      path: 'artifact-version:origin-project/origin-session/artifact-lineage-1/artifact-version-1',
      name: 'sin.png',
      format: 'image',
      mimeType: 'image/png',
      size: 48128,
      mtimeMs: 1710000000100,
      artifactId: 'artifact-lineage-1',
      selectedVersionId: 'artifact-version-1',
      versionNumber: 2
    })
  })

  it('shows a resolved copied generated card after the active Session updates during lookup', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'artifact-version-1',
      projectName: 'origin-project',
      sessionId: 'origin-session',
      name: 'sin.png',
      mimeType: 'image/png',
      size: 48128,
      mtimeMs: 1710000000100,
      artifactId: 'artifact-lineage-1',
      versionId: 'artifact-version-1',
      versionNumber: 2,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-03T14:43:07.000Z',
      state: 'finalized'
    }
    const deferred = createDeferred<ArtifactVersionDescriptor[]>()
    const resolveVersionDescriptors = vi.fn(() => deferred.promise)
    window.api.artifacts.resolveVersionDescriptors = resolveVersionDescriptors
    const session = createSession({
      id: 'branched-session',
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-1' }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Created the chart',
          artifactIds: ['artifact-version-1']
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
    })
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={{ ...session, updatedAt: session.updatedAt + 1 }}
          onSendEditedMessage={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    deferred.resolve([descriptor])
    await act(async () => {
      await deferred.promise
      await Promise.resolve()
    })

    expect(resolveVersionDescriptors).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-label="Preview generated file sin.png"]')).not.toBeNull()
  })

  it('retries copied generated Version metadata after pending Session persistence settles', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'artifact-version-1',
      projectName: 'origin-project',
      sessionId: 'origin-session',
      name: 'sin.png',
      mimeType: 'image/png',
      size: 48128,
      mtimeMs: 1710000000100,
      artifactId: 'artifact-lineage-1',
      versionId: 'artifact-version-1',
      versionNumber: 2,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-03T14:43:07.000Z',
      state: 'finalized'
    }
    const resolveVersionDescriptors = vi
      .fn()
      .mockRejectedValueOnce(new Error('Session has not been persisted yet'))
      .mockResolvedValueOnce([descriptor])
    const persisted = createDeferred<void>()
    flushSessionPersistenceMock.mockReturnValueOnce(persisted.promise)
    window.api.artifacts.resolveVersionDescriptors = resolveVersionDescriptors
    const session = createSession({
      id: 'branched-session',
      status: 'running',
      messages: [
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Created the chart',
          artifactIds: ['artifact-version-1']
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveVersionDescriptors).toHaveBeenCalledTimes(1)
    expect(flushSessionPersistenceMock).toHaveBeenCalledTimes(1)

    persisted.resolve()
    await act(async () => {
      await persisted.promise
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resolveVersionDescriptors).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[aria-label="Preview generated file sin.png"]')).not.toBeNull()
  })

  it('ignores an older artifact lookup after switching away from and back to a Session', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'artifact-version-1',
      projectName: 'origin-project',
      sessionId: 'origin-session',
      name: 'sin.png',
      mimeType: 'image/png',
      size: 48128,
      mtimeMs: 1710000000100,
      artifactId: 'artifact-lineage-1',
      versionId: 'artifact-version-1',
      versionNumber: 2,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-03T14:43:07.000Z',
      state: 'finalized'
    }
    const firstLookup = createDeferred<ArtifactVersionDescriptor[]>()
    const secondLookup = createDeferred<ArtifactVersionDescriptor[]>()
    const resolveVersionDescriptors = vi
      .fn()
      .mockImplementationOnce(() => firstLookup.promise)
      .mockImplementationOnce(() => secondLookup.promise)
    window.api.artifacts.resolveVersionDescriptors = resolveVersionDescriptors
    const sessionA = createSession({
      id: 'session-a',
      status: 'idle',
      messages: [
        createMessage({
          id: 'reply-a',
          role: 'agent',
          content: 'Created the chart',
          artifactIds: ['artifact-version-1']
        })
      ]
    })
    const sessionB = createSession({ id: 'session-b', status: 'idle', messages: [] })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={sessionA} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
    })
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={sessionB} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
    })
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={sessionA} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
    })

    secondLookup.resolve([descriptor])
    await act(async () => {
      await secondLookup.promise
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-label="Preview generated file sin.png"]')).not.toBeNull()

    firstLookup.resolve([])
    await act(async () => {
      await firstLookup.promise
      await Promise.resolve()
    })

    expect(resolveVersionDescriptors).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[aria-label="Preview generated file sin.png"]')).not.toBeNull()
  })

  it('announces whole-window find readiness to main when the Workspace mounts', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle' })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    // The find bar is an Electron overlay owned by main; the Workspace's only job is to announce it is
    // mounted and searchable so main intercepts Cmd/Ctrl+F.
    expect(announceWindowFindReady).toHaveBeenCalledTimes(1)
  })

  it('does not write to the preview store for non-managed-file artifacts', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      id: 'session-1',
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
          kind: 'workspace-file',
          path: '/workspace/report.png',
          fileUrl: 'file:///workspace/report.png',
          name: 'report.png',
          mimeType: 'image/png',
          size: 2048,
          mtimeMs: 1710000000100
        }
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const card = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file report.png"]'
    )
    expect(card).not.toBeNull()

    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(upsertAndActivateItem).not.toHaveBeenCalled()
  })

  it('opens uploaded user-message attachments in the preview store', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      id: 'session-42',
      status: 'idle',
      messages: [
        createMessage({
          id: 'prompt-1',
          content: 'What is in the first image?',
          uploads: [createUpload()]
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const uploadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview uploaded attachment first.png"]'
    )
    expect(uploadButton).not.toBeNull()

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(upsertAndActivateItem).toHaveBeenCalledTimes(1)
    expect(upsertAndActivateItem).toHaveBeenCalledWith({
      id: 'upload:upload-1',
      sessionId: 'session-42',
      title: 'first.png',
      type: 'file',
      source: 'upload',
      path: '/Users/example/.open-science/uploads/default-project/session-42/first.png',
      projectId: 'default',
      name: 'first.png',
      format: 'image',
      mimeType: 'image/png',
      size: 2048
    })
  })

  it('probes a cross-session upload mention with the source session from its locator', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const path = createUploadVersionReference('upload-version-1', {
      projectId: 'project-1',
      sessionId: 'source-session'
    })
    const session = createSession({
      id: 'active-session',
      projectId: 'project-1',
      status: 'idle',
      messages: [
        createMessage({
          id: 'prompt-1',
          content: '@shared.csv',
          parts: [
            {
              type: 'artifact',
              id: 'upload-version-1',
              name: 'shared.csv',
              path,
              source: 'upload'
            }
          ]
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const mention = container.querySelector<HTMLButtonElement>('[aria-label="Preview shared.csv"]')
    await act(async () => {
      mention?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.uploads.readPreview).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'source-session',
      path,
      maxBytes: 1,
      encoding: 'utf8'
    })
    expect(upsertAndActivateItem).toHaveBeenCalledTimes(1)
  })

  const linkedFolderSession = (): ChatSession =>
    createSession({
      id: 'session-42',
      status: 'idle',
      messages: [
        createMessage({
          id: 'prompt-1',
          content: 'analyze @path:charts/sin.png',
          parts: [
            { type: 'text', text: 'analyze ' },
            {
              type: 'artifact',
              id: 'linked-1',
              name: 'sin.png',
              source: 'linked-folder',
              rootId: 'root-1',
              relativePath: 'charts/sin.png'
            }
          ]
        })
      ]
    })

  const renderAndClickLinkedPill = async (session: ChatSession): Promise<void> => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })
    const pill = container.querySelector<HTMLButtonElement>('[aria-label="Preview sin.png"]')
    expect(pill).not.toBeNull()
    await act(async () => {
      pill?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('opens a linked-folder mention at the granted root path in the preview store', async () => {
    useGrantedFoldersStore.setState({
      roots: [{ id: 'root-1', path: '/Users/roxi/data', name: 'data', access: 'ro' }],
      loaded: true
    })

    await renderAndClickLinkedPill(linkedFolderSession())

    expect(listGrantedRoots).not.toHaveBeenCalled()
    expect(upsertAndActivateItem).toHaveBeenCalledTimes(1)
    expect(upsertAndActivateItem).toHaveBeenCalledWith({
      id: 'local:/Users/roxi/data/charts/sin.png',
      sessionId: 'session-42',
      title: 'sin.png',
      type: 'file',
      source: 'local',
      path: '/Users/roxi/data/charts/sin.png',
      name: 'sin.png',
      format: 'image'
    })
  })

  it('refreshes the granted-roots store when a linked-folder mention arrives before it loaded', async () => {
    listGrantedRoots.mockResolvedValue([
      { id: 'root-1', path: '/Users/roxi/data', name: 'data', access: 'ro' }
    ])

    await renderAndClickLinkedPill(linkedFolderSession())

    expect(listGrantedRoots).toHaveBeenCalledTimes(1)
    expect(upsertAndActivateItem).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/Users/roxi/data/charts/sin.png' })
    )
  })

  it('keeps the not-available notice when the linked-folder root was revoked', async () => {
    useGrantedFoldersStore.setState({ roots: [], loaded: true })

    await renderAndClickLinkedPill(linkedFolderSession())

    expect(upsertAndActivateItem).not.toHaveBeenCalled()
    expect(container.textContent).toContain(
      'Linked-folder files are not available until the folder is connected.'
    )
  })

  it('does not read a generated text thumbnail until its card approaches the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      status: 'idle',
      messages: [
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
          path: '/workspace/report.txt',
          fileUrl: 'file:///workspace/report.txt',
          name: 'report.txt',
          mimeType: 'text/plain',
          size: 2048,
          mtimeMs: 1710000000100
        }
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const thumbnailReads = vi
      .mocked(window.api.artifacts.readPreview)
      .mock.calls.filter(([request]) => request.maxBytes !== 1)
    expect(thumbnailReads).toHaveLength(1)
  })

  it('does not leave the active Plan card in the transcript', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const activePlanProjection: ActivePlanProjection = {
      artifactId: 'artifact-plan',
      artifactVersionId: 'version-plan',
      artifactChecksum: 'a'.repeat(64),
      revision: 1,
      approval: 'pending',
      lifecycle: 'awaiting_approval',
      requiresExplicitContinuation: false,
      document: {
        schema_version: 1,
        task_summary: 'Analyze the dataset',
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
      stepStatuses: {},
      stepStates: { 'Analyze the data': { status: 'not_started' } },
      counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
    }
    const session = createSession({
      id: 'session-plan',
      projectId: 'project-plan',
      status: 'waiting-plan-approval',
      activePlanProjection
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })
    expect(container.textContent).not.toContain('Plan ready for review')
    expect(container.textContent).not.toContain('Analyze the dataset')
    expect(createSessionPlanPreviewItem).not.toHaveBeenCalled()
    expect(upsertAndActivateItem).not.toHaveBeenCalled()
  })
})
