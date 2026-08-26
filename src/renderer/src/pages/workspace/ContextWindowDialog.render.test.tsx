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

  it('does not inspect Session history while closed', () => {
    const closedSession = session()
    Object.defineProperty(closedSession, 'messages', {
      get: () => {
        throw new Error('closed dialog inspected Session history')
      }
    })

    expect(() => {
      act(() => {
        root.render(
          <ContextWindowDialog open={false} session={closedSession} onOpenChange={vi.fn()} />
        )
      })
    }).not.toThrow()
    expect(document.body.querySelector('[data-slot="context-window-dialog"]')).toBeNull()
  })

  it('shows current composition, stacked run history, and stable latest-run details', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })

    const dialog = document.body.querySelector('[role="dialog"]')
    const header = dialog?.querySelector('[data-slot="context-window-dialog-header"]')
    const description = dialog?.querySelector('#context-window-description')
    expect(dialog?.textContent).toContain('Current composition')
    expect(dialog?.textContent).toContain('34K/ 128K tokens27%')
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
        ?.className.includes('grid-cols-1')
    ).toBe(true)
    // The full-width ratio strip leads the composition card above the legend and uses the muted
    // design-system chart tokens instead of the vivid Tailwind palette.
    const composition = dialog?.querySelector('[data-slot="current-composition"]')
    const strip = composition?.querySelector('[data-slot="context-composition-strip"]')
    const legend = composition?.querySelector('[data-slot="context-category-legend"]')
    expect(strip?.className).toContain('h-4')
    expect(strip && legend ? strip.compareDocumentPosition(legend) : 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(strip?.querySelector('.bg-chart-2')).not.toBeNull()
    expect(strip?.querySelector('.bg-cyan-400')).toBeNull()
    // The legend carries swatch + label + value only; per-row mini bars would duplicate the strip.
    expect(legend?.querySelectorAll('.h-1')).toHaveLength(0)
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
      '48K/ 128K tokens38%'
    )
    expect(
      document.body.querySelector('[data-slot="context-window-point-details"]')?.textContent
    ).toContain('34K / 128K')
  })

  const sessionWithCalls = (): ChatSession => {
    const withCalls = session()
    withCalls.messages.push({
      id: 'answer-1',
      role: 'agent',
      responseToMessageId: 'prompt-1',
      content: 'Done',
      eventIds: [],
      status: 'complete',
      turnUsage: { inputTokens: 30, cacheTokens: 6, outputTokens: 8, turnCount: 2 },
      modelCallUsage: [
        {
          id: 'answer-1:model-call:0',
          index: 0,
          inputTokens: 10,
          cacheTokens: 2,
          outputTokens: 3,
          contextUsedTokens: 12,
          contextWindowSize: 25
        },
        {
          id: 'answer-1:model-call:1',
          index: 1,
          inputTokens: 20,
          cacheTokens: 4,
          outputTokens: 5,
          contextUsedTokens: 24,
          contextWindowSize: 25
        }
      ],
      createdAt: 2,
      updatedAt: 3,
      completedAt: 3
    })
    withCalls.conversationGraph?.messages.push({
      id: 'answer-1',
      role: 'agent',
      responseToMessageId: 'prompt-1',
      content: 'Done',
      eventIds: [],
      status: 'complete',
      agentFrameId: 'root',
      introducedOnBranchId: 'branch-1',
      revisionRootMessageId: 'answer-1',
      runtimeSegmentId: 'runtime-2',
      createdAt: 2,
      updatedAt: 3
    })
    return withCalls
  }

  const switchToCalls = (): void => {
    const callsToggle = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ].find((button) => button.textContent === 'Calls')
    act(() => callsToggle?.click())
  }

  it('summarizes exact Session calls and charts one stacked bar per call inside a turn band', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={sessionWithCalls()} onOpenChange={vi.fn()} />)
    })
    switchToCalls()

    const summary = document.body.querySelector('[data-slot="context-call-summary"]')
    expect(summary?.className).toContain('bg-card')
    expect(summary?.querySelector('[data-slot="context-call-metrics"]')?.className).toContain(
      'lg:grid-cols-3'
    )
    expect(summary?.textContent).toContain('Total calls2 calls')
    expect(summary?.textContent).toContain('Total tokens44')
    expect(summary?.textContent).toContain('In 30 · Cache 6 · Out 8')
    expect(summary?.textContent).toContain('Peak window24 / 25 · 96%')

    const chart = document.body.querySelector('[data-slot="context-call-chart"]')
    expect(chart?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Call usage chart across 2 model calls'
    )
    expect(chart?.querySelectorAll('[data-slot="context-call-point"]')).toHaveLength(2)
    expect(chart?.querySelectorAll('[data-slot="context-call-bar"]')).toHaveLength(2)
    const bands = chart?.querySelectorAll('[data-slot="context-call-band"]')
    expect(bands).toHaveLength(1)
    expect(bands?.[0]?.textContent).toContain('T1')
    // Turn bands group calls with a gray lane carrying the T{n} label, not a vertical divider.
    expect(bands?.[0]?.className).not.toContain('border-l')
    const lane = bands?.[0]?.querySelector('span.bg-muted')
    expect(lane?.textContent).toContain('T1')
    // Call bars use the muted design-system chart tokens, matching the message Usage popover:
    // Input deep blue, Cache a light tint of the same blue, Output green.
    const firstBar = chart?.querySelector('[data-slot="context-call-bar"]')
    expect(firstBar?.querySelector('.bg-chart-1')).not.toBeNull()
    expect(firstBar?.querySelector('[class*="bg-chart-1/40"]')).not.toBeNull()
    expect(firstBar?.querySelector('.bg-chart-2')).not.toBeNull()
    expect(firstBar?.querySelector('.bg-cyan-400')).toBeNull()

    const history = document.body.querySelector('[data-slot="context-call-history"]')
    // These calls report aggregate cache only, so the legend shows a single Cache chip.
    for (const chip of ['Input', 'Cache', 'Output']) {
      expect(history?.textContent).toContain(chip)
    }
    expect(history?.textContent).not.toContain('Cache read')
    expect(history?.textContent).not.toContain('Cache write')

    const details = document.body.querySelector('[data-slot="context-call-details"]')
    expect(details?.querySelector('[data-slot="context-call-details-title"]')?.textContent).toBe(
      'Turn 1 · Call 2'
    )
    expect(details?.textContent).toContain('Compare the papers')
    expect(details?.textContent).toContain('Agent: Main Agent · Codex')
    expect(details?.textContent).toContain('Model: gpt-5.6-codex · provider-b')
    expect(details?.textContent).toContain('Window used24 / 25')
    expect(details?.textContent).toContain('Message 2')
    expect(details?.querySelector('[data-slot="context-call-window-meter"]')).not.toBeNull()
    const mix = details?.querySelector('[data-slot="context-call-token-mix"]')
    expect(mix?.textContent).toContain('Input20 69%')
    expect(mix?.textContent).toContain('Cache4 14%')
    expect(mix?.textContent).toContain('Output5 17%')
  })

  it('previews on hover and pins a selected call on activation', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={sessionWithCalls()} onOpenChange={vi.fn()} />)
    })
    switchToCalls()
    const bars = document.body.querySelectorAll<HTMLButtonElement>(
      '[data-slot="context-call-point"]'
    )

    act(() => {
      bars[0]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(
      document.body.querySelector('[data-slot="context-call-details-title"]')?.textContent
    ).toBe('Turn 1 · Call 1')

    act(() => {
      bars[0]?.click()
      bars[0]?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
    })
    expect(bars[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(
      document.body.querySelector('[data-slot="context-call-details-title"]')?.textContent
    ).toBe('Turn 1 · Call 1')

    act(() => bars[0]?.click())
    expect(bars[0]?.getAttribute('aria-pressed')).toBe('false')
    expect(
      document.body.querySelector('[data-slot="context-call-details-title"]')?.textContent
    ).toBe('Turn 1 · Call 2')
  })

  it('renders — for calls without context or cache-split data', () => {
    const withoutContext = session()
    withoutContext.messages.push({
      id: 'answer-1',
      role: 'agent',
      responseToMessageId: 'prompt-1',
      content: 'Done',
      eventIds: [],
      status: 'complete',
      turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: 1 },
      modelCallUsage: [
        { id: 'answer-1:model-call:0', index: 0, inputTokens: 10, cacheTokens: 2, outputTokens: 3 }
      ],
      createdAt: 2,
      updatedAt: 3,
      completedAt: 3
    })

    act(() => {
      root.render(<ContextWindowDialog open session={withoutContext} onOpenChange={vi.fn()} />)
    })
    switchToCalls()

    const summary = document.body.querySelector('[data-slot="context-call-summary"]')
    expect(summary?.textContent).toContain('Peak window—')

    const details = document.body.querySelector('[data-slot="context-call-details"]')
    expect(details?.textContent).toContain('Window used—')
    expect(details?.querySelector('[data-slot="context-call-window-meter"]')).toBeNull()
    const mix = details?.querySelector('[data-slot="context-call-token-mix"]')
    expect(mix?.textContent).toContain('Cache2')
    expect(mix?.textContent).not.toContain('Cache read')
    expect(details?.textContent).not.toContain('undefined')
    expect(details?.textContent).not.toContain('NaN')
  })

  it('labels the legend with cache read/write when calls report the split', () => {
    const withSplit = session()
    withSplit.messages.push({
      id: 'answer-1',
      role: 'agent',
      responseToMessageId: 'prompt-1',
      content: 'Done',
      eventIds: [],
      status: 'complete',
      turnUsage: { inputTokens: 10, cacheTokens: 9, outputTokens: 3, turnCount: 1 },
      modelCallUsage: [
        {
          id: 'answer-1:model-call:0',
          index: 0,
          inputTokens: 10,
          cacheTokens: 9,
          cachedReadTokens: 7,
          cachedWriteTokens: 2,
          outputTokens: 3
        }
      ],
      createdAt: 2,
      updatedAt: 3,
      completedAt: 3
    })

    act(() => {
      root.render(<ContextWindowDialog open session={withSplit} onOpenChange={vi.fn()} />)
    })
    switchToCalls()

    const history = document.body.querySelector('[data-slot="context-call-history"]')
    for (const chip of ['Input', 'Cache read', 'Cache write', 'Output']) {
      expect(history?.textContent).toContain(chip)
    }
  })

  it('keeps the dashed empty state when the session has no tracked calls', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })
    switchToCalls()

    expect(document.body.textContent).toContain('No call details yet')
    expect(document.body.textContent).toContain('This Session may predate call tracking')
    const summary = document.body.querySelector('[data-slot="context-call-summary"]')
    expect(summary?.textContent).toContain('Total calls0 calls')
    expect(summary?.textContent).toContain('Peak window—')
    expect(document.body.querySelector('[data-slot="context-call-chart"]')).toBeNull()
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
