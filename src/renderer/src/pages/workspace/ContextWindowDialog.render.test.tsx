// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ContextWindowDialog } from './ContextWindowDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
          contextWindow: { used: 34_000, size: 128_000 },
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

  it('renders a flat trend without duplicate summary or pinned-detail cards', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })

    const dialog = document.body.querySelector('[role="dialog"]')
    const header = dialog?.querySelector('[data-slot="context-window-dialog-header"]')
    const body = dialog?.querySelector('[data-slot="context-window-dialog-body"]')
    const description = dialog?.querySelector('#context-window-description')
    expect(dialog?.textContent).toContain('Context window')
    expect(dialog?.getAttribute('data-slot')).toBe('context-window-dialog')
    expect(dialog?.textContent).toContain('CONTEXT PER RUN')
    expect(dialog?.textContent).not.toContain('Hover a point for details.')
    expect(header).not.toBeNull()
    expect(header?.contains(description ?? null)).toBe(true)
    expect(header?.parentElement).toBe(dialog)
    expect(dialog?.classList.contains('p-0')).toBe(true)
    expect(header?.className).toContain('border-b border-border-300/90 px-5 py-3.5')
    expect(body?.className).toContain('p-5')
    expect(dialog?.querySelectorAll('[data-slot="context-window-point"]')).toHaveLength(2)
    expect(dialog?.textContent).toContain('Window used (actual)')
    expect(
      dialog?.querySelector('[aria-label="Close context window"]')?.getAttribute('data-size')
    ).toBe('icon-sm')
    expect(dialog?.textContent).not.toContain('Latest window used')
    expect(dialog?.querySelector('[data-slot="context-window-point-details"]')).toBeNull()
    expect(dialog?.textContent).not.toContain('Compression')
    expect(dialog?.textContent).not.toContain('Summaries')
    expect(
      dialog?.querySelector('[data-slot="context-window-trend-chart"]')?.className
    ).not.toContain('overflow-x-auto')
  })

  it('shows the point popover on hover and keeps interrupt state visible', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })
    const firstPoint = document.body.querySelector<SVGGElement>(
      '[data-slot="context-window-point"]'
    )

    act(() => {
      firstPoint?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })

    const tooltip = document.body.querySelector('[data-slot="context-window-chart-tooltip"]')
    expect(tooltip?.textContent).toContain('Interrupted')
    expect(tooltip?.textContent).toContain('Claude Code')
    expect(tooltip?.textContent).toContain('claude-sonnet-4-5')
    expect(tooltip?.textContent).toContain('Provider update')
    expect(
      tooltip
        ?.querySelector('[data-slot="context-window-point-title"]')
        ?.classList.contains('whitespace-nowrap')
    ).toBe(true)
  })

  it('shows point details on focus without pinning them on click', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })
    const firstPoint = document.body.querySelector<SVGGElement>(
      '[data-slot="context-window-point"]'
    )

    act(() => {
      firstPoint?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(document.body.querySelector('[data-slot="context-window-chart-tooltip"]')).not.toBeNull()

    act(() => {
      firstPoint?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      firstPoint?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.querySelector('[data-slot="context-window-chart-tooltip"]')).toBeNull()
  })

  it('shows the cache-read split without raw token details or duplicate dividers', () => {
    act(() => {
      root.render(<ContextWindowDialog open session={session()} onOpenChange={vi.fn()} />)
    })
    const points = document.body.querySelectorAll<SVGGElement>('[data-slot="context-window-point"]')

    act(() => {
      points[1]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })

    const tooltip = document.body.querySelector('[data-slot="context-window-chart-tooltip"]')
    expect(tooltip?.textContent).toContain('cache-read 94%')
    expect(tooltip?.textContent).toContain('uncached 6%')
    expect(tooltip?.textContent).not.toContain('Input')
    expect(tooltip?.textContent).not.toContain('Cache')
    expect(tooltip?.textContent).not.toContain('Output')
    expect(
      tooltip
        ?.querySelector('[data-slot="context-window-point-metadata"]')
        ?.classList.contains('border-t')
    ).toBe(false)
    expect(tooltip?.classList.contains('sm:bottom-3')).toBe(true)
    expect(tooltip?.classList.contains('sm:bottom-auto')).toBe(false)
  })

  it('hides the cache split when the provider did not report a read breakdown', () => {
    const compatible = session()
    const completed = compatible.messages[0]?.contextWindowSamples?.[1]
    if (!completed) throw new Error('expected completed context sample')
    completed.modelStepUsage = { inputTokens: 2_000, cacheTokens: 32_000, outputTokens: 120 }
    completed.contextWindow = { ...completed.contextWindow, used: 35_000 }

    act(() => {
      root.render(<ContextWindowDialog open session={compatible} onOpenChange={vi.fn()} />)
    })
    const points = document.body.querySelectorAll<SVGGElement>('[data-slot="context-window-point"]')
    act(() => {
      points[1]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })

    expect(document.body.textContent).not.toContain('cache-read')
    expect(document.body.textContent).not.toContain('uncached')
  })

  it('recovers the cache split from a reconciled Codex sample written without the read fields', () => {
    const compatible = session()
    const completed = compatible.messages[0]?.contextWindowSamples?.[1]
    if (!completed) throw new Error('expected completed context sample')
    completed.modelStepUsage = { inputTokens: 10_013, cacheTokens: 10_624, outputTokens: 69 }
    completed.contextWindow = { ...completed.contextWindow, used: 20_637 }

    act(() => {
      root.render(<ContextWindowDialog open session={compatible} onOpenChange={vi.fn()} />)
    })
    const points = document.body.querySelectorAll<SVGGElement>('[data-slot="context-window-point"]')
    act(() => {
      points[1]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('cache-read 51%')
    expect(document.body.textContent).toContain('uncached 49%')
  })

  it('renders an honest empty state for compatible sessions without samples', () => {
    const emptySession = { ...session(), messages: [] }
    act(() => {
      root.render(<ContextWindowDialog open session={emptySession} onOpenChange={vi.fn()} />)
    })

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

    const point = document.body.querySelector<SVGGElement>('[data-slot="context-window-point"]')
    act(() => {
      point?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })

    expect(
      document.body.querySelector('[data-slot="context-window-chart-tooltip"]')?.textContent
    ).toContain('Error')
  })
})
