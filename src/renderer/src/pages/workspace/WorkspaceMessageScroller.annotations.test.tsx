// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import { installCssHighlightsMock, type TestHighlightRegistry } from '@/test-utils/css-highlights'
import type { AnnotationValidationError, TextAnnotation } from '../../../../shared/annotations'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendEditedMessage } from './workspace-edited-message'
import { requestAnnotationReveal } from './annotations/annotation-reveal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// pdfjs-dist references DOMMatrix at module load, which jsdom does not provide. This suite
// exercises annotation prop flow, not PDF rendering, so stub the library to keep the import
// graph loadable.
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

const { flushSessionPersistenceMock } = vi.hoisted(() => ({
  flushSessionPersistenceMock: vi.fn(async (): Promise<void> => undefined)
}))

vi.mock('@/lib/session-persistence/session-persistence', () => ({
  flushSessionPersistence: flushSessionPersistenceMock
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('./SessionMessageMarkdown', () => ({
  SessionMessageMarkdown: ({ content }: { content: string }) => (
    <div data-testid="presented-agent-markdown">{content}</div>
  )
}))

vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>
  const Item = ({
    children,
    messageId
  }: PropsWithChildren<{ messageId?: string }>): React.JSX.Element => (
    <div data-slot="message-scroller-item" data-message-id={messageId}>
      {children}
    </div>
  )
  const Button = (): React.JSX.Element => <button type="button">Scroll to end</button>

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

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ upsertAndActivateItem: vi.fn(), openFileDialog: vi.fn() })
  },
  createSessionPlanPreviewItem: vi.fn(),
  createSessionSubagentsPreviewItem: vi.fn()
}))

let highlights: TestHighlightRegistry

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
  status: 'completed',
  eventIds: ['event-1'],
  sortIndex: 1,
  createdAt: 1710000000001,
  updatedAt: 1710000000001,
  ...overrides
})

const replySession = (): ChatSession => {
  const prompt = createMessage({ id: 'prompt-1', content: 'Summarize', sortIndex: 1 })
  const reply = createMessage({
    id: 'reply-1',
    role: 'agent',
    content: 'agent reply body with quotable words',
    responseToMessageId: 'prompt-1',
    sortIndex: 2
  })
  return createSession({ status: 'idle', messages: [prompt, reply] })
}

const draftHighlightRanges = (): Range[] =>
  Array.from(highlights.get('agent-annotation-draft') ?? [])

