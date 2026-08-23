// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpContextUsage } from '../../../../shared/acp'
import type { ChatSession } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ContextWindowDialog } from './ContextWindowDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reconciledUsage = (used = 34_000): AcpContextUsage => ({
  used,
  size: 128_000,
  breakdown: {
    source: 'estimated',
    tokenizer: 'o200k_base',
    model: 'gpt-5.6-codex',
    estimatedTokens: 33_000,
    difference: used - 33_000,
    status: 'reconciled',
    categories: [
      { key: 'system', tokens: 4_000, estimated: true },
      { key: 'tools', tokens: 8_000, estimated: true },
      { key: 'messages', tokens: 9_000, estimated: true },
      { key: 'mcp', tokens: 5_000, estimated: true },
      { key: 'skills', tokens: 2_000, estimated: true },
      { key: 'other', tokens: 5_000, estimated: false }
    ]
  }
})

const session = (): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Trend',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'Compare the papers',
      eventIds: [],
      status: 'complete',
      contextWindowSamples: [
        {
          id: 'cancelled',
          timestamp: 100,
          runtimeSegmentId: 'runtime-1',
          termination: { kind: 'stop', stopReason: 'cancelled' },
          contextWindow: { used: 31_000, size: 128_000 },
          source: 'provider-update'
        },
        {
          id: 'completed',
          timestamp: 200,
          runtimeSegmentId: 'runtime-2',
          termination: { kind: 'stop', stopReason: 'end_turn' },
          contextWindow: reconciledUsage(),
          modelStepUsage: {
            inputTokens: 2_000,
            cacheTokens: 32_500,
            cachedReadTokens: 32_000,
            cachedWriteTokens: 500,
            outputTokens: 120
          },
          source: 'provider-response'
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
  ],
  activities: [
    {
      id: 'context-compaction:1',
      kind: 'tool',
      title: 'Context compacted',
      promptMessageId: 'prompt-1',
      status: 'completed',
      eventIds: ['compact-start', 'compact-done'],
      sortIndex: 3,
      providerToolName: 'ContextCompaction',
      toolKind: 'other',
      createdAt: 210,
      updatedAt: 220
    }
  ],
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root',
    activeFrameId: 'root',
    frames: [
      {
        id: 'root',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'branch-1',
        createdAt: 1
      }
    ],
    branches: [
      {
        id: 'branch-1',
        agentFrameId: 'root',
        headMessageId: 'prompt-1',
        createdAt: 1,
        updatedAt: 2
      }
    ],
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Compare the papers',
        eventIds: [],
        status: 'complete',
        contextWindowSamples: [],
        agentFrameId: 'root',
        introducedOnBranchId: 'branch-1',
        revisionRootMessageId: 'prompt-1',
        runtimeSegmentId: 'runtime-1',
        createdAt: 1,
        updatedAt: 2
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: [
      {
        id: 'runtime-1',
        agentFrameId: 'root',
        frameworkId: 'claude-code',
        backendId: 'provider-a',
        model: 'claude-sonnet-4-5',
        startedAt: 1
      },
      {
        id: 'runtime-2',
        agentFrameId: 'root',
        frameworkId: 'codex',
        backendId: 'provider-b',
        model: 'gpt-5.6-codex',
        startedAt: 2
      }
    ]
  },
  createdAt: 1,
  updatedAt: 2
})

