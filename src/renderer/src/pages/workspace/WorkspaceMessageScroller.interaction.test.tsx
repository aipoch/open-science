// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import type { ChatMessage, ChatSession } from '@/stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
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

describe('WorkspaceMessageScroller artifact click behavior', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    upsertAndActivateItem.mockClear()
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
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
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
        <WorkspaceMessageScroller
          activeSession={session}
          canEditMessage={false}
          onEditMessage={vi.fn()}
        />
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
      name: 'report.png',
      format: 'image',
      mimeType: 'image/png',
      size: 2048,
      mtimeMs: 1710000000100
    })
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
        <WorkspaceMessageScroller
          activeSession={session}
          canEditMessage={false}
          onEditMessage={vi.fn()}
        />
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
        <WorkspaceMessageScroller
          activeSession={session}
          canEditMessage={false}
          onEditMessage={vi.fn()}
        />
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
      name: 'first.png',
      format: 'image',
      mimeType: 'image/png',
      size: 2048
    })
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
        <WorkspaceMessageScroller
          activeSession={session}
          canEditMessage={false}
          onEditMessage={vi.fn()}
        />
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
