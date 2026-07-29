// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerContextUsage } from './ComposerContextUsage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ComposerContextUsage', () => {
  it('stays hidden until the current agent context reports usage', () => {
    act(() => root.render(<ComposerContextUsage contextUsage={undefined} />))

    expect(container.querySelector('button')).toBeNull()
  })

  it('shows current context occupancy as a percentage with token details', async () => {
    act(() => root.render(<ComposerContextUsage contextUsage={{ used: 24_890, size: 200_000 }} />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 12%"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('12%')

    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Context window')
    expect(document.body.textContent).toContain('25k / 200k tokens (12%)')
  })

  it('opens the interactive context popup when the indicator is hovered', async () => {
    act(() => root.render(<ComposerContextUsage contextUsage={{ used: 50_000, size: 200_000 }} />))
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 25%"]')

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('50k / 200k tokens (25%)')
    expect(document.activeElement).not.toBe(
      Array.from(document.body.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Compact')
      )
    )
  })

  it('shows locally estimated categories reconciled against the Agent total', async () => {
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{
            used: 29_500,
            size: 168_000,
            breakdown: {
              source: 'estimated',
              tokenizer: 'o200k_base',
              model: 'gpt-5.6-sol',
              estimatedTokens: 29_405,
              difference: 95,
              status: 'reconciled',
              categories: [
                { key: 'system', tokens: 7_200, estimated: true },
                { key: 'tools', tokens: 19_000, estimated: true },
                { key: 'messages', tokens: 2_105, estimated: true },
                { key: 'skills', tokens: 1_100, estimated: true },
                { key: 'other', tokens: 95, estimated: false }
              ]
            }
          }}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 18%"]')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('17.6%')
    expect(document.body.textContent).toContain('System prompt')
    expect(document.body.textContent).toContain('Tools and agents')
    expect(document.body.textContent).toContain('Messages')
    expect(document.body.textContent).toContain('Skills')
    expect(document.body.textContent).toContain('Agent/framework overhead')
    expect(document.body.textContent).toContain('Local 29.4k · Agent 29.5k · Δ +95')
    expect(document.body.textContent).toContain('Reconciled · o200k_base · gpt-5.6-sol')
    expect(document.body.textContent).not.toContain(
      'Agent total is authoritative; category values are local estimates.'
    )

    const popoverId = trigger?.getAttribute('aria-controls')
    const popover = popoverId ? document.getElementById(popoverId) : null
    expect(popover?.className).toContain('rounded-lg')
    expect(popover?.className).toContain('border-border')
    expect(popover?.className).toContain('bg-popover')
    expect(popover?.className).toContain('shadow-menu')
    expect(popover?.className).toContain('w-72')
    expect(popover?.getAttribute('data-align')).toBe('center')
    expect(popover?.querySelector('[data-slot="context-usage-summary"]')?.className).toContain(
      'whitespace-nowrap'
    )
    expect(
      popover?.querySelector('[data-slot="context-usage-diagnostics"]')?.textContent
    ).toContain('Reconciled · o200k_base · gpt-5.6-sol')
    expect(
      document.body.querySelector('[aria-label^="Estimated category occupancy"]')
    ).not.toBeNull()
  })

  it('labels a generating snapshot as a local estimate without an Agent delta', async () => {
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{
            used: 20_600,
            size: 1_000_000,
            breakdown: {
              source: 'estimated',
              tokenizer: 'cl100k_base',
              model: 'deepseek-v4-flash',
              estimatedTokens: 20_600,
              difference: 0,
              status: 'preflight',
              categories: [
                { key: 'system', tokens: 2_400, estimated: true },
                { key: 'messages', tokens: 100, estimated: true },
                { key: 'mcp', tokens: 18_100, estimated: true }
              ]
            }
          }}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Estimated context: 2%"]'
    )
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Local estimate 20.6k / 1M')
    expect(document.body.textContent).toContain('Estimating · cl100k_base · deepseek-v4-flash')
    expect(document.body.textContent).not.toContain('Agent 20.6k')
    expect(document.body.textContent).not.toContain('Δ')
  })

  it('shows a token-only local estimate before the model window is known', async () => {
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{
            used: 20_600,
            breakdown: {
              source: 'estimated',
              tokenizer: 'o200k_base',
              estimatedTokens: 20_600,
              difference: 0,
              status: 'preflight',
              categories: [{ key: 'messages', tokens: 20_600, estimated: true }]
            }
          }}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Estimated context: 21k"]'
    )
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Context window21kLocal estimate')
    expect(document.body.textContent).not.toContain('/ undefined')
    expect(
      document.body.querySelector('[aria-label="Estimated category distribution: 20.6k tokens"]')
    ).not.toBeNull()
  })

  it('keeps the latest Agent total visible while preflight categories update', async () => {
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{
            used: 96_000,
            agentUsed: 96_000,
            size: 128_000,
            breakdown: {
              source: 'estimated',
              tokenizer: 'anthropic',
              model: 'claude-sonnet-4-5',
              estimatedTokens: 38_300,
              difference: 0,
              status: 'preflight',
              categories: [
                { key: 'system', tokens: 2_400, estimated: true },
                { key: 'messages', tokens: 17_800, estimated: true },
                { key: 'mcp', tokens: 18_100, estimated: true }
              ]
            }
          }}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 75%"]')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Agent used 96k / 128k')
    expect(document.body.textContent).toContain('Local 38.3k · Latest Agent 96k')
    expect(document.body.textContent).toContain(
      'Estimating · Anthropic approx. · claude-sonnet-4-5'
    )
    expect(document.body.textContent).not.toContain('Δ')
  })

  it('does not offer compaction from a high local estimate before Agent reconciliation', async () => {
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{
            used: 400_000,
            size: 1_000_000,
            breakdown: {
              source: 'estimated',
              tokenizer: 'cl100k_base',
              estimatedTokens: 400_000,
              difference: 0,
              status: 'preflight',
              categories: [{ key: 'messages', tokens: 400_000, estimated: true }]
            }
          }}
          canCompact
          onCompact={vi.fn()}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Estimated context: 40%"]'
    )
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[aria-label="Compact context"]')).toBeNull()
  })

  it('keeps the compact action hidden until context usage reaches thirty percent', async () => {
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{ used: 29_600, size: 100_000 }}
          compactDisabledReason="Reconnect before compacting."
        />
      )
    )

    // The visible label rounds to 30%, but the action threshold uses the exact 29.6% ratio.
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 30%"]')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[aria-label="Compact context"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Reconnect before compacting.')
  })

  it('lets the user request native compaction from the context details', async () => {
    const onCompact = vi.fn()
    act(() =>
      root.render(
        <ComposerContextUsage
          contextUsage={{ used: 180_000, size: 200_000 }}
          canCompact
          onCompact={onCompact}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 90%"]')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    const compactButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Compact context"]'
    )
    expect(compactButton).not.toBeNull()
    expect(compactButton?.textContent).toBe('Compact')
    expect(compactButton?.className).toContain('h-6')
    expect(compactButton?.className).toContain('w-full')
    expect(compactButton?.parentElement?.className).toContain('pt-1')
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(document.activeElement).toBe(compactButton)

    act(() => compactButton?.click())

    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('explains when manual compaction requires reconnection and shows active progress', async () => {
    const render = (compacting: boolean): void => {
      act(() =>
        root.render(
          <ComposerContextUsage
            contextUsage={{ used: 60_000, size: 200_000 }}
            compacting={compacting}
            compactDisabledReason="Send a message to reconnect this session before compacting."
          />
        )
      )
    }

    render(false)
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Context used: 30%"]')
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
    })

    const compactButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Compact context"]'
    )
    expect(compactButton?.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.textContent).toContain(
      'Send a message to reconnect this session before compacting.'
    )

    render(true)
    expect(document.body.textContent).toContain('Compacting…')
  })
})