describe('ContextWindowDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useSettingsStore.setState({
      agentFrameworks: [
        { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
        { id: 'codex', displayName: 'Codex', supportsSkills: true }
      ],
      providers: []
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('shows current composition, stacked run history, and stable latest-run details', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })

    const dialog = document.body.querySelector('[role="dialog"]')
    const header = dialog?.querySelector('[data-slot="context-window-dialog-header"]')
    const description = dialog?.querySelector('#context-window-description')
    expect(dialog?.textContent).toContain('Current composition')
    expect(dialog?.textContent).toContain('34K/ 128K tokens (27%)')
    expect(dialog?.textContent).toContain('System prompt')
    expect(dialog?.textContent).toContain('Tools and agents')
    expect(dialog?.textContent).toContain('History')
    expect(dialog?.querySelectorAll('[data-slot="context-window-point"]')).toHaveLength(2)
    expect(
      dialog?.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('Run 2 · Message 1')
    expect(header?.contains(description ?? null)).toBe(true)
    expect(dialog?.classList.contains('p-0')).toBe(true)
    expect(
      dialog?.querySelector('[aria-label="Close context window"]')?.getAttribute('data-size')
    ).toBe('icon-sm')
    expect(dialog?.querySelector('[data-slot="context-window-trend-chart"]')?.className).toContain(
      'min-w-0'
    )
    expect(
      dialog
        ?.querySelector('[data-slot="current-composition"] [data-slot="context-category-legend"]')
        ?.className.includes('grid-flow-col')
    ).toBe(true)
    expect(dialog?.querySelector('[role="group"]')?.className.includes('min-w-full')).toBe(true)
    expect(
      dialog?.querySelector('[role="group"] > div:last-child')?.className.includes('justify-start')
    ).toBe(true)
    expect(
      dialog?.querySelector('[role="group"] > div:last-child')?.className.includes('gap-0.5')
    ).toBe(true)
    expect(dialog?.querySelector('[data-slot="context-window-bar"]')?.className).toContain('w-8')
  })

  it('uses the live session snapshot for current composition', () => {
    act(() => {
      root.render(
        <ContextWindowDialog
          open
          session={session()}
          contextUsage={reconciledUsage(48_000)}
          onOpenChange={vi.fn()}
        />
      )
    })

    expect(document.body.querySelector('[data-slot="current-composition"]')?.textContent).toContain(
      '48K/ 128K tokens (38%)'
    )
    expect(
      document.body.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('34K / 128K')
  })

  it('previews on hover and pins a selected run on activation', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })
    const points = document.body.querySelectorAll<HTMLButtonElement>(
      '[data-slot="context-window-point"]'
    )

    act(() => {
      points[0]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(
      document.body.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('Interrupted')

    act(() => {
      points[0]?.click()
      points[0]?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
    })
    expect(points[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(
      document.body.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('Run 1 · Message 1')
  })

  it('keeps totals visible when an older run has no category breakdown', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })
    const firstPoint = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="context-window-point"]'
    )

    act(() => firstPoint?.click())

    const detail = document.body.querySelector('[data-slot="context-window-point-details"]')
    expect(detail?.textContent).toContain('31K / 128K')
    expect(detail?.textContent).toContain('Category breakdown is unavailable for this run.')
  })

  it('marks a completed compaction after its owning run', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })

    const marker = document.body.querySelector('[data-slot="context-window-compaction-marker"]')
    expect(marker?.getAttribute('aria-label')).toBe('Context compacted after run 2')
    expect(marker?.querySelector('.lucide-minimize-2')).not.toBeNull()
    expect(marker?.querySelector('.lucide-scissors')).toBeNull()
  })

  it('shows the recoverable Codex cache split in the selected details', () => {
    const compatible = session()
    const completed = compatible.messages[0]?.contextWindowSamples?.[1]
    if (!completed) throw new Error('expected completed context sample')
    completed.modelStepUsage = { inputTokens: 10_013, cacheTokens: 10_624, outputTokens: 69 }
    completed.contextWindow = { ...completed.contextWindow, used: 20_637 }

    act(() => {
      root.render(<ContextWindowDialog open session={compatible} onOpenChange={vi.fn()} />)
    })

    expect(
      document.body.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('cache-read 51% · uncached 49%')
    expect(
      document.body.querySelector('[data-slot="context-diagnostics-row"]')?.className
    ).toContain('sm:flex-nowrap')
  })

  it('renders an honest empty history state while preserving live composition', () => {
    const emptySession = { ...session(), messages: [], activities: [] }
    act(() => {
      root.render(
        <ContextWindowDialog
          open
          session={emptySession}
          contextUsage={reconciledUsage()}
          onOpenChange={vi.fn()}
        />
      )
    })

    expect(document.body.textContent).toContain('Current composition')
    expect(document.body.textContent).toContain('No run history yet')
    expect(document.body.textContent).toContain('Older sessions remain compatible')
  })

  it('shows error as a terminal run state', () => {
    const errored = session()
    const prompt = errored.messages[0]
    const latest = prompt.contextWindowSamples?.[1]
    if (!latest) throw new Error('expected latest context sample')
    errored.messages = [
      {
        ...prompt,
        contextWindowSamples: [
          {
            ...latest,
            id: 'error',
            termination: { kind: 'error' },
            modelStepUsage: undefined
          }
        ]
      }
    ]

    act(() => {
      root.render(<ContextWindowDialog open session={errored} onOpenChange={vi.fn()} />)
    })

    expect(
      document.body.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('Error')
  })
})
