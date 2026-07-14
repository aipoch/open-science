// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import { WorkspaceMessageItem } from './WorkspaceMessageItem'

// Keep the transcript row and markdown surface as thin wrappers so the test never loads Shiki.
vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: PropsWithChildren): JSX.Element => <div>{children}</div>
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

let container: HTMLDivElement
let root: Root

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

const noop = (): void => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const mentionMessage = createMessage({
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

const clickButton = (label: string): void => {
  const button = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)

  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('WorkspaceMessageItem mention pills', () => {
  it('invokes the skill handler with the skill id when a skill pill is clicked', () => {
    const onOpenSkillMention = vi.fn()

    act(() => {
      root.render(
        <WorkspaceMessageItem
          message={mentionMessage}
          onPreviewArtifact={noop}
          onPreviewUploadAttachment={noop}
          onOpenSkillMention={onOpenSkillMention}
          onPreviewMentionArtifact={noop}
        />
      )
    })

    clickButton('Open skill forecast')

    expect(onOpenSkillMention).toHaveBeenCalledWith('skill-forecast', 'forecast')
  })

  it('invokes the artifact handler with the mention part when an artifact pill is clicked', () => {
    const onPreviewMentionArtifact = vi.fn()

    act(() => {
      root.render(
        <WorkspaceMessageItem
          message={mentionMessage}
          onPreviewArtifact={noop}
          onPreviewUploadAttachment={noop}
          onOpenSkillMention={noop}
          onPreviewMentionArtifact={onPreviewMentionArtifact}
        />
      )
    })

    clickButton('Preview clinical trial03.pdf')

    expect(onPreviewMentionArtifact).toHaveBeenCalledWith({
      type: 'artifact',
      id: 'artifact-1',
      name: 'clinical trial03.pdf',
      path: '/p/clinical trial03.pdf',
      source: 'artifact'
    })
  })
})