// The composer owns the annotation draft: every parent re-render rebuilds the callback props
// (inline closures in ConversationPanel) while session identity stays stable, and the transcript
// must still follow annotations changes — the highlight on the quoted text depends on it.
describe('WorkspaceMessageScroller annotation prop sync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    highlights = installCssHighlightsMock()
    container = document.createElement('div')
    document.body.appendChild(container)
    Element.prototype.scrollIntoView = vi.fn()
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    container.remove()
  })

  const renderScroller = async ({
    session,
    annotations = [],
    onAddAnnotation = vi.fn(() => undefined),
    onSendEditedMessage = vi.fn<SendEditedMessage>(() => ({ ok: true, disposition: 'sent' }))
  }: {
    session: ChatSession
    annotations?: readonly TextAnnotation[]
    onAddAnnotation?: (annotation: TextAnnotation) => AnnotationValidationError | undefined
    onSendEditedMessage?: SendEditedMessage
  }): Promise<void> => {
    const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')
    await act(async () => {
      root.render(
        <WorkspaceMessageScroller
          activeSession={session}
          annotations={annotations}
          onAddAnnotation={onAddAnnotation}
          onAnnotationError={vi.fn()}
          onSendEditedMessage={onSendEditedMessage}
        />
      )
    })
  }

  const selectAndAnnotate = async (
    surface: HTMLElement,
    selectionTarget: Node = surface
  ): Promise<void> => {
    const range = document.createRange()
    range.selectNodeContents(selectionTarget)
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: 10,
          right: 180,
          top: 20,
          bottom: 40,
          width: 170,
          height: 20,
          x: 10,
          y: 20,
          toJSON: () => ({})
        }) as DOMRect
    })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => surface.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))

    const trigger = document.querySelector<HTMLButtonElement>('[data-annotation-trigger]')
    expect(trigger).not.toBeNull()
    await act(async () => trigger?.click())
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter((button) => button.textContent === 'Annotate')
      .at(-1)
    await act(async () => confirm?.click())
  }

  it('syncs the message badge and highlight as draft annotations are added and removed', async () => {
    const session = replySession()
    const onSendEditedMessage = vi.fn<SendEditedMessage>(() => ({ ok: true, disposition: 'sent' }))
    await renderScroller({ session, onSendEditedMessage })
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()

    const annotation: TextAnnotation = {
      id: 'annotation-1',
      kind: 'text',
      target: 'agent',
      quote: 'quotable words',
      source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'reply-1' }
    }
    await renderScroller({ session, annotations: [annotation], onSendEditedMessage })
    expect(container.querySelector('[data-annotation-active="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Annotated for Agent')
    expect(draftHighlightRanges().map((range) => range.toString())).toContain('quotable words')

    await renderScroller({ session, onSendEditedMessage })
    expect(container.querySelector('[data-annotation-active="true"]')).toBeNull()
    expect(draftHighlightRanges()).toHaveLength(0)
  })

  it('annotates and restores independent Tool and Notebook transcript sections', async () => {
    const shellActivity = createActivity({
      id: 'shell-run-1',
      title: 'Run analysis command',
      providerToolName: 'Bash',
      toolKind: 'execute',
      rawInput: { command: 'printf shell-command' },
      terminalOutput: 'shell-output'
    })
    const notebookActivity = createActivity({
      id: 'notebook-run-1',
      title: 'Run notebook cell',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      rawInput: { code: 'print("notebook-code")' },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              runId: 'run-1',
              status: 'completed',
              script: 'print("notebook-code")',
              text: {
                stdout: 'notebook-output',
                stderr: '',
                traceback: '',
                plain: []
              },
              outputs: []
            })
          }
        }
      ]
    })
    const session = createSession({
      status: 'idle',
      activities: [shellActivity, notebookActivity]
    })
    const addedAnnotations: TextAnnotation[] = []
    const onAddAnnotation = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })
    const onSendEditedMessage = vi.fn<SendEditedMessage>(() => ({
      ok: true,
      disposition: 'sent'
    }))
    const render = async (annotations: readonly TextAnnotation[]): Promise<void> => {
      await renderScroller({
        session,
        annotations,
        onAddAnnotation,
        onSendEditedMessage
      })
    }

    await render([])
    const toolRows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="tool-chip"]')
    )
    expect(toolRows).toHaveLength(2)
    for (const toolRow of toolRows) await act(async () => toolRow.click())

    const codeBlocks = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="tool-code-block"] code')
    )
    const codeBlock = (text: string): HTMLElement => {
      const block = codeBlocks.find((candidate) => candidate.textContent === text)
      expect(block).toBeDefined()
      return block!
    }
    await selectAndAnnotate(codeBlock('printf shell-command'))
    await selectAndAnnotate(codeBlock('print("notebook-code")'))
    await selectAndAnnotate(codeBlock('notebook-output'))

    expect(onAddAnnotation).toHaveBeenCalledTimes(3)
    expect(addedAnnotations.map(({ quote, source }) => ({ quote, source }))).toEqual([
      {
        quote: 'printf shell-command',
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemType: 'tool-activity',
          itemId: 'shell-run-1',
          sectionId: 'command'
        }
      },
      {
        quote: 'print("notebook-code")',
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemType: 'tool-activity',
          itemId: 'notebook-run-1',
          sectionId: 'code'
        }
      },
      {
        quote: 'notebook-output',
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemType: 'tool-activity',
          itemId: 'notebook-run-1',
          sectionId: 'output'
        }
      }
    ])

    await render(addedAnnotations)
    expect(draftHighlightRanges().map((range) => range.toString())).toEqual(
      expect.arrayContaining(['printf shell-command', 'print("notebook-code")', 'notebook-output'])
    )
  })

  it('reveals a windowed Notebook annotation through its collapsed group, row, and output section', async () => {
    const target = createActivity({
      id: 'notebook-reveal-target',
      activityGroupId: 'target-group',
      title: 'Run hidden notebook cell',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      rawInput: { code: 'print("hidden")' },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              runId: 'hidden-run',
              status: 'completed',
              script: 'print("hidden")',
              text: { stdout: 'deep notebook output', stderr: '', traceback: '', plain: [] },
              outputs: []
            })
          }
        }
      ]
    })
    const fillers = Array.from({ length: 85 }, (_, index) =>
      createActivity({
        id: `filler-${index}`,
        activityGroupId: `filler-group-${index}`,
        sortIndex: index + 2,
        createdAt: 1710000000002 + index,
        updatedAt: 1710000000002 + index
      })
    )
    const annotation: TextAnnotation = {
      id: 'notebook-windowed-annotation',
      kind: 'text',
      target: 'agent',
      quote: 'deep notebook output',
      source: {
        kind: 'session-item',
        sessionId: 'session-1',
        itemType: 'tool-activity',
        itemId: target.id,
        sectionId: 'output'
      }
    }
    const onSendEditedMessage = vi.fn<SendEditedMessage>(() => ({
      ok: true,
      disposition: 'sent'
    }))
    const render = async (activities: ToolActivity[]): Promise<void> => {
      await renderScroller({
        session: createSession({ status: 'idle', activities }),
        annotations: [annotation],
        onSendEditedMessage
      })
    }

    await render([target])
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-group-header"]')?.click()
    )
    await render([target, ...fillers])
    expect(container.querySelector('[data-message-id="activity-group-target-group"]')).toBeNull()

    await act(async () => requestAnnotationReveal(annotation))

    const targetGroup = container.querySelector('[data-message-id="activity-group-target-group"]')!
    expect(
      targetGroup.querySelector('[data-testid="tool-group-header"]')?.getAttribute('aria-expanded')
    ).toBe('true')
    expect(
      targetGroup.querySelector('[data-testid="tool-chip"]')?.getAttribute('aria-expanded')
    ).toBe('true')
    expect(
      targetGroup.querySelector<HTMLDetailsElement>('[data-tool-section-id="output"]')?.open
    ).toBe(true)
    expect(
      Array.from(highlights.get('agent-annotation-reveal') ?? []).map((range) => range.toString())
    ).toContain('deep notebook output')
  })

  it('reveals and replays a windowed Plan annotation for a hidden step description', async () => {
    const plan = createActivity({
      id: 'plan-reveal-target',
      title: 'generate_plan',
      providerToolName: 'generate_plan',
      rawInput: {
        task_summary: 'Prepare all report sections',
        phases: [
          {
            name: 'Work',
            delegations: [
              {
                name: 'Writing',
                steps: Array.from({ length: 6 }, (_, index) => ({
                  title: `Plan step ${index + 1}`,
                  description:
                    index === 5
                      ? 'Reveal the deeply hidden description'
                      : `Description ${index + 1}`
                }))
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'All inputs are ready.' }
      }
    })
    const fillers = Array.from({ length: 85 }, (_, index) =>
      createActivity({
        id: `plan-filler-${index}`,
        activityGroupId: `plan-filler-group-${index}`,
        sortIndex: index + 2,
        createdAt: 1710000000002 + index,
        updatedAt: 1710000000002 + index
      })
    )
    const annotation: TextAnnotation = {
      id: 'plan-windowed-annotation',
      kind: 'text',
      target: 'agent',
      quote: 'Reveal the deeply hidden description',
      source: {
        kind: 'session-item',
        sessionId: 'session-1',
        itemType: 'plan',
        itemId: plan.id,
        sectionId: 'step:6:description'
      }
    }
    const onSendEditedMessage = vi.fn<SendEditedMessage>(() => ({
      ok: true,
      disposition: 'sent'
    }))
    await renderScroller({
      session: createSession({ status: 'idle', activities: [plan, ...fillers] }),
      annotations: [annotation],
      onSendEditedMessage
    })
    expect(
      container.querySelector('[data-message-id="plan-activity-plan-reveal-target"]')
    ).toBeNull()

    await act(async () => requestAnnotationReveal(annotation))

    const step = container.querySelector<HTMLButtonElement>(
      '[aria-controls="plan-step-plan-reveal-target-6"]'
    )!
    expect(step).not.toBeNull()
    expect(step.getAttribute('aria-expanded')).toBe('true')
    expect(
      Array.from(highlights.get('agent-annotation-reveal') ?? []).map((range) => range.toString())
    ).toContain('Reveal the deeply hidden description')

    await act(async () => step.click())
    expect(step.getAttribute('aria-expanded')).toBe('false')
    await act(async () => requestAnnotationReveal(annotation))
    expect(step.getAttribute('aria-expanded')).toBe('true')
  })

  it('annotates and reveals durable elicitation field descriptions', async () => {
    const fields = [
      {
        id: 'question_0',
        label: 'Analysis method',
        description: 'Which analysis method should the report use?',
        kind: 'single-select' as const,
        options: [
          {
            value: 'bayesian',
            label: 'Bayesian',
            description: 'Use posterior intervals and probability statements.'
          },
          { value: 'frequentist', label: 'Frequentist' }
        ]
      },
      {
        id: 'question_0_custom',
        label: 'Other',
        kind: 'text' as const
      },
      {
        id: 'question_1',
        label: 'Audience',
        description: 'Who will read the report?',
        kind: 'single-select' as const,
        options: [{ value: 'researchers', label: 'Researchers' }]
      },
      {
        id: 'question_1_custom',
        label: 'Other',
        kind: 'text' as const
      }
    ]
    const activity = createActivity({
      id: 'ask-user-1',
      title: 'AskUserQuestion',
      elicitation: {
        message: 'Choose how the report should explain uncertainty.',
        fields,
        state: 'answered',
        durable: {
          kind: 'agent-user-choice',
          requestId: 'elicitation-1'
        },
        answers: [
          { fieldId: 'question_0', value: 'bayesian' },
          { fieldId: 'question_1', value: 'researchers' }
        ]
      }
    })
    const session = createSession({ status: 'idle', activities: [activity] })
    const addedAnnotations: TextAnnotation[] = []
    const onAddAnnotation = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })
    const render = async (annotations: readonly TextAnnotation[]): Promise<void> => {
      await renderScroller({
        session,
        annotations,
        onAddAnnotation
      })
    }

    await render([])
    const answerRows = (): HTMLButtonElement[] =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-testid="elicitation-answer-row"]')
      )
    expect(answerRows()).toHaveLength(2)
    await act(async () => answerRows()[0]?.click())

    const firstQuestionDescription = Array.from(
      container.querySelectorAll<HTMLElement>('[data-annotation-surface] p')
    ).find((element) => element.textContent === 'Which analysis method should the report use?')!
    expect(firstQuestionDescription.textContent).toBe(
      'Which analysis method should the report use?'
    )
    await selectAndAnnotate(firstQuestionDescription)
    expect(addedAnnotations[0]?.source).toEqual({
      kind: 'session-item',
      sessionId: 'session-1',
      itemType: 'elicitation',
      itemId: 'ask-user-1',
      sectionId: 'field:question_0:description'
    })
    await render(addedAnnotations)
    expect(draftHighlightRanges().map((range) => range.toString())).toContain(
      'Which analysis method should the report use?'
    )

    const secondQuestionAnnotation: TextAnnotation = {
      id: 'second-question-annotation',
      kind: 'text',
      target: 'agent',
      quote: 'Who will read the report?',
      source: {
        kind: 'session-item',
        sessionId: 'session-1',
        itemType: 'elicitation',
        itemId: activity.id,
        sectionId: 'field:question_1:description'
      }
    }
    await render([...addedAnnotations, secondQuestionAnnotation])
    expect(answerRows()[1]?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => requestAnnotationReveal(secondQuestionAnnotation))
    expect(answerRows()[1]?.getAttribute('aria-expanded')).toBe('true')
    expect(
      Array.from(highlights.get('agent-annotation-reveal') ?? []).map((range) => range.toString())
    ).toContain('Who will read the report?')
  })

  it('reveals a windowed elicitation without accepting a request from another session', async () => {
    const activity = createActivity({
      id: 'windowed-question',
      activityGroupId: undefined,
      elicitation: {
        message: 'Windowed question prompt',
        fields: [],
        state: 'answered',
        durable: { kind: 'agent-user-choice', requestId: 'windowed-question-request' },
        answers: []
      }
    })
    const fillers = Array.from({ length: 85 }, (_, index) =>
      createActivity({
        id: `question-filler-${index}`,
        activityGroupId: `question-filler-group-${index}`,
        sortIndex: index + 2,
        createdAt: 1710000000002 + index,
        updatedAt: 1710000000002 + index
      })
    )
    const annotation: TextAnnotation = {
      id: 'windowed-question-annotation',
      kind: 'text',
      target: 'agent',
      quote: 'Windowed question prompt',
      source: {
        kind: 'session-item',
        sessionId: 'session-1',
        itemType: 'elicitation',
        itemId: activity.id,
        sectionId: 'prompt'
      }
    }
    await renderScroller({
      session: createSession({ status: 'idle', activities: [activity, ...fillers] }),
      annotations: [annotation]
    })
    expect(container.querySelector('[data-message-id="activity-windowed-question"]')).toBeNull()

    await act(async () =>
      requestAnnotationReveal({
        ...annotation,
        source: { ...annotation.source, sessionId: 'another-session' }
      })
    )
    expect(container.querySelector('[data-message-id="activity-windowed-question"]')).toBeNull()

    await act(async () => requestAnnotationReveal(annotation))
    expect(container.querySelector('[data-message-id="activity-windowed-question"]')).not.toBeNull()
    expect(
      Array.from(highlights.get('agent-annotation-reveal') ?? []).map((range) => range.toString())
    ).toContain('Windowed question prompt')
  })

  it('annotates and restores only the durable Subagent message body', async () => {
    const rootPrompt = createMessage({
      id: 'root-prompt',
      content: 'Gather evidence',
      createdAt: 100,
      updatedAt: 100
    })
    const session = createSession({ status: 'idle', messages: [rootPrompt] })
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
            messageId: 'durable-upward-message',
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

    const addedAnnotations: TextAnnotation[] = []
    const onAddAnnotation = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })
    const render = async (annotations: readonly TextAnnotation[]): Promise<void> => {
      await renderScroller({
        session,
        annotations,
        onAddAnnotation
      })
    }

    await render([])
    const body = container.querySelector<HTMLElement>('[data-testid="subagent-message-body"]')!
    const heading = container.querySelector<HTMLElement>('h3')!
    const sourceButton = container.querySelector<HTMLElement>(
      '[aria-label="Open Subagent preview for Evidence mapper"]'
    )!
    expect(body.closest('[data-annotation-surface]')).not.toBeNull()
    expect(heading.closest('[data-annotation-surface]')).toBeNull()
    expect(sourceButton.closest('[data-annotation-surface]')).toBeNull()

    await selectAndAnnotate(body)

    expect(addedAnnotations[0]).toMatchObject({
      quote: 'Should I include the preprint evidence?',
      source: {
        kind: 'session-item',
        sessionId: 'session-1',
        itemType: 'subagent-message',
        itemId: 'durable-upward-message',
        sectionId: 'body'
      }
    })
    await render(addedAnnotations)
    expect(draftHighlightRanges().map((highlightRange) => highlightRange.toString())).toContain(
      'Should I include the preprint evidence?'
    )

    const messageCommands = session.runtimeContext?.delegatedWork?.messageCommands ?? []
    session.runtimeContext = {
      ...session.runtimeContext!,
      delegatedWork: {
        ...session.runtimeContext!.delegatedWork!,
        messageCommands: messageCommands.map((command) =>
          command.messageId === 'durable-upward-message'
            ? {
                ...command,
                text: [
                  'Line one',
                  'Line two',
                  'Line three',
                  'Line four',
                  'Line five',
                  'Line six',
                  'Line seven',
                  'Should I include the preprint evidence?'
                ].join('\n')
              }
            : command
        )
      }
    }
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    )
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 160
    })
    const fillers = Array.from({ length: 85 }, (_, index) =>
      createActivity({
        id: `subagent-filler-${index}`,
        activityGroupId: `subagent-filler-group-${index}`,
        sortIndex: index + 2,
        createdAt: 1710000000002 + index,
        updatedAt: 1710000000002 + index
      })
    )
    await renderScroller({
      session: { ...session, activities: fillers },
      annotations: addedAnnotations,
      onAddAnnotation
    })
    expect(
      container.querySelector('[data-message-id="subagent-message-durable-upward-message"]')
    ).toBeNull()

    await act(async () => requestAnnotationReveal(addedAnnotations[0]!))
    expect(
      container.querySelector('[data-message-id="subagent-message-durable-upward-message"]')
    ).not.toBeNull()
    expect(
      Array.from(highlights.get('agent-annotation-reveal') ?? []).map((range) => range.toString())
    ).toContain('Should I include the preprint evidence?')
    const revealedBody = container.querySelector<HTMLElement>(
      '[data-testid="subagent-message-body"]'
    )!
    expect(revealedBody.className).not.toContain('line-clamp-6')

    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Show less'))
        ?.click()
    )
    expect(revealedBody.className).toContain('line-clamp-6')
    await act(async () => requestAnnotationReveal(addedAnnotations[0]!))
    expect(revealedBody.className).not.toContain('line-clamp-6')

    if (scrollHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor)
    } else {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    }
  })

  it('annotates diff body text without including the file label or gutter', async () => {
    const activity = createActivity({
      id: 'edit-report-1',
      title: 'Edit report',
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolContent: [
        {
          type: 'diff',
          path: '/workspace/report.md',
          oldText: 'old evidence',
          newText: 'new evidence'
        }
      ]
    })
    const session = createSession({ status: 'idle', activities: [activity] })
    const addedAnnotations: TextAnnotation[] = []
    const onAddAnnotation = vi.fn((annotation: TextAnnotation) => {
      addedAnnotations.push(annotation)
      return undefined
    })
    const render = async (annotations: readonly TextAnnotation[]): Promise<void> => {
      await renderScroller({
        session,
        annotations,
        onAddAnnotation
      })
    }

    await render([])
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')?.click()
    )
    const diffLines = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="tool-diff-block"] code > span')
    )
    const addedLine = diffLines.find((line) => line.textContent === '+new evidence')!
    const addedText = Array.from(addedLine.childNodes).find(
      (node): node is Text =>
        node.nodeType === Node.TEXT_NODE && node.textContent === 'new evidence'
    )!
    await selectAndAnnotate(addedLine, addedText)

    expect(addedAnnotations.map(({ quote, source }) => ({ quote, source }))).toEqual([
      {
        quote: 'new evidence',
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemType: 'tool-activity',
          itemId: 'edit-report-1',
          sectionId: 'diff:0'
        }
      }
    ])
    const fileLabel = Array.from(container.querySelectorAll<HTMLElement>('div')).find(
      (element) => element.textContent === 'report.md'
    )
    expect(fileLabel?.closest('[data-annotation-surface]')).toBeNull()

    await render(addedAnnotations)
    expect(draftHighlightRanges().map((highlightedRange) => highlightedRange.toString())).toContain(
      'new evidence'
    )
  })
})
