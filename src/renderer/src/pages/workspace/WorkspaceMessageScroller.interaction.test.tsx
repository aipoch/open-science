// @vitest-environment jsdom
import { act, forwardRef, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
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
import type { ManagedPreviewResource } from '../../../../shared/preview-resources'
import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource
} from '../../../../shared/handoff-lifecycle'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import type {
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'
import {
  createLinearConversationGraph,
  projectConversationMessage,
  resolveActiveConversationMessages
} from '../../../../shared/conversation-graph'
import { normalizeSessionFile } from '../../../../shared/session-persistence'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'
import type { JobSummary } from '../../../../shared/compute'

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
  },
  PresentedAgentMarkdown: ({
    content,
    isAnimating
  }: {
    content: string
    isAnimating?: boolean
  }) => (
    <div data-testid="presented-agent-markdown" data-animating={isAnimating || undefined}>
      {content}
    </div>
  )
}))

vi.mock('./SessionMessageMarkdown', () => ({
  SessionMessageMarkdown: ({
    content,
    isAnimating,
    artifacts,
    onPreviewArtifact,
    onPreviewArtifactModal
  }: {
    content: string
    isAnimating?: boolean
    artifacts: NonNullable<ChatSession['artifacts']>
    onPreviewArtifact: (artifact: NonNullable<ChatSession['artifacts']>[number]) => void
    onPreviewArtifactModal: (artifact: NonNullable<ChatSession['artifacts']>[number]) => void
  }) => (
    <div data-testid="presented-agent-markdown" data-animating={isAnimating || undefined}>
      {content}
      {content === 'Markdown artifact controls' && artifacts[0] ? (
        <>
          <button
            type="button"
            data-testid="markdown-artifact-link"
            onClick={() => onPreviewArtifact(artifacts[0]!)}
          >
            Open in panel
          </button>
          <button
            type="button"
            data-testid="markdown-artifact-image"
            onClick={() => onPreviewArtifactModal(artifacts[0]!)}
          >
            Open in modal
          </button>
        </>
      ) : null}
    </div>
  )
}))

vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
  const Viewport = forwardRef<
    HTMLDivElement,
    PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>
  >(function MockMessageScrollerViewport({ children, ...props }, ref) {
    return (
      <div ref={ref} data-testid="message-scroller-viewport" {...props}>
        {children}
      </div>
    )
  })
  const Content = forwardRef<
    HTMLDivElement,
    PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>
  >(function MockMessageScrollerContent({ children, ...props }, ref) {
    return (
      <div ref={ref} data-slot="message-scroller-content" {...props}>
        {children}
      </div>
    )
  })
  const Item = ({
    children,
    messageId,
    scrollAnchor
  }: PropsWithChildren<{ messageId?: string; scrollAnchor?: boolean }>): React.JSX.Element => (
    <div
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor === true ? 'true' : undefined}
    >
      {children}
    </div>
  )
  const Button = forwardRef<
    HTMLButtonElement,
    PropsWithChildren<
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        direction?: 'start' | 'end'
        size?: string
      }
    >
  >(function MockMessageScrollerButton({ children, direction = 'end', size, ...props }, ref) {
    return (
      <button ref={ref} type="button" data-direction={direction} data-size={size} {...props}>
        {children ?? `Scroll to ${direction}`}
      </button>
    )
  })

  return {
    MessageScrollerProvider: Wrapper,
    MessageScroller: Wrapper,
    MessageScrollerViewport: Viewport,
    MessageScrollerContent: Content,
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

const upsertAndActivateItem = vi.fn()
const openFileDialog = vi.fn()
const listGrantedRoots = vi.fn()
const createSessionPlanPreviewItem = vi.fn((sessionId: string, projectId: string) => ({
  id: `tool:${sessionId}:plan`,
  sessionId,
  projectId,
  type: 'tool' as const,
  toolKind: 'plan' as const,
  title: 'Plan'
}))
const createSessionSubagentsPreviewItem = vi.fn(
  (sessionId: string, projectId: string | undefined, selectedAgentFrameId: string) => ({
    id: `tool:${sessionId}:subagents`,
    sessionId,
    ...(projectId ? { projectId } : {}),
    type: 'tool' as const,
    toolKind: 'subagents' as const,
    title: 'Subagents',
    selectedAgentFrameId
  })
)
const announceWindowFindReady = vi.fn(() => () => undefined)
const announceWindowFindContentReady = vi.fn()
let showWindowFindListener: (() => void) | undefined
const onShowWindowFind = vi.fn((listener: () => void) => {
  showWindowFindListener = listener
  return () => {
    if (showWindowFindListener === listener) showWindowFindListener = undefined
  }
})
let hideWindowFindListener: (() => void) | undefined
const onHideWindowFind = vi.fn((listener: () => void) => {
  hideWindowFindListener = listener
  return () => {
    if (hideWindowFindListener === listener) hideWindowFindListener = undefined
  }
})

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ openFileDialog, upsertAndActivateItem })
  },
  createSessionPlanPreviewItem,
  createSessionSubagentsPreviewItem
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

