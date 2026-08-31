// @vitest-environment jsdom
// Completing a streamed Agent row must not re-enable content-visibility. The 10rem intrinsic
// fallback is taller than a one-line reply, and that height flash pushes a live tool below it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import { WorkspaceMessageItem } from './WorkspaceMessageItem'

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

const renderItem = async (message: ChatMessage): Promise<void> => {
  await act(async () => {
    root.render(
      <WorkspaceMessageItem
        message={message}
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
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('WorkspaceMessageItem content-visibility containment', () => {
  it('keeps containment disabled after a streamed one-line Agent reply completes', async () => {
    await renderItem(createMessage({ status: 'streaming' }))
    expect(containmentDisabled()).toBe(true)

    await renderItem(createMessage({ status: 'complete' }))
    expect(containmentDisabled()).toBe(true)
  })

  it('contains a historical Agent reply that never streamed in this mount', async () => {
    await renderItem(createMessage({ status: 'complete' }))
    expect(containmentDisabled()).toBe(false)
  })
})
