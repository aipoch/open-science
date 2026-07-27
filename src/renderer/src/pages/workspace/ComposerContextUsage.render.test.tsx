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
