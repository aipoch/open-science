// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useNavigationStore } from '@/stores/navigation-store'
import type { ChatMessage } from '@/stores/session-store'

import { WorkspaceMessageItem } from './WorkspaceMessageItem'

const { artifactPreview } = vi.hoisted(() => ({
  artifactPreview: vi.fn(() => null)
}))

// Keep the transcript row and markdown surface as thin wrappers so the test never loads Shiki.
vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: PropsWithChildren): JSX.Element => <div>{children}</div>
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('./artifact-preview', () => ({
  ArtifactPreview: artifactPreview
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
  artifactPreview.mockClear()
  useSettingsStore.setState(createInitialSettingsState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
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
  artifacts?: React.ComponentProps<typeof WorkspaceMessageItem>['artifacts'],
  turnStartedAt?: number,
  runtimeIdentity?: React.ComponentProps<typeof WorkspaceMessageItem>['runtimeIdentity']
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
        turnStartedAt={turnStartedAt}
        runtimeIdentity={runtimeIdentity}
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

  it('renders a truncated Session title snapshot and navigates by Session id', () => {
    const openSessionById = vi.spyOn(useNavigationStore.getState(), 'openSessionById')
    const title = 'A very long referenced Session title that remains available in full'
    const sessionMessage = createMessage({
      content: `Compare #${title}`,
      parts: [
        { type: 'text', text: 'Compare ' },
        { type: 'session', sessionId: 'session-2', title }
      ]
    })

    act(() => {
      root.render(
        <WorkspaceMessageItem
          message={sessionMessage}
          onPreviewArtifact={noop}
          onPreviewUploadAttachment={noop}
          onOpenSkillMention={noop}
          onPreviewMentionArtifact={noop}
        />
      )
    })

    const pill = container.querySelector(`[aria-label="Open session ${title}"]`)
    expect(pill?.className).toContain('truncate')
    expect(pill?.className).toContain('bg-accent')
    expect(pill?.className).toContain('text-accent-foreground')
    expect(pill?.getAttribute('title')).toBe(title)
    clickButton(`Open session ${title}`)
    expect(openSessionById).toHaveBeenCalledWith('session-2', 'user')
  })

  it('renders a linked-folder mention as a dark-gray @ pill over the relative path', () => {
    const onPreviewMentionArtifact = vi.fn()
    const linkedMessage = createMessage({
      content: 'analyze @data/study.csv',
      parts: [
        { type: 'text', text: 'analyze ' },
        {
          type: 'artifact',
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/study.csv'
        }
      ]
    })

    act(() => {
      root.render(
        <WorkspaceMessageItem
          message={linkedMessage}
          onPreviewArtifact={noop}
          onPreviewUploadAttachment={noop}
          onOpenSkillMention={noop}
          onPreviewMentionArtifact={onPreviewMentionArtifact}
        />
      )
    })

    const pill = container.querySelector('[aria-label="Preview study.csv"]')
    expect(pill?.className).toContain('bg-path-chip')
    expect(pill?.className).toContain('text-path-chip-foreground')
    expect(pill?.textContent).toBe('@data/study.csv')
    expect(pill?.getAttribute('title')).toBe('@data/study.csv')

    clickButton('Preview study.csv')
    expect(onPreviewMentionArtifact).toHaveBeenCalledWith({
      type: 'artifact',
      id: 'linked-1',
      name: 'study.csv',
      source: 'linked-folder',
      rootId: 'root-1',
      relativePath: 'data/study.csv'
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
    expect(button?.querySelector('span.text-text-000')?.className).toContain('ml-1')
  })

  it('reads the exact generated Artifact Version shown by the card', async () => {
    const readPreview = vi.fn().mockResolvedValue({
      content: '',
      encoding: 'utf8',
      size: 10,
      truncated: false
    })
    ;(window as unknown as { api: unknown }).api = { artifacts: { readPreview } }

    await renderMessageItem(createMessage({ id: 'm-assistant', role: 'agent', content: 'Done' }), [
      {
        id: 'version-1',
        artifactId: 'artifact-1',
        versionId: 'version-1',
        isPublished: true,
        kind: 'managed-file',
        path: '/p/chart.png',
        name: 'chart.png',
        mimeType: 'image/png',
        size: 10,
        mtimeMs: 1,
        resolvedProjectId: 'project-1',
        resolvedSessionId: 'session-1'
      }
    ])

    expect(readPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        fileId: 'artifact-1',
        versionId: 'version-1'
      })
    )
  })

  it('forwards generated Artifact identity to the image preview', async () => {
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: '',
          encoding: 'utf8',
          size: 10,
          truncated: false
        })
      }
    }
    const artifact = {
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      isPublished: true,
      kind: 'managed-file' as const,
      path: '/p/chart.png',
      name: 'chart.png',
      mimeType: 'image/png',
      size: 10,
      mtimeMs: 1,
      resolvedProjectId: 'project-1',
      resolvedSessionId: 'session-1'
    }

    await renderMessageItem(createMessage({ id: 'm-assistant', role: 'agent', content: 'Done' }), [
      artifact
    ])

    expect(artifactPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact,
        projectId: 'project-1',
        sessionId: 'session-1',
        managedFileId: 'artifact-1',
        selectedVersionId: 'version-1'
      }),
      undefined
    )
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
      artifacts: { readPreview: vi.fn().mockRejectedValue(enoent) }
    }

    const message = createMessage({ id: 'm-assistant', role: 'agent', content: 'Done' })
    const artifacts = [
      {
        id: 'artifact-gone',
        artifactId: 'logical-artifact-gone',
        kind: 'managed-file' as const,
        path: '/p/gone.png',
        fileUrl: 'file:///p/gone.png',
        name: 'gone.png',
        mimeType: 'image/png',
        size: 10,
        mtimeMs: 1,
        resolvedProjectId: 'default-project',
        resolvedSessionId: 'session-1'
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
  it('keeps completion metadata compact and reveals response token totals from Usage', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        createdAt: 1710000030000,
        completedAt: 1710000125000,
        updatedAt: 1710000999000,
        turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90, turnCount: 3 }
      }),
      undefined,
      1710000000000
    )

    const footer = container.querySelector('[data-slot="assistant-message-footer"]')
    const completedTime = footer?.querySelector('time')
    const elapsedSegment = footer?.querySelector('[data-slot="assistant-message-elapsed-segment"]')
    const usage = footer?.querySelector('[data-slot="turn-token-usage"]')
    const usageTrigger = usage?.querySelector<HTMLButtonElement>('button')
    const separator = usage?.querySelector('[data-slot="assistant-message-metadata-separator"]')

    expect(completedTime?.textContent).toMatch(/^Completed /)
    expect(completedTime?.getAttribute('datetime')).toBe('2024-03-09T16:02:05.000Z')
    expect(elapsedSegment?.textContent).toBe('Elapsed 2m 5s')
    expect(elapsedSegment?.classList.contains('whitespace-nowrap')).toBe(true)
    expect(separator).toBeNull()
    expect(usage?.textContent).toBe('Calls')
    expect(usageTrigger?.getAttribute('aria-label')).toBe('Token usage for this response')
    expect(usageTrigger?.querySelector('[data-slot="turn-token-usage-icon"]')).not.toBeNull()
    expect(usageTrigger?.className).toContain('border-dashed')
    expect(usageTrigger?.className).toContain('focus-visible:ring-[3px]')
    expect(usageTrigger?.className).toContain('focus-visible:ring-ring/50')
    expect(usageTrigger?.className).toContain('motion-reduce:transition-none')
    expect(footer?.className).toContain('whitespace-nowrap')
    expect(footer?.textContent).toContain('Elapsed 2m 5s')
    expect(document.body.textContent).not.toContain('Input 12,345')

    await act(async () => {
      usageTrigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      await Promise.resolve()
    })

    const usagePopover = document.body.querySelector('[data-slot="turn-token-usage-popover"]')
    expect(usagePopover?.textContent).toContain('Calls')
    expect(
      usagePopover?.querySelector('[data-slot="turn-token-usage-turn-count"]')?.textContent
    ).toBe('3 calls')
    expect(usagePopover?.textContent).toContain('Input12,345')
    expect(usagePopover?.textContent).toContain('Cache678')
    expect(usagePopover?.textContent).toContain('Output90')
    expect(usagePopover?.textContent).toContain('Total13,113')
    expect(usagePopover?.getAttribute('aria-label')).toBe('Token usage for this response')
    expect(usagePopover?.className).toContain('border-border')
    expect(usagePopover?.className).toContain('bg-popover')
    expect(usagePopover?.className).toContain('shadow-menu')
    expect(usagePopover?.className).toContain('w-48')
    expect(usagePopover?.className).not.toContain('w-56')
    expect(usagePopover?.className).toContain('p-2.5')
    const breakdown = usagePopover?.querySelector('[data-slot="turn-token-usage-breakdown"]')
    expect(breakdown?.getAttribute('aria-label')).toBe(
      'Input 12,345, Cache 678, Output 90; Total 13,113 tokens'
    )
    const segments = Array.from(
      breakdown?.querySelectorAll<HTMLElement>('[data-slot="turn-token-usage-segment"]') ?? []
    )
    expect(segments).toHaveLength(3)
    expect(segments[0]?.className).toContain('bg-chart-1')
    expect(segments[0]?.style.flexGrow).toBe('12345')
    expect(segments[1]?.className).toContain('bg-chart-1/40')
    expect(segments[1]?.style.flexGrow).toBe('678')
    expect(segments[2]?.className).toContain('bg-chart-2')
    expect(segments[2]?.style.flexGrow).toBe('90')
    const markers = Array.from(
      usagePopover?.querySelectorAll('[data-slot="turn-token-usage-marker"]') ?? []
    )
    expect(markers).toHaveLength(3)
    expect(markers[0]?.className).toContain('bg-chart-1')
    expect(markers[1]?.className).toContain('bg-chart-1/40')
    expect(markers[2]?.className).toContain('bg-chart-2')
    expect(
      usagePopover?.querySelector('[data-slot="turn-token-usage-total"]')?.className
    ).toContain('border-t')
  })

  it('resolves the completed turn framework and model provider icons from stored runtime codes', async () => {
    useSettingsStore.setState({
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ],
      providers: [
        {
          id: 'provider-openai',
          type: 'official',
          name: 'OpenAI',
          vendorId: 'openai',
          models: ['gpt-test'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        completedAt: 1710000125000
      }),
      undefined,
      undefined,
      {
        frameworkId: 'codex',
        backendId: 'codex:provider-openai',
        model: 'gpt-test'
      }
    )

    const usageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="turn-token-usage"] button'
    )
    await act(async () => {
      usageTrigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      await Promise.resolve()
    })

    const frameworkIcon = document.body.querySelector('[data-slot="turn-runtime-framework"]')
    const modelIcon = document.body.querySelector('[data-slot="turn-runtime-model"]')
    expect(frameworkIcon?.getAttribute('aria-label')).toBe('Agent framework: Codex')
    expect(frameworkIcon?.getAttribute('title')).toBe('Agent framework: Codex')
    expect(modelIcon?.getAttribute('aria-label')).toBe('Model provider: OpenAI; model: gpt-test')
    expect(modelIcon?.getAttribute('title')).toBe('Model provider: OpenAI; model: gpt-test')
    expect(
      decodeURIComponent(modelIcon?.querySelector('img')?.getAttribute('src') ?? '')
    ).toContain('<title>OpenAI</title>')
    const details = document.body.querySelector('[data-slot="turn-runtime-details"]')
    expect(details?.textContent).toContain('Agent: Codex')
    expect(details?.textContent).toContain('Model: gpt-test')
    expect(
      details?.querySelector('[data-slot="turn-runtime-agent-detail-icon"] .lucide-bot')
    ).not.toBeNull()
    expect(
      details?.querySelector('[data-slot="turn-runtime-model-detail-icon"] .lucide-brain')
    ).not.toBeNull()

    await act(async () => {
      useSettingsStore.setState({
        agentFrameworks: [
          {
            id: 'codex',
            displayName: 'Codex CLI',
            supportedApiTypes: ['responses'],
            supportsSkills: true
          }
        ]
      })
      await Promise.resolve()
    })

    expect(details?.textContent).toContain('Agent: Codex CLI')
  })

  it('omits historical runtime metadata that no longer resolves to displayable values', async () => {
    useSettingsStore.setState({ agentFrameworks: [], providers: [] })
    await renderMessageItem(
      createMessage({ role: 'agent', content: 'Legacy answer', completedAt: 1710000125000 }),
      undefined,
      undefined,
      { frameworkId: 'codex', backendId: 'codex:deleted-provider' }
    )

    const usageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="turn-token-usage"] button'
    )
    await act(async () => {
      usageTrigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-slot="turn-runtime-icons"]')).toBeNull()
    expect(document.body.querySelector('[data-slot="turn-runtime-details"]')).toBeNull()
  })

  it('splits cache reads and writes when the agent reports both categories', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        createdAt: 1710000030000,
        completedAt: 1710000125000,
        turnUsage: {
          inputTokens: 100,
          cacheTokens: 50,
          cachedReadTokens: 30,
          cachedWriteTokens: 20,
          outputTokens: 10,
          turnCount: 1
        }
      })
    )

    const usageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="turn-token-usage"] button'
    )
    await act(async () => {
      usageTrigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      await Promise.resolve()
    })

    const usagePopover = document.body.querySelector('[data-slot="turn-token-usage-popover"]')
    expect(usagePopover?.textContent).toContain('Input100')
    expect(usagePopover?.textContent).toContain('Cache read30')
    expect(usagePopover?.textContent).toContain('Cache write20')
    expect(usagePopover?.textContent).not.toContain('Cache50')
    expect(usagePopover?.textContent).toContain('Output10')
    expect(usagePopover?.textContent).toContain('Total160')
    expect(
      usagePopover?.querySelector('[data-slot="turn-token-usage-turn-count"]')?.textContent
    ).toBe('1 call')

    const segments = Array.from(
      usagePopover?.querySelectorAll<HTMLElement>('[data-slot="turn-token-usage-segment"]') ?? []
    )
    expect(segments).toHaveLength(4)
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual(['100', '30', '20', '10'])
    expect(segments[0]?.className).toContain('bg-chart-1')
    expect(segments[1]?.className).toContain('bg-chart-1/40')
    expect(segments[2]?.className).toContain('bg-chart-3')
    expect(segments[3]?.className).toContain('bg-chart-2')
  })

  it('keeps the Usage popover open while the pointer crosses into it, then closes it', async () => {
    vi.useFakeTimers()
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        completedAt: 1710000125000,
        turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90 }
      })
    )

    const usageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="turn-token-usage"] button'
    )
    act(() => {
      usageTrigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })

    const usagePopover = document.body.querySelector('[data-slot="turn-token-usage-popover"]')
    act(() => {
      usageTrigger?.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: usagePopover })
      )
      usagePopover?.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true, relatedTarget: usageTrigger })
      )
      vi.advanceTimersByTime(100)
    })
    expect(document.body.querySelector('[data-slot="turn-token-usage-popover"]')).not.toBeNull()

    act(() => {
      usagePopover?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
      vi.advanceTimersByTime(100)
    })
    expect(document.body.querySelector('[data-slot="turn-token-usage-popover"]')).toBeNull()
  })

  it('closes the Usage popover with Escape or when keyboard focus leaves it', async () => {
    vi.useFakeTimers()
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        completedAt: 1710000125000,
        turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90 }
      })
    )

    const usageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="turn-token-usage"] button'
    )
    const nextButton = document.createElement('button')
    document.body.appendChild(nextButton)

    await act(async () => {
      usageTrigger?.focus()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-slot="turn-token-usage-popover"]')).not.toBeNull()

    await act(async () => {
      usageTrigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-slot="turn-token-usage-popover"]')).toBeNull()

    await act(async () => {
      nextButton.focus()
      usageTrigger?.focus()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-slot="turn-token-usage-popover"]')).not.toBeNull()

    act(() => {
      nextButton.focus()
      vi.advanceTimersByTime(100)
    })
    expect(document.body.querySelector('[data-slot="turn-token-usage-popover"]')).toBeNull()
  })

  it('clears a pending Usage close when the token summary unmounts', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        completedAt: 1710000125000,
        turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90 }
      })
    )

    const usageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="turn-token-usage"] button'
    )
    act(() => {
      usageTrigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      usageTrigger?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
    })
    const closeTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(([, delay]) => delay === 100)
    const closeTimer = setTimeoutSpy.mock.results[closeTimerIndex]?.value
    expect(closeTimer).toBeDefined()

    await renderMessageItem(
      createMessage({ role: 'agent', content: 'Done without totals', completedAt: 1710000126000 })
    )

    expect(clearTimeoutSpy).toHaveBeenCalledWith(closeTimer)
  })

  it('shows failed time and elapsed run time even when token totals are absent', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Partial answer',
        status: 'error',
        createdAt: 1710000030000,
        failedAt: 1710000125000,
        updatedAt: 1710000999000
      }),
      undefined,
      1710000000000
    )

    const footer = container.querySelector('[data-slot="assistant-message-footer"]')
    const failedTime = footer?.querySelector('time')

    expect(failedTime?.textContent).toMatch(/^Failed /)
    expect(failedTime?.getAttribute('datetime')).toBe('2024-03-09T16:02:05.000Z')
    expect(footer?.textContent).toContain('Elapsed 2m 5s')
    expect(footer?.querySelector('[data-slot="turn-token-usage"]')).toBeNull()
  })

  it('keeps Usage available when a persisted completion time is out of range', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done with a corrupted timestamp',
        completedAt: Number.MAX_VALUE,
        turnUsage: { inputTokens: 12, cacheTokens: 3, outputTokens: 4 }
      }),
      undefined,
      1710000000000
    )

    const footer = container.querySelector('[data-slot="assistant-message-footer"]')

    expect(container.textContent).toContain('Done with a corrupted timestamp')
    expect(footer?.querySelector('time')).toBeNull()
    expect(footer?.querySelector('[data-slot="assistant-message-elapsed-segment"]')).toBeNull()
    expect(footer?.querySelector('[data-slot="turn-token-usage"]')).not.toBeNull()
  })

  it('omits elapsed time when the paired turn start is out of range', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done with a valid completion time',
        completedAt: 1710000125000,
        turnUsage: { inputTokens: 12, cacheTokens: 3, outputTokens: 4 }
      }),
      undefined,
      Number.MAX_VALUE
    )

    const footer = container.querySelector('[data-slot="assistant-message-footer"]')

    expect(footer?.querySelector('time')?.textContent).toMatch(/^Completed /)
    expect(footer?.querySelector('[data-slot="assistant-message-elapsed-segment"]')).toBeNull()
    expect(footer?.querySelector('[data-slot="turn-token-usage"]')).not.toBeNull()
  })

  it('keeps Usage beside completion when elapsed metadata is unavailable', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        completedAt: 1710000000000,
        turnUsage: { inputTokens: 12_345, cacheTokens: 678, outputTokens: 90 }
      })
    )

    const usage = container.querySelector('[data-slot="turn-token-usage"]')
    const usageTrigger = usage?.querySelector('button')
    expect(usageTrigger?.getAttribute('aria-label')).toBe('Token usage for this response')
    expect(usage?.textContent).toBe('Calls')
    expect(container.textContent).not.toContain('Input 12,345')
  })

  it('reveals unavailable totals from the Usage summary when the agent did not report them', async () => {
    await renderMessageItem(
      createMessage({
        role: 'agent',
        content: 'Done',
        completedAt: 1710000000000,
        turnUsageUnavailable: true
      })
    )

    const usage = container.querySelector('[data-slot="turn-token-usage"]')
    const usageTrigger = usage?.querySelector<HTMLButtonElement>('button')
    expect(usageTrigger?.getAttribute('aria-label')).toBe(
      'Token usage unavailable for this response'
    )
    expect(usage?.textContent).toBe('Calls')
    expect(document.body.textContent).not.toContain('Input—')

    await act(async () => {
      usageTrigger?.focus()
      await Promise.resolve()
    })

    const usagePopover = document.body.querySelector('[data-slot="turn-token-usage-popover"]')
    expect(usagePopover?.textContent).toContain('Input—')
    expect(usagePopover?.textContent).toContain('Cache—')
    expect(usagePopover?.textContent).toContain('Output—')
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