const installIntersectionObserver = (): (() => void) => {
  const observers = new Set<{
    callback: IntersectionObserverCallback
    elements: Set<Element>
  }>()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly record: { callback: IntersectionObserverCallback; elements: Set<Element> }
      observe = vi.fn((element: Element) => this.record.elements.add(element))
      unobserve = vi.fn((element: Element) => this.record.elements.delete(element))
      disconnect = vi.fn(() => observers.delete(this.record))

      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, elements: new Set() }
        observers.add(this.record)
      }
    }
  )
  return () => {
    for (const { callback, elements } of observers) {
      callback(
        [...elements].map(
          (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry
        ),
        {} as IntersectionObserver
      )
    }
  }
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
    openFileDialog.mockClear()
    listGrantedRoots.mockReset().mockResolvedValue([])
    useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
    useSessionJobStore.setState(createInitialSessionJobState())
    createSessionSubagentsPreviewItem.mockClear()
    announceWindowFindReady.mockClear()
    announceWindowFindContentReady.mockClear()
    onShowWindowFind.mockClear()
    showWindowFindListener = undefined
    onHideWindowFind.mockClear()
    hideWindowFindListener = undefined
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
        announceWindowFindReady,
        announceWindowFindContentReady,
        onShowWindowFind,
        onHideWindowFind
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('keeps every transcript row a direct MessageScrollerItem child of the content element', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({
      id: 'prompt-structure',
      content: 'Flatten the transcript',
      sortIndex: 1,
      createdAt: 100
    })
    const reply = createMessage({
      id: 'reply-structure',
      role: 'agent',
      content: 'Reply body',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const session = createSession({ status: 'idle', messages: [prompt, reply] })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    // message-scroller only measures and anchors Content's direct children, so every transcript
    // row must be a MessageScrollerItem and no wrapper div may sit in between.
    const content = container.querySelector('[data-slot="message-scroller-content"]')
    expect(content).not.toBeNull()
    const rows = Array.from(content?.children ?? [])
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.getAttribute('data-slot')).toBe('message-scroller-item')
    }

    const userRow = content?.querySelector('[data-message-id="prompt-structure"]')
    expect(userRow?.getAttribute('data-scroll-anchor')).toBe('true')
    const agentRow = content?.querySelector('[data-message-id="reply-structure"]')
    expect(agentRow?.getAttribute('data-scroll-anchor')).toBeNull()
  })

  it('keeps more than one targeted batch of near-viewport historical figures stable while rows stay collapsed', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const notebookReference: NotebookSessionReference = {
      sessionId: 'session-1',
      projectId: 'default',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/workspace/.notebook',
      dataRoot: '/workspace/data',
      runtimeRoot: '/workspace/runtime',
      runJsonPath: '/workspace/run.json'
    }
    const historicalRuns: NotebookRunRecord[] = Array.from({ length: 21 }, (_, index) => ({
      runId: `historical-run-${index + 1}`,
      executionInvocationId: `invocation-${index + 1}`,
      cellId: `cell-${index + 1}`,
      source: 'agent',
      kernelKind: 'r',
      script: `plot(${index + 1})`,
      status: 'completed',
      startedAt: index + 1,
      endedAt: index + 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [{ type: 'display', data: { 'image/png': 'QUJD' } }],
      artifacts: [],
      workingFiles: []
    }))
    const makeNotebookState = (runs: NotebookRunRecord[]): NotebookSessionState => ({
      id: 'notebook-1',
      sessionId: notebookReference.sessionId,
      cwd: notebookReference.workspaceCwd,
      notebookSessionRoot: notebookReference.notebookSessionRoot,
      dataRoot: notebookReference.dataRoot,
      runtimeRoot: notebookReference.runtimeRoot,
      kernelStatus: 'idle',
      runJsonPath: notebookReference.runJsonPath,
      cells: [],
      runCount: 101,
      latestRunEnvironments: {},
      runs,
      recentRuns: runs,
      environments: []
    })
    const loadNotebookState = vi.fn(
      async (request: { runIds?: string[] }): Promise<NotebookSessionState> =>
        makeNotebookState(
          historicalRuns.filter((run) => request.runIds?.includes(run.runId) === true)
        )
    )
    window.api = {
      ...window.api,
      notebook: {
        state: loadNotebookState,
        onChanged: vi.fn(() => vi.fn())
      }
    } as unknown as Window['api']
    const activities = historicalRuns.map((run, index) =>
      createActivity({
        id: `notebook-tool-${index + 1}`,
        status: 'completed',
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        executionInvocationId: run.executionInvocationId,
        rawInput: { code: run.script, kernelKind: run.kernelKind },
        rawOutput: { runId: run.runId, status: run.status }
      })
    )

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', activities })}
          notebookReference={notebookReference}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    await waitFor(() => {
      const targetedRunIds = loadNotebookState.mock.calls.flatMap(
        ([request]) => request.runIds ?? []
      )
      expect(new Set(targetedRunIds)).toEqual(new Set(historicalRuns.map((run) => run.runId)))
    })
    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-testid="notebook-tool-figure-button"]')
      ).toHaveLength(21)
    )
    expect(container.querySelector('[data-testid="tool-details"]')).toBeNull()
  })

  it('renders later tools in real time while the assistant reply is still pacing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({ id: 'prompt-stream', sortIndex: 1, createdAt: 100 })
    const reply = createMessage({
      id: 'reply-stream',
      role: 'agent',
      content: 'Flow',
      status: 'streaming',
      streamId: 'stream-1',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt]
      })
    )
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt, reply]
      })
    )
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      ''
    )

    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      'F'
    )

    const tool = createActivity({
      id: 'tool-after-stream',
      title: 'Tool after buffered text',
      promptMessageId: prompt.id,
      sortIndex: 3,
      createdAt: 102
    })
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt, reply],
        activities: [tool]
      })
    )
    // Tool rows render in real time so their running state stays visible; only later
    // text messages wait behind the pacing reply.
    expect(
      container.querySelector('[data-message-id="activity-group-tool-after-stream"]')
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      'F'
    )

    await act(async () => vi.advanceTimersByTimeAsync(96))
    expect(container.textContent).toContain('Flow')
  })

  it('keeps terminal metadata behind the final visible assistant prefix', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({ id: 'prompt-terminal', sortIndex: 1, createdAt: 100 })
    const reply = createMessage({
      id: 'reply-terminal',
      role: 'agent',
      content: 'Done',
      status: 'streaming',
      streamId: 'stream-terminal',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt]
      })
    )
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt, reply]
      })
    )
    await render(
      createSession({
        status: 'idle',
        messages: [
          prompt,
          {
            ...reply,
            status: 'complete',
            completedAt: 200,
            updatedAt: 200
          }
        ]
      })
    )
    expect(container.textContent).not.toContain('Completed')
    expect(container.textContent).not.toContain('Done')

    await act(async () => vi.advanceTimersByTimeAsync(96))
    expect(container.textContent).toContain('Done')
    expect(container.textContent).toContain('Completed')
  })

  it('announces only assistant terminal transitions after the current branch mounts', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const historicalPrompt = createMessage({
      id: 'prompt-historical-failure',
      sortIndex: 1,
      createdAt: 100
    })
    const historicalFailure = createMessage({
      id: 'reply-historical-failure',
      role: 'agent',
      content: 'Historical failure',
      status: 'error',
      responseToMessageId: historicalPrompt.id,
      failedAt: 102,
      sortIndex: 2,
      createdAt: 101,
      updatedAt: 102
    })
    const completionPrompt = createMessage({
      id: 'prompt-live-completion',
      sortIndex: 3,
      createdAt: 200
    })
    const streamingCompletion = createMessage({
      id: 'reply-live-completion',
      role: 'agent',
      content: '',
      status: 'streaming',
      streamId: 'stream-live-completion',
      responseToMessageId: completionPrompt.id,
      sortIndex: 4,
      createdAt: 201
    })
    const failurePrompt = createMessage({
      id: 'prompt-live-failure',
      sortIndex: 5,
      createdAt: 300
    })
    const streamingFailure = createMessage({
      id: 'reply-live-failure',
      role: 'agent',
      content: '',
      status: 'streaming',
      streamId: 'stream-live-failure',
      responseToMessageId: failurePrompt.id,
      sortIndex: 6,
      createdAt: 301
    })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(
      createSession({
        status: 'error',
        messages: [historicalPrompt, historicalFailure]
      })
    )

    const completionRegion = container.querySelector(
      '[data-testid="message-completion-live-region"]'
    )
    const failureRegion = container.querySelector('[data-testid="message-failure-live-region"]')
    expect(completionRegion?.getAttribute('aria-live')).toBe('polite')
    expect(failureRegion?.getAttribute('aria-live')).toBe('assertive')
    expect(completionRegion?.textContent).toBe('')
    expect(failureRegion?.textContent).toBe('')

    await render(
      createSession({
        messages: [historicalPrompt, historicalFailure, completionPrompt, streamingCompletion],
        activeRun: { promptMessageId: completionPrompt.id, startedAt: 200 }
      })
    )
    expect(completionRegion?.textContent).toBe('')
    expect(failureRegion?.textContent).toBe('')

    const completedReply = {
      ...streamingCompletion,
      status: 'complete' as const,
      completedAt: 202,
      updatedAt: 202
    }
    await render(
      createSession({
        status: 'idle',
        messages: [historicalPrompt, historicalFailure, completionPrompt, completedReply]
      })
    )
    expect(completionRegion?.textContent).toBe('Response completed.')
    expect(failureRegion?.textContent).toBe('')

    await render(
      createSession({
        messages: [
          historicalPrompt,
          historicalFailure,
          completionPrompt,
          completedReply,
          failurePrompt,
          streamingFailure
        ],
        activeRun: { promptMessageId: failurePrompt.id, startedAt: 300 }
      })
    )
    const failedReply = {
      ...streamingFailure,
      status: 'error' as const,
      failedAt: 302,
      updatedAt: 302
    }
    await render(
      createSession({
        status: 'error',
        messages: [
          historicalPrompt,
          historicalFailure,
          completionPrompt,
          completedReply,
          failurePrompt,
          failedReply
        ]
      })
    )
    expect(completionRegion?.textContent).toBe('')
    expect(failureRegion?.textContent).toBe('Response failed.')
  })

  it('waits to announce completion until an ask-user continuation settles', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({ id: 'prompt-continuation', sortIndex: 1, createdAt: 100 })
    const streamingReply = createMessage({
      id: 'reply-continuation',
      role: 'agent',
      content: 'Choose a chart type.',
      status: 'streaming',
      streamId: 'stream-continuation',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt, streamingReply]
      })
    )

    const completionRegion = container.querySelector(
      '[data-testid="message-completion-live-region"]'
    )
    const completedReply = {
      ...streamingReply,
      status: 'complete' as const,
      completedAt: 102,
      updatedAt: 102
    }
    await render(
      createSession({
        activeRun: undefined,
        agentPromptInFlight: true,
        awaitingFirstAgentOutput: true,
        messages: [prompt, completedReply]
      })
    )
    expect(completionRegion?.textContent).toBe('')

    await render(
      createSession({
        status: 'idle',
        activeRun: undefined,
        agentPromptInFlight: false,
        awaitingFirstAgentOutput: false,
        messages: [prompt, completedReply]
      })
    )
    expect(completionRegion?.textContent).toBe('Response completed.')
  })

  it('does not replay a buffered assistant message after switching sessions', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({ id: 'prompt-session-a', sortIndex: 1, createdAt: 100 })
    const reply = createMessage({
      id: 'reply-session-a',
      role: 'agent',
      content: 'Resume without replay after switching sessions',
      status: 'streaming',
      streamId: 'stream-session-a',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const sessionA = createSession({
      id: 'session-a',
      activeRun: { promptMessageId: prompt.id, startedAt: 100 },
      messages: [prompt, reply]
    })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(
      createSession({
        id: sessionA.id,
        activeRun: sessionA.activeRun,
        messages: [prompt]
      })
    )
    await render(sessionA)
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      'R'
    )

    await render(
      createSession({
        id: 'session-b',
        messages: [createMessage({ id: 'prompt-session-b' })]
      })
    )
    await render(sessionA)

    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      reply.content
    )

    const continuedReply = { ...reply, content: `${reply.content} plus more` }
    await render({ ...sessionA, messages: [prompt, continuedReply] })
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      reply.content
    )
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      `${reply.content} `
    )
  })

  it('does not replay an assistant fragment after the turn advances to a tool', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({ id: 'prompt-before-tool', sortIndex: 1, createdAt: 100 })
    const reply = createMessage({
      id: 'reply-before-tool',
      role: 'agent',
      content: 'Fixed before tool',
      status: 'streaming',
      streamId: 'stream-before-tool',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const tool = createActivity({
      id: 'tool-after-fixed-fragment',
      title: 'Tool after fixed fragment',
      promptMessageId: prompt.id,
      sortIndex: 3,
      createdAt: 102
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({
            activeRun: { promptMessageId: prompt.id, startedAt: 100 },
            messages: [prompt, reply],
            activities: [tool]
          })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      reply.content
    )
    expect(
      container.querySelector('[data-message-id="activity-group-tool-after-fixed-fragment"]')
    ).not.toBeNull()
  })

  it('paces a new assistant fragment that arrives after a tool', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const prompt = createMessage({ id: 'prompt-around-tool', sortIndex: 1, createdAt: 100 })
    const beforeTool = createMessage({
      id: 'reply-before-live-tool',
      role: 'agent',
      content: 'Before tool',
      status: 'streaming',
      streamId: 'stream-around-tool',
      responseToMessageId: prompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const tool = createActivity({
      id: 'tool-between-fragments',
      title: 'Tool between fragments',
      promptMessageId: prompt.id,
      sortIndex: 3,
      createdAt: 102
    })
    const afterTool = createMessage({
      id: 'reply-after-live-tool',
      role: 'agent',
      content: 'After tool',
      status: 'streaming',
      streamId: 'stream-around-tool',
      responseToMessageId: prompt.id,
      sortIndex: 4,
      createdAt: 103
    })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt]
      })
    )
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt, beforeTool]
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(512))
    await render(
      createSession({
        activeRun: { promptMessageId: prompt.id, startedAt: 100 },
        messages: [prompt, beforeTool, afterTool],
        activities: [tool]
      })
    )
    // The tool row renders in real time; the later assistant fragment is the only row
    // still held behind the pacing one.
    expect(
      container.querySelector('[data-message-id="activity-group-tool-between-fragments"]')
    ).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="presented-agent-markdown"]')).toHaveLength(1)
    await act(async () => vi.advanceTimersByTimeAsync(160))

    const assistantSurfaces = container.querySelectorAll('[data-testid="presented-agent-markdown"]')
    expect(assistantSurfaces).toHaveLength(2)
    expect(assistantSurfaces[0]?.textContent).toBe(beforeTool.content)
    expect(assistantSurfaces[1]?.textContent).toBe('')
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(assistantSurfaces[1]?.textContent).toBe('A')
  })

  it('does not replay a buffered assistant message after switching active branches', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const promptA = createMessage({ id: 'prompt-branch-a', sortIndex: 1, createdAt: 100 })
    const replyA = createMessage({
      id: 'reply-branch-a',
      role: 'agent',
      content: 'Resume without replay on the original branch',
      status: 'streaming',
      streamId: 'stream-branch-a',
      responseToMessageId: promptA.id,
      sortIndex: 2,
      createdAt: 101
    })
    const createGraph = (
      messages: ChatMessage[]
    ): ReturnType<typeof createLinearConversationGraph> =>
      createLinearConversationGraph({
        sessionId: 'branched-stream-session',
        messages,
        frameworkId: 'codex',
        createdAt: 100,
        updatedAt: 101
      })
    const initialGraphA = createGraph([promptA])
    const streamingGraphA = createGraph([promptA, replyA])
    const branchBGraph = structuredClone(streamingGraphA)
    branchBGraph.branches.push({
      ...branchBGraph.branches[0],
      id: 'branch-b',
      parentBranchId: branchBGraph.branches[0].id,
      createdAt: 102,
      updatedAt: 102
    })
    branchBGraph.frames[0].activeBranchId = 'branch-b'
    const sessionFromGraph = (graph: typeof streamingGraphA): ChatSession =>
      createSession({
        id: 'branched-stream-session',
        activeRun: { promptMessageId: promptA.id, startedAt: 100 },
        conversationGraph: graph,
        messages: resolveActiveConversationMessages(graph).map((message, index) => ({
          ...projectConversationMessage(message),
          sortIndex: index + 1
        }))
      })
    const render = async (session: ChatSession): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      })
    }

    root = createRoot(container)
    await render(sessionFromGraph(initialGraphA))
    await render(sessionFromGraph(streamingGraphA))
    await act(async () => vi.advanceTimersByTimeAsync(512))
    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      'R'
    )

    await render(sessionFromGraph(branchBGraph))

    expect(container.querySelector('[data-testid="presented-agent-markdown"]')?.textContent).toBe(
      replyA.content
    )
  })

  it('opens the exact durable source Frame from an inline upward message', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const rootPrompt = createMessage({
      id: 'root-prompt',
      content: 'Gather evidence',
      createdAt: 100,
      updatedAt: 100
    })
    const session = createSession({
      id: 'session-inline',
      projectId: 'project-inline',
      messages: [rootPrompt]
    })
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      frameworkId: 'codex',
      createdAt: 100,
      updatedAt: 100
    })
    const graph = session.conversationGraph
    const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)!
    graph.frames.push({
      id: 'source-child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: rootPrompt.id,
      originBindingState: 'validated',
      kind: 'delegate',
      delegateName: 'Evidence mapper',
      status: 'running',
      activeBranchId: 'source-child-branch',
      createdAt: 110
    })
    session.runtimeContext = {
      version: 1,
      revision: 1,
      delegatedWork: {
        records: [],
        messageCommands: [
          {
            messageId: 'upward-message',
            requestId: 'request-upward',
            sourcePrincipal: 'child',
            canonicalDigest: 'digest-upward',
            sourceFrameId: 'source-child-frame',
            targetFrameId: graph.rootFrameId,
            rootOriginMessageId: rootPrompt.id,
            callerRootMessageId: rootPrompt.id,
            rootBranchId: rootFrame.activeBranchId,
            rootBranchRevision: 'revision-1',
            direction: 'to_parent',
            disposition: 'message',
            text: 'Should I include the preprint evidence?',
            kind: 'question',
            laneSequence: 1,
            queuedAt: 120,
            receipt: {
              status: 'accepted',
              acceptedAt: 130,
              evidence: 'provider_prompt_accepted'
            }
          }
        ]
      }
    }

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const source = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Subagent preview for Evidence mapper"]'
    )
    expect(source).not.toBeNull()
    await act(async () => source?.click())

    expect(createSessionSubagentsPreviewItem).toHaveBeenCalledWith(
      'session-inline',
      'project-inline',
      'source-child-frame'
    )
    expect(upsertAndActivateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool:session-inline:subagents',
        selectedAgentFrameId: 'source-child-frame'
      })
    )
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
      container.querySelector<HTMLButtonElement>('[data-testid="elicitation-answer-row"]')?.click()
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
          return { ok: true, disposition: 'sent' as const }
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

  it('renders every Review Run under its audited answer in deterministic history order', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const reviews: ReviewWithChecks[] = [
      {
        id: 'review-later',
        projectId: 'default',
        sessionId: 'session-1',
        turnMessageId: 'chain-root',
        scope: {
          turnMessageId: 'reply-1',
          messageBranchId: 'message-branch-1',
          blocks: [],
          artifactVersionIds: []
        },
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model',
        reviewerLog: [],
        createdAt: 2_000,
        updatedAt: 2_000,
        checks: []
      },
      {
        id: 'review-earlier',
        projectId: 'default',
        sessionId: 'session-1',
        turnMessageId: 'chain-root',
        scope: {
          turnMessageId: 'reply-1',
          messageBranchId: 'message-branch-1',
          blocks: [],
          artifactVersionIds: []
        },
        lifecycle: 'complete',
        outcome: 'flagged',
        model: 'test-model',
        reviewerLog: [],
        createdAt: 1_000,
        updatedAt: 1_000,
        checks: []
      }
    ]
    for (const review of reviews) useReviewStore.getState().handleReviewUpdate({ review })
    const session = createSession({
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-1' }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Corrected answer',
          responseToMessageId: 'prompt-1'
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const earlierCard = container.querySelector<HTMLElement>(
      '[data-testid="reviewer-card"][data-review-id="review-earlier"]'
    )
    const laterCard = container.querySelector<HTMLElement>(
      '[data-testid="reviewer-card"][data-review-id="review-later"]'
    )
    expect(earlierCard).not.toBeNull()
    expect(laterCard).not.toBeNull()
    expect(earlierCard?.textContent).toContain('Issues found')
    expect(laterCard?.textContent).toContain('No issues found')
    expect(
      earlierCard!.compareDocumentPosition(laterCard!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0)
  })

  it('renders a terminal Review after later tool activity and Turn completion metadata', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    useReviewStore.getState().handleReviewUpdate({
      review: {
        id: 'review-1',
        projectId: 'default',
        sessionId: 'session-1',
        turnMessageId: 'reply-1',
        scope: { turnMessageId: 'reply-1', blocks: [], artifactVersionIds: [] },
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model',
        reviewerLog: [],
        createdAt: 500,
        updatedAt: 500,
        checks: []
      }
    })
    const session = createSession({
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-1', createdAt: 100, updatedAt: 100, sortIndex: 1 }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'I will finish the remaining work.',
          responseToMessageId: 'prompt-1',
          createdAt: 200,
          completedAt: 400,
          updatedAt: 400,
          sortIndex: 2
        })
      ],
      activities: [
        createActivity({
          id: 'tool-late',
          status: 'completed',
          promptMessageId: 'prompt-1',
          createdAt: 300,
          updatedAt: 300,
          sortIndex: 3
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const toolRow = container.querySelector('[data-message-id="activity-group-tool-late"]')!
    const completion = container.querySelector('[data-message-id="turn-completion-reply-1"]')!
    const review = container.querySelector('[data-message-id="review-reply-1"]')!

    expect(toolRow.compareDocumentPosition(completion) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0
    )
    expect(completion.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0
    )
  })

  it('renders one initial and three fix-loop Review Runs at their four distinct scope anchors', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const answerIds = ['answer-initial', 'answer-fix-1', 'answer-fix-2', 'answer-fix-3']
    answerIds.forEach((scopeTurnMessageId, index) => {
      useReviewStore.getState().handleReviewUpdate({
        review: {
          id: `review-round-${index}`,
          projectId: 'default',
          sessionId: 'session-1',
          turnMessageId: 'answer-initial',
          scope: { turnMessageId: scopeTurnMessageId, blocks: [], artifactVersionIds: [] },
          lifecycle: 'complete',
          outcome: index === 3 ? 'pass' : 'flagged',
          model: 'test-model',
          reviewerLog: [],
          createdAt: 1_000 + index,
          updatedAt: 1_000 + index,
          checks:
            index === 2
              ? [
                  {
                    id: 'review-round-2-pass-check',
                    reviewId: 'review-round-2',
                    status: 'pass',
                    claim: 'A newly assessed claim passed',
                    evidence: 'The tracked failures remain represented by the review verdict.',
                    resolution: 'open',
                    sortIndex: 0,
                    reflagCount: 0
                  }
                ]
              : []
        }
      })
    })
    const messages = answerIds.flatMap((answerId, index) => {
      const promptId = `prompt-round-${index}`
      return [
        createMessage({ id: promptId, sortIndex: index * 2 + 1 }),
        createMessage({
          id: answerId,
          role: 'agent',
          content: `Answer round ${index}`,
          responseToMessageId: promptId,
          sortIndex: index * 2 + 2
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(container.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(4)
    for (const answerId of answerIds) {
      expect(
        container.querySelector(
          `[data-review-anchor-message-id="${answerId}"] [data-testid="reviewer-card"]`
        )
      ).not.toBeNull()
    }

    const secondReviewCard = container.querySelector<HTMLElement>(
      '[data-review-anchor-message-id="answer-fix-1"] [data-testid="reviewer-card"]'
    )
    const thirdReviewCard = container.querySelector<HTMLElement>(
      '[data-review-anchor-message-id="answer-fix-2"] [data-testid="reviewer-card"]'
    )
    expect(secondReviewCard?.textContent).toContain('Issues found')
    expect(secondReviewCard?.textContent).not.toContain('No issues found')
    expect(secondReviewCard?.dataset.reviewId).toBe('review-round-1')
    expect(thirdReviewCard?.textContent).toContain('Issues found')
    expect(thirdReviewCard?.textContent).not.toContain('No issues found')
    expect(thirdReviewCard?.dataset.reviewId).toBe('review-round-2')
  })

  it('keeps a stale Review and its newer re-run visible in chronological order', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const baseReview: ReviewWithChecks = {
      id: 'review-stale',
      projectId: 'default',
      sessionId: 'session-1',
      turnMessageId: 'answer-rerun',
      scope: { turnMessageId: 'answer-rerun', blocks: [], artifactVersionIds: [] },
      lifecycle: 'complete',
      outcome: 'flagged',
      model: 'old-model',
      reviewerLog: [],
      createdAt: 1_000,
      updatedAt: 1_000,
      stale: true,
      checks: [
        {
          id: 'stale-check',
          reviewId: 'review-stale',
          status: 'warn',
          claim: 'Old issue',
          evidence: 'Old evidence',
          resolution: 'open',
          sortIndex: 0,
          reflagCount: 0
        }
      ]
    }
    useReviewStore.getState().handleReviewUpdate({ review: baseReview })
    useReviewStore.getState().handleReviewUpdate({
      review: {
        ...baseReview,
        id: 'review-rerun',
        outcome: 'pass',
        model: 'new-model',
        stale: false,
        checks: [],
        createdAt: 2_000,
        updatedAt: 2_000
      }
    })
    const prompt = createMessage({ id: 'prompt-rerun' })
    const answer = createMessage({
      id: 'answer-rerun',
      role: 'agent',
      content: 'Revised answer',
      responseToMessageId: prompt.id
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages: [prompt, answer] })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    const cards = container.querySelectorAll<HTMLElement>('[data-testid="reviewer-card"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.querySelector('[data-testid="reviewer-stale-notice"]')).not.toBeNull()
    expect(cards[0]?.textContent).toContain('1 finding (outdated)')
    expect(cards[1]?.querySelector('[data-testid="reviewer-stale-notice"]')).toBeNull()
    expect(cards[1]?.textContent).toContain('No issues found')
  })

  it('does not treat a valid scope behind the presentation barrier as dangling', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    useReviewStore.getState().handleReviewUpdate({
      review: {
        id: 'review-behind-barrier',
        projectId: 'default',
        sessionId: 'session-1',
        turnMessageId: 'answer-chain-root',
        scope: { turnMessageId: 'answer-actual', blocks: [], artifactVersionIds: [] },
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model',
        reviewerLog: [],
        createdAt: 1_000,
        updatedAt: 1_000,
        checks: []
      }
    })
    const rootPrompt = createMessage({ id: 'prompt-chain-root', sortIndex: 1, createdAt: 100 })
    const rootAnswer = createMessage({
      id: 'answer-chain-root',
      role: 'agent',
      content: 'Earlier chain answer',
      responseToMessageId: rootPrompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const barrierPrompt = createMessage({ id: 'prompt-barrier', sortIndex: 3, createdAt: 102 })
    const barrierAnswer = createMessage({
      id: 'answer-barrier',
      role: 'agent',
      content: 'Hold this streaming presentation open until the buffered answer is revealed.',
      status: 'streaming',
      streamId: 'stream-barrier',
      responseToMessageId: barrierPrompt.id,
      sortIndex: 4,
      createdAt: 103
    })
    const actualPrompt = createMessage({ id: 'prompt-actual', sortIndex: 5, createdAt: 104 })
    const actualAnswer = createMessage({
      id: 'answer-actual',
      role: 'agent',
      content: 'Actually reviewed answer',
      responseToMessageId: actualPrompt.id,
      sortIndex: 6,
      createdAt: 105
    })
    const render = async (messages: ChatMessage[]): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller
            activeSession={createSession({
              messages,
              activeRun: { promptMessageId: barrierPrompt.id, startedAt: 102 }
            })}
            onSendEditedMessage={vi.fn()}
          />
        )
      })
    }

    root = createRoot(container)
    await render([rootPrompt, rootAnswer, barrierPrompt])
    await render([rootPrompt, rootAnswer, barrierPrompt, barrierAnswer])
    await render([rootPrompt, rootAnswer, barrierPrompt, barrierAnswer, actualPrompt, actualAnswer])

    expect(
      container.querySelector(
        '[data-review-anchor-message-id="answer-chain-root"] [data-testid="reviewer-card"]'
      )
    ).toBeNull()
    expect(container.querySelector('[data-message-id="answer-actual"]')).toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))

    expect(
      container.querySelector(
        '[data-review-anchor-message-id="answer-actual"] [data-testid="reviewer-card"]'
      )
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[data-review-anchor-message-id="answer-chain-root"] [data-testid="reviewer-card"]'
      )
    ).toBeNull()
  })

  it('hides a configuration divider with its owning follow-up while the presentation barrier is open', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const firstPrompt = createMessage({
      id: 'prompt-config-barrier',
      content: 'First send',
      sortIndex: 1,
      createdAt: 100,
      agentTarget: {
        frameworkId: 'claude-code',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'default'
      }
    })
    const firstAnswer = createMessage({
      id: 'answer-config-barrier',
      role: 'agent',
      content: 'Hold this streaming presentation open until the follow-up is revealed.',
      status: 'streaming',
      streamId: 'stream-config-barrier',
      responseToMessageId: firstPrompt.id,
      sortIndex: 2,
      createdAt: 101
    })
    const followUp = createMessage({
      id: 'prompt-config-follow-up',
      content: 'Follow-up after a model change',
      sortIndex: 3,
      createdAt: 102,
      agentTarget: {
        frameworkId: 'claude-code',
        providerId: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'default'
      }
    })
    const render = async (messages: ChatMessage[]): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller
            activeSession={createSession({
              messages,
              activeRun: { promptMessageId: firstPrompt.id, startedAt: 100 }
            })}
            onSendEditedMessage={vi.fn()}
          />
        )
      })
    }

    root = createRoot(container)
    await render([firstPrompt])
    await render([firstPrompt, firstAnswer])
    await render([firstPrompt, firstAnswer, followUp])

    expect(container.querySelector('[data-testid="session-config-change"]')).toBeNull()
    expect(container.textContent).not.toContain('Follow-up after a model change')

    await act(async () => vi.advanceTimersByTimeAsync(5_000))

    expect(container.querySelector('[data-testid="session-config-change"]')).not.toBeNull()
    expect(container.textContent).toContain('Follow-up after a model change')
  })

  it('renders a Review under its visible chain root when its persisted scope anchor is dangling', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    useReviewStore.getState().handleReviewUpdate({
      review: {
        id: 'review-dangling-scope',
        projectId: 'default',
        sessionId: 'session-1',
        turnMessageId: 'reply-visible',
        scope: {
          turnMessageId: 'reply-deleted',
          blocks: [],
          artifactVersionIds: []
        },
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model',
        reviewerLog: [],
        createdAt: 1_000,
        updatedAt: 1_000,
        checks: []
      }
    })
    const session = createSession({
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-visible' }),
        createMessage({
          id: 'reply-visible',
          role: 'agent',
          content: 'Visible answer',
          responseToMessageId: 'prompt-visible'
        })
      ]
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    expect(container.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(1)
    expect(container.textContent).toContain('No issues found')
  })

  it('projects Review cards only for Messages on the active visible branch', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const reviewFor = (
      id: string,
      messageId: string,
      outcome: 'pass' | 'flagged'
    ): ReviewWithChecks =>
      ({
        id,
        projectId: 'default',
        sessionId: 'session-1',
        turnMessageId: messageId,
        scope: { turnMessageId: messageId, blocks: [], artifactVersionIds: [] },
        lifecycle: 'complete',
        outcome,
        model: 'test-model',
        reviewerLog: [],
        createdAt: 1_000,
        updatedAt: 1_000,
        checks:
          outcome === 'flagged'
            ? [
                {
                  id: `${id}-check`,
                  reviewId: id,
                  status: 'warn',
                  claim: 'Branch B finding',
                  evidence: 'Visible only on Branch B.',
                  resolution: 'open',
                  sortIndex: 0,
                  reflagCount: 0
                }
              ]
            : []
      }) satisfies ReviewWithChecks
    useReviewStore
      .getState()
      .handleReviewUpdate({ review: reviewFor('review-a', 'reply-a', 'pass') })
    useReviewStore
      .getState()
      .handleReviewUpdate({ review: reviewFor('review-b', 'reply-b', 'flagged') })
    const branchSession = (promptId: string, replyId: string, content: string): ChatSession =>
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: promptId }),
          createMessage({
            id: replyId,
            role: 'agent',
            content,
            responseToMessageId: promptId
          })
        ]
      })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={branchSession('prompt-a', 'reply-a', 'Branch A')}
          onSendEditedMessage={vi.fn()}
        />
      )
    })
    expect(container.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(1)
    expect(container.textContent).toContain('No issues found')

    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={branchSession('prompt-b', 'reply-b', 'Branch B')}
          onSendEditedMessage={vi.fn()}
        />
      )
    })
    expect(container.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(1)
    expect(container.textContent).toContain('1 finding')
    expect(container.textContent).not.toContain('No issues found')
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

  it('opens a generated artifact from both its card and hover icon', async () => {
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

    upsertAndActivateItem.mockClear()
    const openIcon = card?.querySelector<HTMLElement>('[data-slot="generated-artifact-open-icon"]')
    expect(openIcon).not.toBeNull()

    await act(async () => {
      openIcon?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(upsertAndActivateItem).toHaveBeenCalledTimes(1)
    expect(upsertAndActivateItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'artifact-1', sessionId: 'session-42' })
    )
  })

  it('routes Markdown artifact links to the panel and Markdown artifact images to the dialog', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      id: 'session-42',
      status: 'idle',
      messages: [
        createMessage({ id: 'prompt-1' }),
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Markdown artifact controls',
          artifactIds: ['artifact-1']
        })
      ],
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/workspace/report.png',
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

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="markdown-artifact-link"]')?.click()
    })
    expect(upsertAndActivateItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'artifact-1', sessionId: 'session-42' })
    )
    expect(openFileDialog).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="markdown-artifact-image"]')?.click()
    })
    expect(openFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'artifact-1', sessionId: 'session-42' })
    )
  })

  it.each([true, false])(
    'hydrates historical publication without saving Session metadata: %s',
    async (isPublished) => {
      const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
      const artifact = {
        id: 'historical-version',
        artifactId: 'historical-artifact',
        versionId: 'historical-version',
        kind: 'managed-file' as const,
        path: '/workspace/historical.txt',
        name: 'historical.txt',
        mimeType: 'text/plain',
        size: 10,
        mtimeMs: 1
      }
      const session = createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Done',
            artifactIds: [artifact.id]
          })
        ],
        artifacts: [artifact]
      })
      let resolve!: (descriptors: ArtifactVersionDescriptor[]) => void
      window.api.artifacts.resolveVersionDescriptors = vi.fn(
        () =>
          new Promise<ArtifactVersionDescriptor[]>((done) => {
            resolve = done
          })
      )
      root = createRoot(container)
      await act(async () =>
        root.render(
          <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
        )
      )
      const card = (): HTMLButtonElement | null =>
        container.querySelector('button[aria-label="Preview generated file historical.txt"]')
      expect(card()?.disabled).toBe(true)
      expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
      expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
      expect(window.api.artifacts.resolveVersionDescriptors).toHaveBeenCalledWith({
        projectId: session.projectId,
        appSessionId: session.id,
        versionIds: [artifact.versionId]
      })
      await act(async () =>
        resolve([
          {
            ...artifact,
            projectId: session.projectId,
            sessionId: session.id,
            versionNumber: 1,
            checksum: 'a'.repeat(64),
            createdAt: '2026-09-05T00:00:00.000Z',
            state: 'finalized',
            isPublished
          }
        ])
      )
      expect(card()?.disabled).toBe(!isPublished)
      expect(session.artifacts).toEqual([artifact])
      expect('isPublished' in artifact).toBe(false)
      if (!isPublished) {
        expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
        expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
        // A later live publication takes precedence over a cached unpublished historical result.
        await act(async () =>
          root.render(
            <WorkspaceMessageScroller
              activeSession={{ ...session, artifacts: [{ ...artifact, isPublished: true }] }}
              onSendEditedMessage={vi.fn()}
            />
          )
        )
        expect(card()?.disabled).toBe(false)
      }
    }
  )

  it('resolves copied generated Version metadata and previews the source Version owner', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'artifact-version-1',
      projectId: 'origin-project',
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
      state: 'finalized',
      isPublished: true
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
      managedFileId: 'artifact-lineage-1',
      versionNumber: 2
    })
  })

  it('renders a child-owned Version at its restored Notebook delegate invocation without copying root ownership', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'child-version',
      projectId: 'default',
      sessionId: 'session-42',
      name: 'child.md',
      mimeType: 'text/markdown',
      size: 12,
      mtimeMs: 10,
      artifactId: 'child-artifact',
      versionId: 'child-version',
      versionNumber: 1,
      checksum: 'b'.repeat(64),
      createdAt: '2026-08-08T00:00:00.000Z',
      state: 'finalized',
      isPublished: true
    }
    window.api.artifacts.resolveVersionDescriptors = vi.fn().mockResolvedValue([descriptor])
    const session = createSession({
      id: 'session-42',
      status: 'idle',
      messages: [
        createMessage({ id: 'root-prompt', createdAt: 1, updatedAt: 1 }),
        createMessage({
          id: 'root-answer',
          role: 'agent',
          content: 'Done',
          responseToMessageId: 'root-prompt',
          createdAt: 6,
          updatedAt: 6
        })
      ]
    })
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const graph = session.conversationGraph!
    const rootBranch = graph.branches[0]
    const rootRuntime = graph.runtimeSegments[0]
    const nestedDelegateInvocationId = 'notebook-run-42-1\u0000delegate\u00001'
    const invocation = {
      id: 'provider-repl-call',
      kind: 'tool' as const,
      title: 'repl_execute',
      status: 'completed' as const,
      sortIndex: 1,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2,
      promptMessageId: 'root-prompt'
    }
    session.activities = [invocation]
    graph.activities.push({
      ...invocation,
      agentFrameId: graph.rootFrameId,
      messageBranchId: rootBranch.id,
      runtimeSegmentId: rootRuntime.id,
      promptMessageId: 'root-prompt'
    })
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'root-prompt',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 3,
      completedAt: 5
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 3,
      updatedAt: 5
    })
    graph.messages.push(
      {
        id: 'child-prompt',
        role: 'user',
        content: 'work',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: {
          rootMessageId: 'root-prompt',
          toolInvocationId: nestedDelegateInvocationId
        },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt',
        createdAt: 3,
        updatedAt: 3
      },
      {
        id: 'child-answer',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: [],
        artifactIds: ['child-version'],
        responseToMessageId: 'child-prompt',
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        parentMessageId: 'child-prompt',
        createdAt: 5,
        updatedAt: 5
      }
    )
    const rootBefore = structuredClone(graph.messages.find(({ id }) => id === 'root-prompt'))
    const answerBefore = structuredClone(graph.messages.find(({ id }) => id === 'root-answer'))

    const normalized = normalizeSessionFile(session)!
    expect(
      normalized.conversationGraph?.activities.find(({ id }) => id === nestedDelegateInvocationId)
    ).toMatchObject({
      title: 'Delegate subagent',
      promptMessageId: 'root-prompt'
    })
    const rootSession = { ...session, ...normalized } as ChatSession
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={rootSession} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    // The projected child Version renders on the root turn terminal agent message (turn-end),
    // never as an inline placement under the delegate invocation.
    expect(container.querySelector('[data-message-id^="artifact-placement-"]')).toBeNull()
    const cards = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Preview generated file child.md"]'
    )
    expect(cards).toHaveLength(1)
    const card = cards[0]
    expect(graph.messages.find(({ id }) => id === 'root-prompt')).toEqual(rootBefore)
    expect(graph.messages.find(({ id }) => id === 'root-prompt')?.artifactIds).toBeUndefined()
    expect(graph.messages.find(({ id }) => id === 'root-answer')).toEqual(answerBefore)
    expect(graph.messages.find(({ id }) => id === 'root-answer')?.artifactIds).toBeUndefined()
    await act(async () => card?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const rootInvocationPreview = upsertAndActivateItem.mock.calls.at(-1)?.[0]
    expect(rootInvocationPreview).toEqual(
      expect.objectContaining({
        artifactId: 'child-artifact',
        path: 'artifact-version:default/session-42/child-artifact/child-version'
      })
    )
    expect(rootInvocationPreview).not.toHaveProperty('selectedVersionId')

    const childGraph = structuredClone(normalized.conversationGraph)!
    childGraph.activeFrameId = 'child-frame'
    const childSession: ChatSession = {
      ...rootSession,
      conversationGraph: childGraph,
      messages: resolveActiveConversationMessages(childGraph).map((message, index) => ({
        ...projectConversationMessage(message),
        sortIndex: index + 1
      }))
    }
    upsertAndActivateItem.mockClear()
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={childSession} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const childOwnerCard = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file child.md"]'
    )
    expect(childOwnerCard).not.toBeNull()
    await act(async () => childOwnerCard?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(upsertAndActivateItem).toHaveBeenCalledWith(rootInvocationPreview)
  })

  it('hides a projected child Version while the root turn has no terminal agent message yet', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'child-version',
      projectId: 'default',
      sessionId: 'session-42',
      name: 'child.md',
      mimeType: 'text/markdown',
      size: 12,
      mtimeMs: 10,
      artifactId: 'child-artifact',
      versionId: 'child-version',
      versionNumber: 1,
      checksum: 'b'.repeat(64),
      createdAt: '2026-08-08T00:00:00.000Z',
      state: 'finalized',
      isPublished: true
    }
    window.api.artifacts.resolveVersionDescriptors = vi.fn().mockResolvedValue([descriptor])
    const session = createSession({
      id: 'session-42',
      status: 'running',
      messages: [createMessage({ id: 'root-prompt', createdAt: 1, updatedAt: 1 })]
    })
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const graph = session.conversationGraph!
    const rootBranch = graph.branches[0]
    const rootRuntime = graph.runtimeSegments[0]
    const nestedDelegateInvocationId = 'notebook-run-42-1\u0000delegate\u00001'
    const invocation = {
      id: 'provider-repl-call',
      kind: 'tool' as const,
      title: 'repl_execute',
      status: 'completed' as const,
      sortIndex: 1,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2,
      promptMessageId: 'root-prompt'
    }
    session.activities = [invocation]
    graph.activities.push({
      ...invocation,
      agentFrameId: graph.rootFrameId,
      messageBranchId: rootBranch.id,
      runtimeSegmentId: rootRuntime.id,
      promptMessageId: 'root-prompt'
    })
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'root-prompt',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 3,
      completedAt: 5
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 3,
      updatedAt: 5
    })
    graph.messages.push(
      {
        id: 'child-prompt',
        role: 'user',
        content: 'work',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: {
          rootMessageId: 'root-prompt',
          toolInvocationId: nestedDelegateInvocationId
        },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt',
        createdAt: 3,
        updatedAt: 3
      },
      {
        id: 'child-answer',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: [],
        artifactIds: ['child-version'],
        responseToMessageId: 'child-prompt',
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        parentMessageId: 'child-prompt',
        createdAt: 5,
        updatedAt: 5
      }
    )
    const normalized = normalizeSessionFile(session)!
    const rootSession = { ...session, ...normalized } as ChatSession
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={rootSession} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    // The root turn has not produced a terminal agent message yet, so the projected child Version
    // stays hidden instead of rendering inline under the delegate invocation.
    expect(container.querySelector('[aria-label="Preview generated file child.md"]')).toBeNull()
    expect(container.querySelector('[data-message-id^="artifact-placement-"]')).toBeNull()
  })

  it('renders a projected child Version only on the terminal fragment of a multi-fragment root turn', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'child-version',
      projectId: 'default',
      sessionId: 'session-42',
      name: 'child.md',
      mimeType: 'text/markdown',
      size: 12,
      mtimeMs: 10,
      artifactId: 'child-artifact',
      versionId: 'child-version',
      versionNumber: 1,
      checksum: 'b'.repeat(64),
      createdAt: '2026-08-08T00:00:00.000Z',
      state: 'finalized',
      isPublished: true
    }
    window.api.artifacts.resolveVersionDescriptors = vi.fn().mockResolvedValue([descriptor])
    const session = createSession({
      id: 'session-42',
      status: 'idle',
      messages: [
        createMessage({ id: 'root-prompt', createdAt: 1, updatedAt: 1 }),
        createMessage({
          id: 'root-answer-1',
          role: 'agent',
          content: 'First fragment',
          responseToMessageId: 'root-prompt',
          createdAt: 4,
          updatedAt: 4
        }),
        createMessage({
          id: 'root-answer-2',
          role: 'agent',
          content: 'Final fragment',
          responseToMessageId: 'root-prompt',
          createdAt: 8,
          updatedAt: 8
        })
      ]
    })
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const graph = session.conversationGraph!
    const rootBranch = graph.branches[0]
    const rootRuntime = graph.runtimeSegments[0]
    const nestedDelegateInvocationId = 'notebook-run-42-1\u0000delegate\u00001'
    const invocation = {
      id: 'provider-repl-call',
      kind: 'tool' as const,
      title: 'repl_execute',
      status: 'completed' as const,
      sortIndex: 1,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2,
      promptMessageId: 'root-prompt'
    }
    session.activities = [invocation]
    graph.activities.push({
      ...invocation,
      agentFrameId: graph.rootFrameId,
      messageBranchId: rootBranch.id,
      runtimeSegmentId: rootRuntime.id,
      promptMessageId: 'root-prompt'
    })
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'root-prompt',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 3,
      completedAt: 5
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 3,
      updatedAt: 5
    })
    graph.messages.push(
      {
        id: 'child-prompt',
        role: 'user',
        content: 'work',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: {
          rootMessageId: 'root-prompt',
          toolInvocationId: nestedDelegateInvocationId
        },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt',
        createdAt: 3,
        updatedAt: 3
      },
      {
        id: 'child-answer',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: [],
        artifactIds: ['child-version'],
        responseToMessageId: 'child-prompt',
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        parentMessageId: 'child-prompt',
        createdAt: 5,
        updatedAt: 5
      }
    )
    const normalized = normalizeSessionFile(session)!
    const rootSession = { ...session, ...normalized } as ChatSession
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={rootSession} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    // The projected child Version renders once, on the terminal root fragment only.
    const cards = container.querySelectorAll('[aria-label="Preview generated file child.md"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(
      'root-answer-2'
    )
  })

  it('aggregates projected child Versions from parallel delegates onto the terminal root message', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptorA: ArtifactVersionDescriptor = {
      id: 'version-1',
      projectId: 'default',
      sessionId: 'session-42',
      name: 'child-1.md',
      mimeType: 'text/markdown',
      size: 12,
      mtimeMs: 10,
      artifactId: 'child-artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-08T00:00:00.000Z',
      state: 'finalized',
      isPublished: true
    }
    const descriptorB: ArtifactVersionDescriptor = {
      ...descriptorA,
      id: 'version-2',
      name: 'child-2.md',
      artifactId: 'child-artifact-2',
      versionId: 'version-2',
      checksum: 'b'.repeat(64)
    }
    window.api.artifacts.resolveVersionDescriptors = vi
      .fn()
      .mockResolvedValue([descriptorA, descriptorB])
    const session = createSession({
      id: 'session-42',
      status: 'idle',
      messages: [
        createMessage({ id: 'root-prompt', createdAt: 1, updatedAt: 1 }),
        createMessage({
          id: 'root-answer',
          role: 'agent',
          content: 'Done',
          responseToMessageId: 'root-prompt',
          createdAt: 9,
          updatedAt: 9
        })
      ]
    })
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const graph = session.conversationGraph!
    const rootBranch = graph.branches[0]
    const rootRuntime = graph.runtimeSegments[0]
    const invocations = [
      {
        id: 'invoke-1',
        kind: 'tool' as const,
        title: 'repl_execute',
        status: 'completed' as const,
        sortIndex: 1,
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        promptMessageId: 'root-prompt'
      },
      {
        id: 'invoke-2',
        kind: 'tool' as const,
        title: 'repl_execute',
        status: 'completed' as const,
        sortIndex: 2,
        eventIds: [],
        createdAt: 5,
        updatedAt: 5,
        promptMessageId: 'root-prompt'
      }
    ]
    session.activities = invocations
    for (const activity of invocations) {
      graph.activities.push({
        ...activity,
        agentFrameId: graph.rootFrameId,
        messageBranchId: rootBranch.id,
        runtimeSegmentId: rootRuntime.id,
        promptMessageId: 'root-prompt'
      })
    }
    const delegates = [
      {
        invocationId: 'invoke-1',
        frameId: 'child-frame-1',
        branchId: 'child-branch-1',
        promptId: 'child-prompt-1',
        answerId: 'child-answer-1',
        artifactIds: ['version-1', 'version-1'],
        startedAt: 3,
        completedAt: 4
      },
      {
        invocationId: 'invoke-2',
        frameId: 'child-frame-2',
        branchId: 'child-branch-2',
        promptId: 'child-prompt-2',
        answerId: 'child-answer-2',
        artifactIds: ['version-2'],
        startedAt: 6,
        completedAt: 7
      }
    ]
    for (const delegate of delegates) {
      graph.frames.push({
        id: delegate.frameId,
        parentFrameId: graph.rootFrameId,
        originMessageId: 'root-prompt',
        originBindingState: 'validated',
        kind: 'delegate',
        status: 'completed',
        activeBranchId: delegate.branchId,
        createdAt: delegate.startedAt,
        completedAt: delegate.completedAt
      })
      graph.branches.push({
        id: delegate.branchId,
        agentFrameId: delegate.frameId,
        headMessageId: delegate.answerId,
        createdAt: delegate.startedAt,
        updatedAt: delegate.completedAt
      })
      graph.messages.push(
        {
          id: delegate.promptId,
          role: 'user',
          content: 'work',
          status: 'complete',
          eventIds: [],
          delegatedCallerSource: {
            rootMessageId: 'root-prompt',
            toolInvocationId: delegate.invocationId
          },
          agentFrameId: delegate.frameId,
          introducedOnBranchId: delegate.branchId,
          revisionRootMessageId: delegate.promptId,
          createdAt: delegate.startedAt,
          updatedAt: delegate.startedAt
        },
        {
          id: delegate.answerId,
          role: 'agent',
          content: 'done',
          status: 'complete',
          eventIds: [],
          artifactIds: delegate.artifactIds,
          responseToMessageId: delegate.promptId,
          agentFrameId: delegate.frameId,
          introducedOnBranchId: delegate.branchId,
          parentMessageId: delegate.promptId,
          createdAt: delegate.completedAt,
          updatedAt: delegate.completedAt
        }
      )
    }
    const normalized = normalizeSessionFile(session)!
    const rootSession = { ...session, ...normalized } as ChatSession
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={rootSession} onSendEditedMessage={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    // Both parallel delegates aggregate onto the terminal root message, with exact duplicate
    // Versions deduplicated.
    expect(container.querySelector('[data-message-id^="artifact-placement-"]')).toBeNull()
    expect(
      container.querySelectorAll('[aria-label="Preview generated file child-1.md"]')
    ).toHaveLength(1)
    expect(
      container.querySelectorAll('[aria-label="Preview generated file child-2.md"]')
    ).toHaveLength(1)
  })

  it('shows a resolved copied generated card after the active Session updates during lookup', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const descriptor: ArtifactVersionDescriptor = {
      id: 'artifact-version-1',
      projectId: 'origin-project',
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
      state: 'finalized',
      isPublished: true
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
      projectId: 'origin-project',
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
      state: 'finalized',
      isPublished: true
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
      projectId: 'origin-project',
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
      state: 'finalized',
      isPublished: true
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

    // The find bar is an Electron overlay owned by main; the Workspace announces that its transcript
    // is mounted and searchable so main intercepts Cmd/Ctrl+F.
    expect(announceWindowFindReady).toHaveBeenCalledTimes(1)
  })

  it('reveals scrolling to the first message on upward scroll, then hides it after inactivity', async () => {
    vi.useFakeTimers()
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const messages = [
      createMessage({ id: 'prompt-1' }),
      createMessage({ id: 'reply-1', role: 'agent' }),
      createMessage({ id: 'prompt-2' }),
      createMessage({ id: 'reply-2', role: 'agent' })
    ]
    const render = async (
      status: ChatSession['status'],
      sessionMessages: ChatMessage[] = messages,
      overrides: Partial<ChatSession> = {}
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller
            activeSession={createSession({ status, messages: sessionMessages, ...overrides })}
            onSendEditedMessage={vi.fn()}
          />
        )
      })
    }
    const scrollTo = async (
      scrollTop: number,
      { clientHeight = 400, scrollHeight = 1000 } = {}
    ): Promise<void> => {
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="message-scroller-viewport"]'
      )
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: clientHeight },
        scrollHeight: { configurable: true, value: scrollHeight },
        scrollTop: { configurable: true, writable: true, value: scrollTop }
      })
      await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    }

    root = createRoot(container)
    await render('idle')
    await scrollTo(0, { clientHeight: 400, scrollHeight: 400 })
    expect(container.querySelector('[aria-label="Scroll to first message"]')).toBeNull()

    await scrollTo(59)
    expect(container.querySelector('[aria-label="Scroll to first message"]')).toBeNull()

    await scrollTo(60)
    const firstMessageButton = container.querySelector('[aria-label="Scroll to first message"]')
    const lastMessageButton = container.querySelector('[data-direction="end"]')
    expect(firstMessageButton).not.toBeNull()
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('false')
    expect(firstMessageButton?.getAttribute('aria-hidden')).toBe('true')
    expect(firstMessageButton?.getAttribute('tabindex')).toBe('-1')
    expect(firstMessageButton?.classList.contains('gap-1')).toBe(true)
    expect(firstMessageButton?.classList.contains('px-3')).toBe(true)
    expect(firstMessageButton?.classList.contains('min-h-11')).toBe(false)
    expect(lastMessageButton).not.toBeNull()
    expect(lastMessageButton?.getAttribute('data-size')).toBe('icon-lg')
    expect(lastMessageButton?.classList.contains('rounded-full')).toBe(true)
    for (const button of [firstMessageButton, lastMessageButton]) {
      expect(button?.classList.contains('border-transparent')).toBe(true)
      expect(button?.classList.contains('shadow-card')).toBe(true)
      expect(button?.classList.contains('border-border-200')).toBe(false)
    }

    await scrollTo(1200, { clientHeight: 400, scrollHeight: 10_000 })
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('false')

    await scrollTo(1199, { clientHeight: 400, scrollHeight: 10_000 })
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('true')
    expect(firstMessageButton?.getAttribute('aria-hidden')).toBe('false')
    expect(firstMessageButton?.getAttribute('tabindex')).toBe('0')

    await act(async () => vi.advanceTimersByTimeAsync(2999))
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('true')
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('false')

    await scrollTo(1198, { clientHeight: 400, scrollHeight: 10_000 })
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('true')
    await scrollTo(1199, { clientHeight: 400, scrollHeight: 10_000 })
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('false')

    await scrollTo(1198, { clientHeight: 400, scrollHeight: 10_000 })
    expect(firstMessageButton?.getAttribute('data-revealed')).toBe('true')
    await render('idle', messages, { id: 'session-2' })
    expect(
      container
        .querySelector('[aria-label="Scroll to first message"]')
        ?.getAttribute('data-revealed')
    ).not.toBe('true')

    await render('idle', messages.slice(0, 2))
    await scrollTo(200, { clientHeight: 400, scrollHeight: 700 })
    expect(container.querySelector('[aria-label="Scroll to first message"]')).toBeNull()

    await scrollTo(80, { clientHeight: 400, scrollHeight: 800 })
    await scrollTo(40, { clientHeight: 400, scrollHeight: 800 })
    expect(
      container
        .querySelector('[aria-label="Scroll to first message"]')
        ?.getAttribute('data-revealed')
    ).toBe('true')

    await render('idle', messages, { compacting: true })
    await scrollTo(400)
    expect(container.querySelector('[aria-label="Scroll to first message"]')).toBeNull()

    for (const status of [
      'running',
      'waiting-for-user',
      'waiting-permission',
      'waiting-plan-approval'
    ] as const) {
      await render(status)
      await scrollTo(400)
      expect(container.querySelector('[aria-label="Scroll to first message"]')).toBeNull()
    }

    await render('error')
    await scrollTo(60)
    expect(
      container
        .querySelector('[aria-label="Scroll to first message"]')
        ?.getAttribute('data-revealed')
    ).toBe('true')
  })

  it('coalesces resize-driven scroll eligibility updates into one deferred frame', async () => {
    vi.useFakeTimers()
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe(): void {
          /* no-op */
        }
        unobserve(): void {
          /* no-op */
        }
        disconnect(): void {
          /* no-op */
        }
      }
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const messages = [
      createMessage({ id: 'prompt-1' }),
      createMessage({ id: 'reply-1', role: 'agent' }),
      createMessage({ id: 'prompt-2' }),
      createMessage({ id: 'reply-2', role: 'agent' })
    ]

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="message-scroller-viewport"]'
    )
    let scrollHeightReads = 0
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: {
        configurable: true,
        get: () => {
          scrollHeightReads += 1
          return 10_000
        }
      },
      scrollTop: { configurable: true, writable: true, value: 1_200 }
    })
    const notifyResize = async (): Promise<void> => {
      await act(async () => {
        for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
      })
    }

    // Streaming resizes the content every frame; several notifications inside one frame must not
    // trigger synchronous layout reads — they collapse into a single rAF-deferred evaluation.
    scrollHeightReads = 0
    await notifyResize()
    await notifyResize()
    await notifyResize()
    expect(scrollHeightReads).toBe(0)
    expect(container.querySelector('[aria-label="Scroll to first message"]')).toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(container.querySelector('[aria-label="Scroll to first message"]')).not.toBeNull()
    expect(scrollHeightReads).toBeLessThan(3)
  })

  it('cancels a pending resize-driven eligibility update on unmount', async () => {
    vi.useFakeTimers()
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback)
        }
        observe(): void {
          /* no-op */
        }
        unobserve(): void {
          /* no-op */
        }
        disconnect(): void {
          /* no-op */
        }
      }
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
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

    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="message-scroller-viewport"]'
    )
    let scrollHeightReads = 0
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: {
        configurable: true,
        get: () => {
          scrollHeightReads += 1
          return 10_000
        }
      }
    })
    await act(async () => {
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
    })

    await act(async () => {
      root.unmount()
    })
    await act(async () => vi.advanceTimersByTimeAsync(64))
    expect(scrollHeightReads).toBe(0)
    root = createRoot(container)
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
      managedFileId: 'upload-1',
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
              id: 'upload:upload-file-1',
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
    const previewItem = upsertAndActivateItem.mock.calls[0]?.[0]
    expect(previewItem).toEqual(
      expect.objectContaining({
        id: 'upload:upload-file-1',
        managedFileId: 'upload-file-1',
        projectId: 'project-1',
        sessionId: 'source-session'
      })
    )
    expect(previewItem).not.toHaveProperty('selectedVersionId')
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
    const mentionLiveRegion = container.querySelector('[data-testid="mention-notice-live-region"]')
    expect(mentionLiveRegion).not.toBeNull()
    expect(mentionLiveRegion?.getAttribute('role')).toBeNull()
    expect(mentionLiveRegion?.getAttribute('aria-live')).toBe('assertive')
    expect(mentionLiveRegion?.getAttribute('aria-atomic')).toBe('true')
    expect(mentionLiveRegion?.textContent).toBe('')
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
    expect(
      container.querySelector('[data-testid="mention-notice-live-region"]')?.textContent
    ).toContain('Linked-folder files are not available until the folder is connected.')
  })

  it('does not read a generated text thumbnail until its card approaches the viewport', async () => {
    const enterViewport = installIntersectionObserver()
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
          artifactId: 'managed-artifact-1',
          versionId: 'artifact-version-1',
          isPublished: true,
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
      enterViewport()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith({
      path: '/workspace/report.txt',
      projectId: 'default',
      sessionId: 'session-1',
      fileId: 'managed-artifact-1',
      versionId: 'artifact-version-1',
      maxBytes: 1,
      encoding: 'base64'
    })
    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith({
      path: '/workspace/report.txt',
      projectId: 'default',
      sessionId: 'session-1',
      fileId: 'managed-artifact-1',
      versionId: 'artifact-version-1',
      maxBytes: 32 * 1024,
      encoding: 'utf8'
    })
  })

  it('does not fall back to a path-only thumbnail read for a legacy artifact', async () => {
    const enterViewport = installIntersectionObserver()
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
          path: '/workspace/legacy-report.txt',
          name: 'legacy-report.txt',
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

    await act(async () => {
      enterViewport()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
  })

  it.each(['/workspace/.pending/run-1/report.txt', 'C:\\workspace\\.pending\\run-1\\report.txt'])(
    'keeps an unpublished managed thumbnail quiet while finalization is pending (%s)',
    async (path) => {
      const enterViewport = installIntersectionObserver()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      window.api.artifacts.readPreview = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'artifacts:read-preview': ManagedFileVersionError: Managed file has no published version."
          )
        )
      const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
      const session = createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Created the file',
            artifactIds: ['artifact-version-1']
          })
        ],
        artifacts: [
          {
            id: 'artifact-version-1',
            artifactId: 'managed-artifact-1',
            versionId: 'artifact-version-1',
            kind: 'managed-file',
            path,
            name: 'report.txt',
            mimeType: 'text/plain',
            size: 2048,
            mtimeMs: 1710000000100
          }
        ]
      })

      try {
        root = createRoot(container)
        await act(async () => {
          root.render(
            <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
          )
        })

        expect(
          container.querySelector<HTMLButtonElement>(
            'button[aria-label="Preview generated file report.txt"]'
          )?.disabled
        ).toBe(true)

        await act(async () => {
          enterViewport()
          await Promise.resolve()
          await Promise.resolve()
        })

        expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
        expect(consoleError).not.toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    }
  )

  it('does not acquire a PDF thumbnail while artifact publication is pending', async () => {
    const enterViewport = installIntersectionObserver()
    window.api.previewResources.acquire = vi.fn(
      () => new Promise<ManagedPreviewResource>(() => undefined)
    )
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      status: 'idle',
      messages: [
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Created the file',
          artifactIds: ['artifact-version-1']
        })
      ],
      artifacts: [
        {
          id: 'artifact-version-1',
          artifactId: 'managed-artifact-1',
          versionId: 'artifact-version-1',
          kind: 'managed-file',
          path: '/workspace/.pending/run-1/report.pdf',
          name: 'report.pdf',
          mimeType: 'application/pdf',
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

    await act(async () => {
      enterViewport()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
  })

  it('keeps a published artifact named .pending previewable', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      status: 'idle',
      messages: [
        createMessage({
          id: 'reply-1',
          role: 'agent',
          content: 'Created the file',
          artifactIds: ['artifact-version-1']
        })
      ],
      artifacts: [
        {
          id: 'artifact-version-1',
          artifactId: 'managed-artifact-1',
          versionId: 'artifact-version-1',
          isPublished: true,
          kind: 'managed-file',
          path: '/workspace/message-1/.pending',
          name: '.pending',
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

    const card = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview generated file .pending"]'
    )
    expect(card?.disabled).toBe(false)

    await act(async () => card?.click())
    expect(upsertAndActivateItem).toHaveBeenCalledWith(
      expect.objectContaining({ managedFileId: 'managed-artifact-1', name: '.pending' })
    )
  })

  it('mounts desktop Run Marks from visible human prompts', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const session = createSession({
      status: 'running',
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

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller activeSession={session} onSendEditedMessage={vi.fn()} />
      )
    })

    const rail = document.body.querySelector<HTMLElement>('nav[aria-label="Run marks"]')
    expect(rail).not.toBeNull()
    expect(rail?.className).toContain('hidden')
    expect(rail?.className).toContain('md:block')
    expect(rail?.querySelectorAll('button')).toHaveLength(2)
    expect(
      Array.from(rail?.querySelectorAll('button span') ?? []).every((indicator) =>
        indicator.classList.contains('scale-x-[0.4]')
      )
    ).toBe(true)
  })

  it('mounts a bounded long transcript and reveals an older run on demand', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const messages = Array.from({ length: 240 }, (_, index) =>
      createMessage({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'agent',
        content:
          index === 0
            ? 'oldest transcript sentinel'
            : index === 239
              ? 'newest transcript sentinel'
              : `transcript message ${index + 1}`,
        responseToMessageId: index % 2 === 0 ? undefined : `message-${index}`,
        createdAt: 1710000000000 + index,
        updatedAt: 1710000000000 + index
      })
    )

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('newest transcript sentinel')
    expect(container.textContent).not.toContain('oldest transcript sentinel')
    expect(agentMarkdownRenderMock.mock.calls.length).toBeLessThan(80)

    await act(async () => showWindowFindListener?.())
    await act(async () => hideWindowFindListener?.())
    expect(container.textContent).not.toContain('oldest transcript sentinel')

    const appendedMessages = [
      ...messages,
      ...Array.from({ length: 80 }, (_, offset) => {
        const index = messages.length + offset
        return createMessage({
          id: `message-${index + 1}`,
          role: index % 2 === 0 ? 'user' : 'agent',
          content:
            index === 319
              ? 'newest appended transcript sentinel'
              : `transcript message ${index + 1}`,
          responseToMessageId: index % 2 === 0 ? undefined : `message-${index}`,
          createdAt: 1710000000000 + index,
          updatedAt: 1710000000000 + index
        })
      })
    ]
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages: appendedMessages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain('newest appended transcript sentinel')
    expect(container.textContent).not.toContain('transcript message 161')

    const firstRun = document.body.querySelector<HTMLButtonElement>('[aria-label^="Go to run 1:"]')
    expect(firstRun).not.toBeNull()
    await act(async () => firstRun?.click())

    expect(container.textContent).toContain('oldest transcript sentinel')
  })

  it('binds a long session job feed without repeatedly scanning every activity', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const itemCount = 120
    let rawOutputReads = 0
    const activities = Array.from({ length: itemCount }, (_, index) => {
      const activity = createActivity({
        id: `job-activity-${index}`,
        status: 'completed',
        sortIndex: index,
        createdAt: 1710000000000 + index,
        updatedAt: 1710000000000 + index
      })
      Object.defineProperty(activity, 'rawOutput', {
        enumerable: true,
        get: () => {
          rawOutputReads += 1
          return { result: JSON.stringify({ job_id: `job-${index}` }) }
        }
      })
      return activity
    })
    const jobs = Array.from({ length: itemCount }, (_, index): JobSummary => ({
      job_id: `job-${index}`,
      provider_id: 'ssh:test',
      display_name: 'Test host',
      shape: 'direct_ssh',
      session_id: 'session-1',
      status: 'success',
      intent: `Job ${index}`,
      created_at: 1710000000000 + index,
      started_at: 1710000000000 + index,
      finished_at: 1710000001000 + index,
      exit_code: 0,
      error_code: undefined,
      remote_workdir: '/workspace',
      stdout_tail: undefined,
      stderr_tail: undefined,
      notified_at: undefined,
      notification_consumed_at: undefined
    }))
    useSessionJobStore.setState({
      jobsById: new Map(jobs.map((job) => [job.job_id, job])),
      hydratedSessionId: 'session-1',
      isLoaded: true
    })

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', activities })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(rawOutputReads).toBeLessThanOrEqual(itemCount * 8)
  })

  it('renders a long conversation graph without rescanning it for every visible revision', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const itemCount = 240
    const messages = Array.from({ length: itemCount }, (_, index) =>
      createMessage({
        id: `graph-message-${index}`,
        role: index % 2 === 0 ? 'user' : 'agent',
        content: `Graph message ${index}`,
        responseToMessageId: index % 2 === 0 ? undefined : `graph-message-${index - 1}`,
        sortIndex: index,
        createdAt: 1710000000000 + index,
        updatedAt: 1710000000000 + index
      })
    )
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages,
      frameworkId: 'codex',
      createdAt: 1710000000000,
      updatedAt: 1710000000000 + itemCount
    })
    let graphRoleReads = 0
    for (const message of conversationGraph.messages) {
      const role = message.role
      Object.defineProperty(message, 'role', {
        enumerable: true,
        get: () => {
          graphRoleReads += 1
          return role
        }
      })
    }

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', conversationGraph, messages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(graphRoleReads).toBeLessThanOrEqual(itemCount * 4)
  })

  it('prefetches older transcript items before upward scrolling reaches the top edge', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const messages = Array.from({ length: 240 }, (_, index) =>
      createMessage({
        id: `prefetch-message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'agent',
        content:
          index === 159 ? 'prefetched transcript sentinel' : `prefetch transcript ${index + 1}`,
        responseToMessageId: index % 2 === 0 ? undefined : `prefetch-message-${index}`,
        createdAt: 1710000000000 + index,
        updatedAt: 1710000000000 + index
      })
    )

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(container.textContent).not.toContain('prefetched transcript sentinel')
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="message-scroller-viewport"]'
    )
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 10_000 },
      scrollTop: { configurable: true, writable: true, value: 900 }
    })
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))

    if (viewport) viewport.scrollTop = 700
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))

    expect(container.textContent).toContain('prefetched transcript sentinel')
  })

  it('reveals the full transcript only while whole-window find is open', async () => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const messages = Array.from({ length: 120 }, (_, index) =>
      createMessage({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'agent',
        content: index === 0 ? 'searchable oldest sentinel' : `transcript message ${index + 1}`,
        responseToMessageId: index % 2 === 0 ? undefined : `message-${index}`,
        createdAt: 1710000000000 + index,
        updatedAt: 1710000000000 + index
      })
    )

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'idle', messages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })

    expect(container.textContent).not.toContain('searchable oldest sentinel')
    await act(async () => showWindowFindListener?.())
    expect(container.textContent).toContain('searchable oldest sentinel')
    expect(announceWindowFindContentReady).toHaveBeenCalledTimes(1)

    const streamedMessages = [
      ...messages,
      createMessage({
        id: 'message-121',
        role: 'agent',
        content: 'streamed searchable update',
        responseToMessageId: 'message-119',
        createdAt: 1710000000120,
        updatedAt: 1710000000120
      })
    ]
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({ status: 'running', messages: streamedMessages })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain('streamed searchable update')
    expect(announceWindowFindContentReady).toHaveBeenCalledTimes(1)

    const nextSessionMessages = messages.map((message, index) => ({
      ...message,
      id: `next-${message.id}`,
      content: index === 0 ? 'next session oldest sentinel' : message.content
    }))
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={createSession({
            id: 'session-2',
            status: 'idle',
            messages: nextSessionMessages
          })}
          onSendEditedMessage={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain('next session oldest sentinel')
    expect(announceWindowFindContentReady).toHaveBeenCalledTimes(2)

    await act(async () => hideWindowFindListener?.())
    expect(container.textContent).not.toContain('next session oldest sentinel')
    expect(container.textContent).toContain('transcript message 120')
  }, 30_000)

  it('waits for the presentation barrier to clear before announcing find readiness', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    const history = Array.from({ length: 120 }, (_, index) =>
      createMessage({
        id: `history-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'agent',
        content:
          index === 0
            ? 'presentation history oldest sentinel'
            : `presentation history ${index + 1}`,
        responseToMessageId: index % 2 === 0 ? undefined : `history-${index}`,
        createdAt: index
      })
    )
    const prompt = createMessage({ id: 'prompt-find-barrier', createdAt: 120 })
    const streamingAnswer = createMessage({
      id: 'answer-find-barrier',
      role: 'agent',
      content: 'Hold find readiness until this presentation finishes.',
      status: 'streaming',
      streamId: 'stream-find-barrier',
      responseToMessageId: prompt.id,
      createdAt: 121
    })
    const bufferedPrompt = createMessage({ id: 'prompt-behind-find-barrier', createdAt: 122 })
    const bufferedAnswer = createMessage({
      id: 'answer-behind-find-barrier',
      role: 'agent',
      content: 'Searchable only after the presentation barrier clears.',
      responseToMessageId: bufferedPrompt.id,
      createdAt: 123
    })
    const render = async (messages: ChatMessage[]): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageScroller
            activeSession={createSession({
              messages,
              activeRun: { promptMessageId: prompt.id, startedAt: 120 }
            })}
            onSendEditedMessage={vi.fn()}
          />
        )
      })
    }

    root = createRoot(container)
    await render(history)
    await render([...history, prompt])
    await render([...history, prompt, streamingAnswer])
    await render([...history, prompt, streamingAnswer, bufferedPrompt, bufferedAnswer])

    expect(container.textContent).not.toContain('presentation history oldest sentinel')
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="message-scroller-viewport"]'
    )
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 10_000 },
      scrollTop: { configurable: true, writable: true, value: 900 }
    })
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    if (viewport) viewport.scrollTop = 700
    await act(async () => viewport?.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(container.textContent).not.toContain('presentation history oldest sentinel')

    const oldestRun = document.body.querySelector<HTMLButtonElement>('[aria-label^="Go to run 1:"]')
    expect(oldestRun).not.toBeNull()
    expect(oldestRun?.disabled).toBe(true)
    await act(async () => showWindowFindListener?.())
    expect(container.textContent).not.toContain('Searchable only after the presentation barrier')
    expect(announceWindowFindContentReady).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(container.textContent).toContain('presentation history oldest sentinel')
    expect(container.textContent).toContain('Searchable only after the presentation barrier')
    expect(oldestRun?.disabled).toBe(false)
    expect(announceWindowFindContentReady).toHaveBeenCalledTimes(1)
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
