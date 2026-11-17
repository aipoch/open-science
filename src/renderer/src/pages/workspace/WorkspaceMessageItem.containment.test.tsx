// @vitest-environment jsdom
// Completing a streamed Agent row must not re-enable content-visibility. The 10rem intrinsic
// fallback is taller than a one-line reply, and that height flash pushes a live tool below it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceMessageItem as MessageItem } from './WorkspaceMessageItem'

const WorkspaceMessageItem = (
  props: React.ComponentProps<typeof MessageItem>
): React.JSX.Element => (
  <TooltipProvider delayDuration={200}>
    <MessageItem {...props} />
  </TooltipProvider>
)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({
    children,
    disableContainment
  }: PropsWithChildren<{ disableContainment?: boolean }>): JSX.Element => (
    <div data-disable-containment={disableContainment || undefined}>{children}</div>
  )
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

const packageCitation = vi.hoisted(() => ({ enabled: false }))
vi.mock('./SessionMessageMarkdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('./SessionMessageMarkdown')>()
  return {
    ...original,
    SessionMessageMarkdown: (
      props: React.ComponentProps<typeof original.SessionMessageMarkdown>
    ) =>
      packageCitation.enabled ? (
        <div data-testid="package-citation">
          {props.packageSessionId}:{props.packageLiterature?.items[0]?.itemId}
        </div>
      ) : (
        <original.SessionMessageMarkdown {...props} />
      )
  }
})

// Drive presentation from sourceOpen so completing a streamed row is not masked by the
// real jitter buffer still reporting isPresenting in jsdom.
vi.mock('@/components/streamdown/use-smooth-streaming-content', () => ({
  useSmoothStreamingContent: (content: string, sourceOpen: boolean) => ({
    content,
    isPresenting: sourceOpen
  })
}))

vi.mock('./artifact-preview', () => ({
  ArtifactPreview: () => <div data-testid="artifact-preview" />
}))

let container: HTMLDivElement
let root: Root

const createMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  role: 'agent',
  content: 'Next step.',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const noop = (): void => {}

const renderItem = async (
  message: ChatMessage,
  presentationAnimateOnMount?: boolean
): Promise<void> => {
  await act(async () => {
    root.render(
      <WorkspaceMessageItem
        message={message}
        presentationAnimateOnMount={presentationAnimateOnMount}
        projectId="project-1"
        onPreviewArtifact={noop}
        onPreviewUploadAttachment={noop}
        onOpenSkillMention={noop}
        onPreviewMentionArtifact={noop}
      />
    )
  })
}

const containmentDisabled = (): boolean =>
  container.querySelector('[data-disable-containment]') !== null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  packageCitation.enabled = false
  vi.restoreAllMocks()
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('WorkspaceMessageItem content-visibility containment', () => {
  it('refreshes package citation metadata and scope while the Message is unchanged', async () => {
    packageCitation.enabled = true
    const message = createMessage()
    const literature = {
      items: [{ itemId: 'recovered-item', metadataRevision: 1, item: {} }],
      attachments: [],
      unavailableVersionIds: []
    }
    const renderPackage = async (
      packageSessionId: string,
      packageLiterature?: typeof literature
    ): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceMessageItem
            message={message}
            isPackageSession
            packageSessionId={packageSessionId}
            packageLiterature={packageLiterature}
            onPreviewArtifact={noop}
            onPreviewUploadAttachment={noop}
            onOpenSkillMention={noop}
            onPreviewMentionArtifact={noop}
          />
        )
      })
    }
    await renderPackage('imported-session')
    expect(container.querySelector('[data-testid="package-citation"]')?.textContent).toBe(
      'imported-session:'
    )
    await renderPackage('imported-session', literature)
    expect(container.querySelector('[data-testid="package-citation"]')?.textContent).toBe(
      'imported-session:recovered-item'
    )
    await renderPackage('another-session', literature)
    expect(container.querySelector('[data-testid="package-citation"]')?.textContent).toBe(
      'another-session:recovered-item'
    )
  })

  it('keeps containment disabled after a streamed one-line Agent reply completes', async () => {
    await renderItem(createMessage({ status: 'streaming' }))
    expect(containmentDisabled()).toBe(true)

    await renderItem(createMessage({ status: 'complete' }))
    expect(containmentDisabled()).toBe(true)
  })

  it('keeps a newly revealed completed reply out of intrinsic-size containment', async () => {
    await renderItem(createMessage(), true)
    expect(containmentDisabled()).toBe(true)

    await renderItem(createMessage(), false)
    expect(containmentDisabled()).toBe(true)
  })

  it('updates containment when the same message becomes explicitly newly presented', async () => {
    const message = createMessage()
    await renderItem(message)
    expect(containmentDisabled()).toBe(false)

    await renderItem(message, true)
    expect(containmentDisabled()).toBe(true)
  })

  it('contains a historical Agent reply that never streamed in this mount', async () => {
    await renderItem(createMessage({ status: 'complete' }))
    expect(containmentDisabled()).toBe(false)
  })
})
