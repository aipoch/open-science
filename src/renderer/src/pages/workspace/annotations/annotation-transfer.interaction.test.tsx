import { useAnnotationDrop } from './use-annotation-drop'
import { AnnotationDragSource } from './AnnotationDragSource'
// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ANNOTATION_LIMITS, type Annotation } from '../../../../../shared/annotations'
import {
  SideChatProvider,
  useSideChatTransfers,
  useSideChatController,
  type SideChatView
} from '../use-side-chat-controller'
import { AnnotationTransferSource, AnnotationMoveTarget } from './AnnotationTransferSource'
import { useAnnotationDrag } from './use-annotation-drag'
import { SideChatAnnotationDrop } from './SideChatAnnotationDrop'
import { annotationTransfers } from './annotation-transfer'
import {
  usePreviewWorkbenchStore,
  createInitialPreviewWorkbenchState
} from '@/stores/preview-workbench-store'

const originalApi = window.api
const annotation: Annotation = {
  id: 'quote',
  kind: 'text',
  target: 'agent',
  quote: 'Evidence',
  source: { kind: 'agent-message', sessionId: 'main', messageId: 'message' }
}
const createDataTransfer = (): {
  types: string[]
  setData: (type: string, value: string) => void
  getData: (type: string) => string
} => {
  const data = new Map<string, string>()
  const dataTransfer = {
    types: [] as string[],
    setData: (type: string, value: string) => {
      data.set(type, value)
      if (!dataTransfer.types.includes(type)) dataTransfer.types.push(type)
    },
    getData: (type: string) => data.get(type) ?? ''
  }
  return dataTransfer
}
afterEach(() => {
  cleanup()
  annotationTransfers.cancel()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  window.api = originalApi
})
function Card({ testId = 'source' }: { testId?: string }): React.JSX.Element {
  const drag = useAnnotationDrag(annotation)
  return (
    <AnnotationMoveTarget annotation={annotation}>
      <article data-testid={testId} {...drag} tabIndex={0} />
    </AnnotationMoveTarget>
  )
}
function SideSource({ view }: { view: SideChatView }): React.JSX.Element {
  const chat = useSideChatController(
    { sessionId: view.parentSessionId, projectId: view.projectId },
    view.id
  )
  return (
    <AnnotationDragSource
      sourceId={`side-chat:${view.id}`}
      projectId={view.projectId}
      parentSessionId={view.parentSessionId}
      annotations={view.annotations ?? []}
      disabled={false}
      onRemove={(id) => chat.setAnnotations?.((items) => items.filter((item) => item.id !== id))}
    >
      {view.annotations?.length ? <Card testId="side-source" /> : null}
    </AnnotationDragSource>
  )
}
function setup(): {
  ui: ReturnType<typeof render>
  transfers: () => ReturnType<typeof useSideChatTransfers>
  start: (text: string) => Promise<boolean>
  setDraft: (text: string) => void
} {
  window.api = {
    sideChat: { start: vi.fn(), onEvent: vi.fn(() => () => undefined) }
  } as unknown as Window['api']
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project')
  let targets!: ReturnType<typeof useSideChatTransfers>
  let controller!: ReturnType<typeof useSideChatController>
  function Harness(): React.JSX.Element {
    const currentController = useSideChatController({ sessionId: 'main', projectId: 'project' })
    const currentTargets = useSideChatTransfers()
    useLayoutEffect(() => {
      targets = currentTargets
      controller = currentController
    })
    const [annotations, setAnnotations] = useState<readonly Annotation[]>([annotation])
    const drop = useAnnotationDrop({
      targetId: 'composer',
      projectId: 'project',
      parentSessionId: 'main',
      receive: ({ annotation }) => {
        setAnnotations((items) =>
          items.some((item) => item.id === annotation.id) ? items : [...items, annotation]
        )
        return true
      }
    })
    return (
      <>
        <div data-testid="main-drop" {...drop.props}>
          <AnnotationTransferSource
            sourceId="composer"
            projectId="project"
            parentSessionId="main"
            annotations={annotations}
            disabled={false}
            onRemove={(id) => setAnnotations((items) => items.filter((item) => item.id !== id))}
          >
            {annotations.length ? <Card /> : null}
          </AnnotationTransferSource>
        </div>
        {currentTargets.views.map((view) => (
          <SideChatAnnotationDrop
            key={view.id}
            chatId={view.id!}
            parentSessionId={view.parentSessionId}
            projectId={view.projectId}
          >
            <span>{view.id}</span>
            <SideSource view={view} />
          </SideChatAnnotationDrop>
        ))}
      </>
    )
  }
  const ui = render(
    <SideChatProvider>
      <Harness />
    </SideChatProvider>
  )
  return {
    ui,
    transfers: () => targets,
    start: (text) => controller.start(text),
    setDraft: (text) => controller.setDraft(text)
  }
}
it('drops into the selected sibling draft without sending, deduplicates, and leaves other drafts alone', () => {
  const { ui, transfers, setDraft } = setup()
  let first!: string, second!: string
  act(() => {
    first = transfers().create({ sessionId: 'main', projectId: 'project' })!
  })
  act(() => setDraft('Keep this sibling draft'))
  act(() => {
    second = transfers().create({ sessionId: 'main', projectId: 'project' })!
  })
  const dataTransfer = createDataTransfer()
  fireEvent.dragStart(ui.getByTestId('source'), { dataTransfer })
  fireEvent.dragOver(ui.getAllByTestId('side-chat-annotation-drop')[1], { dataTransfer })
  expect(ui.getByText('Add to this Side chat')).toBeTruthy()
  fireEvent.drop(ui.getAllByTestId('side-chat-annotation-drop')[1], { dataTransfer })
  expect(ui.queryByTestId('source')).toBeNull()
  expect(transfers().views.find((view) => view.id === first)?.annotations ?? []).toEqual([])
  expect(transfers().views.find((view) => view.id === first)?.draft).toBe('Keep this sibling draft')
  expect(transfers().views.find((view) => view.id === second)?.annotations).toEqual([annotation])
  act(() =>
    expect(
      transfers().receive(second, { parentSessionId: 'main', projectId: 'project', annotation })
    ).toBe(true)
  )
  expect(transfers().views.find((view) => view.id === second)?.annotations).toHaveLength(1)
  expect(window.api.sideChat.start).not.toHaveBeenCalled()
})
it('rejects a different main session and preserves the source card', () => {
  const { ui, transfers } = setup()
  let other!: string
  act(() => {
    other = transfers().create({ sessionId: 'other', projectId: 'project' })!
  })
  expect(
    transfers().receive(other, { parentSessionId: 'main', projectId: 'project', annotation })
  ).toBe(false)
  expect(ui.getByTestId('source')).toBeTruthy()
})
it('offers an explicit target chooser through the annotation action menu and creates an unsent side draft', async () => {
  const { ui, transfers } = setup()
  expect(ui.queryByLabelText('Annotation actions')).toBeNull()
  fireEvent.contextMenu(ui.getByTestId('source'))
  fireEvent.click(ui.getByRole('menuitem', { name: 'Move to Side chat…' }))
  expect(ui.getByRole('dialog')).toBeTruthy()
  fireEvent.click(ui.getByRole('button', { name: 'New side chat' }))
  expect(ui.queryByTestId('source')).toBeNull()
  expect(transfers().views).toHaveLength(1)
  expect(transfers().views[0].annotations).toEqual([annotation])
  expect(window.api.sideChat.start).not.toHaveBeenCalled()
})

