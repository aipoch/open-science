// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClaudeStatusCard } from './ClaudeStatusCard'

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

const render = (embedded = false): void => {
  act(() => {
    root.render(
      <ClaudeStatusCard
        claude={{ resolvedPath: '/bin/claude', version: '2.1.0' }}
        claudeReady
        isDetecting={false}
        onDetect={vi.fn()}
        embedded={embedded}
      />
    )
  })
}

const findUninstallButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Uninstall')
  )

describe('ClaudeStatusCard surface', () => {
  it('uses shadcn card and button slots', () => {
    render()

    expect(container.querySelector('[data-slot="card"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="button"]')).not.toBeNull()
  })

  it('removes its own surface chrome when embedded', () => {
    render(true)
    const card = container.querySelector('[data-slot="card"]')

    expect(card?.className).toContain('ring-0')
    expect(card?.className).toContain('bg-transparent')
  })

  it('hides the uninstall action entirely when onUninstall is omitted (onboarding)', () => {
    render()

    expect(findUninstallButton()).toBeUndefined()
  })

  it('shows a disabled uninstall with a `?` explainer for a non-managed (PATH) install', () => {
    act(() => {
      root.render(
        <ClaudeStatusCard
          claude={{ resolvedPath: '/usr/local/bin/claude', version: '2.1.0' }}
          claudeReady
          isDetecting={false}
          onDetect={vi.fn()}
          onUninstall={vi.fn()}
        />
      )
    })

    // The button now always shows for a detected runtime, but a non-managed install can't be removed.
    expect(findUninstallButton()?.disabled).toBe(true)
    const help = container.querySelector('button[aria-label^="Why can\'t"]')
    expect(help).not.toBeNull()
  })

  it('offers an uninstall action for a managed install and fires onUninstall on click', () => {
    const onUninstall = vi.fn()

    act(() => {
      root.render(
        <ClaudeStatusCard
          claude={{ resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' }}
          claudeReady
          isDetecting={false}
          onDetect={vi.fn()}
          managed
          onUninstall={onUninstall}
        />
      )
    })

    const button = findUninstallButton()
    expect(button).toBeDefined()

    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUninstall).toHaveBeenCalledTimes(1)
  })

  it('exposes a radio selector that fires onSelect, and disables uninstall while active', () => {
    const onSelect = vi.fn()

    act(() => {
      root.render(
        <ClaudeStatusCard
          claude={{ resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' }}
          claudeReady
          isDetecting={false}
          onDetect={vi.fn()}
          active
          onSelect={onSelect}
          managed
          onUninstall={vi.fn()}
        />
      )
    })

    const radio = container.querySelector<HTMLButtonElement>('[role="radio"]')
    expect(radio?.getAttribute('aria-checked')).toBe('true')

    // The active runtime can't be uninstalled — switch away first.
    expect(findUninstallButton()?.disabled).toBe(true)

    act(() => radio?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('locks selection while selectDisabled (e.g. during an install)', () => {
    const onSelect = vi.fn()

    act(() => {
      root.render(
        <ClaudeStatusCard
          claude={{ resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' }}
          claudeReady
          isDetecting={false}
          onDetect={vi.fn()}
          onSelect={onSelect}
          selectDisabled
        />
      )
    })

    const radio = container.querySelector<HTMLButtonElement>('[role="radio"]')
    expect(radio?.disabled).toBe(true)

    act(() => radio?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('is not selectable when the runtime is not installed', () => {
    act(() => {
      root.render(
        <ClaudeStatusCard
          claude={{}}
          claudeReady={false}
          isDetecting={false}
          onDetect={vi.fn()}
          onSelect={vi.fn()}
        />
      )
    })

    // No radio control appears for an uninstalled runtime — you can't switch to a missing agent.
    expect(container.querySelector('[role="radio"]')).toBeNull()
  })
})
