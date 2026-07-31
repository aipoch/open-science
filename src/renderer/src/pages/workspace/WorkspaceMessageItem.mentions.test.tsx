// @vitest-environment jsdom
import { act, StrictMode } from 'react'
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

vi.mock('./artifact-preview', () => ({
  ArtifactPreview: () => null
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
  delete (window as unknown as { api?: unknown }).api
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

const renderMessageItem = async (
  message: ChatMessage,
  artifacts?: React.ComponentProps<typeof WorkspaceMessageItem>['artifacts']
): Promise<void> => {
  await act(async () => {
    root.render(
      <WorkspaceMessageItem
        message={message}
        artifacts={artifacts}
        onPreviewArtifact={noop}
        onPreviewUploadAttachment={noop}
        onOpenSkillMention={noop}
        onPreviewMentionArtifact={noop}
      />
    )
  })
}

const expectSplitFileName = (
  button: Element | null,
  head: string,
  tail: string,
  extension: string
): void => {
  expect(button?.querySelector('[data-testid="file-name-head"]')?.textContent).toBe(head)
  expect(button?.querySelector('[data-testid="file-name-ellipsis"]')?.textContent).toBe('...')
  expect(button?.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe(tail)
  const extensionNode = button?.querySelector('[data-testid="file-name-extension"]')
  expect(extensionNode?.textContent).toBe(extension)
  expect(extensionNode?.className).toContain('shrink-0')
}

describe('WorkspaceMessageItem mention pills', () => {
  it('renders path-free Provenance mentions with the normal pill style but no navigation', () => {
    const onOpenSkillMention = vi.fn()
    const onPreviewMentionArtifact = vi.fn()

    act(() => {
      root.render(
        <WorkspaceMessageItem
          message={createMessage({ content: 'Path-free snapshot' })}
          staticParts={[
            { type: 'text', text: 'Run ' },
            { type: 'skill', name: 'forecast' },
            { type: 'text', text: ' on ' },
            { type: 'artifact', versionId: 'version-1', name: 'clinical trial03.pdf' }
          ]}
          onPreviewArtifact={noop}
          onPreviewUploadAttachment={noop}
          onOpenSkillMention={onOpenSkillMention}
          onPreviewMentionArtifact={onPreviewMentionArtifact}
        />
      )
    })

    expect(container.textContent).toContain('Run /forecast on @clinical trial03.pdf')
    expect(container.querySelector('[aria-label="Open skill forecast"]')).toBeNull()
    expect(container.querySelector('[aria-label="Preview clinical trial03.pdf"]')).toBeNull()
    expect(onOpenSkillMention).not.toHaveBeenCalled()
    expect(onPreviewMentionArtifact).not.toHaveBeenCalled()
  })

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

describe('WorkspaceMessageItem file names', () => {
  it('uses the compact fallback for an uploaded attachment', async () => {
    const name = 'long_uploaded_experiment_result.png'
    const message = createMessage({
      uploads: [
        {
          id: 'upload-1',
          sessionId: 'session-1',
          name: 'stored.png',
          originalName: name,
          path: '/p/stored.png',
          mimeType: 'image/png',
          size: 1024
        }
      ]
    })

    await renderMessageItem(message)

    const button = container.querySelector(`[aria-label="Preview uploaded attachment ${name}"]`)
    expectSplitFileName(button, 'lon', 't', '.png')
  })

  it('uses the compact fallback for a generated file', async () => {
    ;(window as unknown as { api: unknown }).api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({ kind: 'text', content: '' }),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: '',
          encoding: 'utf8',
          size: 0,
          truncated: false
        })
      }
    }
    const name = 'long_generated_experiment_result.csv'
    const message = createMessage({ id: 'm-assistant', role: 'agent', content: 'Done' })
    const artifacts = [
      {
        id: 'artifact-1',
        kind: 'managed-file' as const,
        path: `/p/${name}`,
        fileUrl: `file:///p/${name}`,
        name,
        mimeType: 'text/csv',
        size: 10,
        mtimeMs: 1
      }
    ]

    await renderMessageItem(message, artifacts)

    const button = container.querySelector(`[aria-label="Preview generated file ${name}"]`)
    expectSplitFileName(button, 'lon', 't', '.csv')
    expect(button?.querySelector('div[class*="px-1.5"]')).not.toBeNull()
    expect(button?.querySelector('span.text-text-300')?.className).toContain('ml-1')
  })
})

describe('WorkspaceMessageItem missing artifact badge', () => {
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('badges a generated file whose source is missing on disk', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT'
    })
    ;(window as unknown as { api: unknown }).api = {
      previewResources: {
        acquire: vi.fn().mockRejectedValue(enoent),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: { readPreview: vi.fn().mockRejectedValue(enoent) }
    }

    const message = createMessage({ id: 'm-assistant', role: 'agent', content: 'Done' })
    const artifacts = [
      {
        id: 'artifact-gone',
        kind: 'managed-file' as const,
        path: '/p/gone.png',
        fileUrl: 'file:///p/gone.png',
        name: 'gone.png',
        mimeType: 'image/png',
        size: 10,
        mtimeMs: 1
      }
    ]

    await act(async () => {
      root.render(
        <StrictMode>
          <WorkspaceMessageItem
            message={message}
            artifacts={artifacts}
            onPreviewArtifact={noop}
            onPreviewUploadAttachment={noop}
            onOpenSkillMention={noop}
            onPreviewMentionArtifact={noop}
          />
        </StrictMode>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The existence probe rejected with ENOENT, so the thumbnail carries the "Missing" tag.
    expect(container.textContent).toContain('Missing')
  })
})

describe('WorkspaceMessageItem turn token usage', () => {
  it('shows the completed response totals below the agent message', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90 }
      })
    )

    const usage = container.querySelector('[data-slot="turn-token-usage"]')
    expect(usage?.getAttribute('aria-label')).toBe('Token usage for this response')
    expect(usage?.textContent).toContain('Input 12,345')
    expect(usage?.textContent).toContain('Cache 678')
    expect(usage?.textContent).toContain('Output 90')
  })

  it('shows unavailable totals when the agent did not report usage', async () => {
    await renderMessageItem(
      createMessage({ role: 'agent', content: 'Done', turnUsageUnavailable: true })
    )

    const usage = container.querySelector('[data-slot="turn-token-usage"]')
    expect(usage?.getAttribute('aria-label')).toBe('Token usage unavailable for this response')
    expect(usage?.textContent).toContain('Input —')
    expect(usage?.textContent).toContain('Cache —')
    expect(usage?.textContent).toContain('Output —')
  })

  it('omits the footer from a non-final agent message in the same turn', async () => {
    await renderMessageItem(createMessage({ role: 'agent', content: 'Intermediate update' }))

    expect(container.querySelector('[data-slot="turn-token-usage"]')).toBeNull()
  })

  it('waits until an agent response completes before showing unavailable totals', async () => {
    await renderMessageItem(
      createMessage({ role: 'agent', content: 'Still working', status: 'streaming' })
    )

    expect(container.querySelector('[data-slot="turn-token-usage"]')).toBeNull()
  })
})