it('keeps the source when a target cannot accept another annotation', () => {
  const { ui, transfers } = setup()
  let target!: string
  act(() => {
    target = transfers().create({ sessionId: 'main', projectId: 'project' })!
  })
  const oversized = { ...annotation, quote: 'x'.repeat(ANNOTATION_LIMITS.quote + 1) }
  expect(
    transfers().receive(target, {
      parentSessionId: 'main',
      projectId: 'project',
      annotation: oversized
    })
  ).toBe(false)
  expect(transfers().views[0].annotations ?? []).toEqual([])
  expect(ui.getByTestId('source')).toBeTruthy()
})

it('moves a side annotation back to the main draft and refuses a drop onto its own composer', () => {
  const { ui, transfers } = setup()
  let target!: string
  act(() => {
    target = transfers().create({ sessionId: 'main', projectId: 'project' })!
  })
  const dataTransfer = createDataTransfer()
  fireEvent.dragStart(ui.getByTestId('source'), { dataTransfer })
  fireEvent.drop(ui.getByTestId('side-chat-annotation-drop'), { dataTransfer })
  expect(ui.queryByTestId('source')).toBeNull()
  fireEvent.dragStart(ui.getByTestId('side-source'), { dataTransfer })
  fireEvent.drop(ui.getByTestId('side-chat-annotation-drop'), { dataTransfer })
  expect(transfers().views[0].annotations).toEqual([annotation])
  fireEvent.dragStart(ui.getByTestId('side-source'), { dataTransfer })
  fireEvent.drop(ui.getByTestId('main-drop'), { dataTransfer })
  expect(ui.getByTestId('source')).toBeTruthy()
  expect(ui.queryByTestId('side-source')).toBeNull()
  expect(transfers().views.find((view) => view.id === target)?.annotations).toEqual([])
  expect(window.api.sideChat.start).not.toHaveBeenCalled()
})

