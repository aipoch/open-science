// @vitest-environment jsdom
import { act, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { useSessionStore, type ChatMessage, type ChatSession } from '@/stores/session-store'
import {
  createInitialReviewState,
  selectProjectSessionReviews,
  useReviewStore
} from '@/stores/review-store'
import { createUploadVersionReference, type UploadedAttachment } from '../../../../shared/uploads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewWithChecks } from '../../../../shared/reviewer'
import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource
} from '../../../../shared/handoff-lifecycle'

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
const announceWindowFindReady = vi.fn(() => () => undefined)

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ upsertAndActivateItem })
  }
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
    announceWindowFindReady.mockClear()
    useReviewStore.setState(createInitialReviewState())
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
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
    expect(container.textContent).toContain('Reviewing…')
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
    expect(container.textContent).not.toContain('Reviewing…')
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
})