it('opens the low-frequency move action from the keyboard and cancels without changing the draft', () => {
  const { ui, transfers } = setup()
  const source = ui.getByTestId('source')
  source.focus()
  fireEvent.keyDown(source, { key: 'F10', shiftKey: true })
  fireEvent.click(ui.getByRole('menuitem', { name: 'Move to Side chat…' }))
  expect(ui.getByRole('dialog').textContent).toContain('Move to Side chat')
  fireEvent.click(ui.getByRole('button', { name: 'Cancel' }))
  expect(ui.queryByRole('dialog')).toBeNull()
  expect(ui.getByTestId('source')).toBeTruthy()
  expect(transfers().views).toHaveLength(0)
})

it('offers a running Side chat created through the composer start path as an annotation destination', async () => {
  const { ui, transfers, start } = setup()
  window.api.sideChat.start = vi.fn(async (request) => ({
    sideSessionId: request.sideSessionId!,
    frameworkId: 'claude-code' as const
  }))
  await act(async () => {
    expect(await start('Composer-created question')).toBe(true)
  })
  fireEvent.contextMenu(ui.getByTestId('source'))
  fireEvent.click(ui.getByRole('menuitem', { name: 'Move to Side chat…' }))
  fireEvent.click(ui.getByRole('button', { name: /Composer-created question/ }))
  expect(transfers().views).toHaveLength(1)
  expect(transfers().views[0].running).toBe(true)
  expect(transfers().views[0].annotations).toEqual([annotation])
  expect(ui.queryByTestId('source')).toBeNull()
  expect(window.api.sideChat.start).toHaveBeenCalledOnce()
})

it('refreshes runtime-backed destinations when opening the picker while retaining local drafts', async () => {
  const { ui, transfers } = setup()
  act(() => {
    transfers().create({ sessionId: 'main', projectId: 'project' })
  })
  window.api.sideChat.list = vi.fn(async () => ({
    revision: 2,
    chats: [
      {
        revision: 2,
        sideSessionId: 'side-chat-composer',
        parentSessionId: 'main',
        projectId: 'project',
        running: true,
        entries: [
          {
            id: 'question',
            kind: 'message' as const,
            role: 'user' as const,
            text: 'Question created through composer'
          }
        ]
      }
    ]
  }))
  fireEvent.contextMenu(ui.getByTestId('source'))
  await act(async () => {
    fireEvent.click(ui.getByRole('menuitem', { name: 'Move to Side chat…' }))
  })
  expect(window.api.sideChat.list).toHaveBeenCalledOnce()
  expect(transfers().views).toHaveLength(2)
  fireEvent.click(ui.getByRole('button', { name: /Question created through composer/ }))
  expect(
    transfers().views.find((view) => view.sideSessionId === 'side-chat-composer')?.annotations
  ).toEqual([annotation])
  expect(ui.queryByTestId('source')).toBeNull()
  expect(window.api.sideChat.start).not.toHaveBeenCalled()
})

it('does not resurrect a chat closed while the destination refresh is pending', async () => {
  const { transfers, start } = setup()
  window.api.sideChat.start = vi.fn(async (request) => ({
    sideSessionId: request.sideSessionId!,
    frameworkId: 'claude-code' as const
  }))
  await act(async () => {
    await start('Close during refresh')
  })
  const sideSessionId = transfers().views[0].sideSessionId!
  let resolve!: (value: Awaited<ReturnType<Window['api']['sideChat']['list']>>) => void
  window.api.sideChat.list = vi.fn<Window['api']['sideChat']['list']>(
    () =>
      new Promise((accept) => {
        resolve = accept
      })
  )
  const pending = transfers().refresh()
  act(() => {
    vi.mocked(window.api.sideChat.onEvent).mock.calls[0][0]({
      parentSessionId: 'main',
      projectId: 'project',
      sideSessionId,
      revision: 3,
      event: { kind: 'closed', reason: 'closed' }
    })
  })
  await act(async () => {
    resolve({
      revision: 2,
      chats: [
        {
          sideSessionId,
          revision: 2,
          parentSessionId: 'main',
          projectId: 'project',
          running: false,
          entries: []
        }
      ]
    })
    await pending
  })
  expect(transfers().views).toHaveLength(0)
})
