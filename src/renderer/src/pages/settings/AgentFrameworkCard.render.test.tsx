// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentFrameworkCard } from './AgentFrameworkCard'
import { getClaudeInstallSources } from '../../../../shared/settings'

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

type CardProps = React.ComponentProps<typeof AgentFrameworkCard>

// A not-installed Claude Agent by default; each test overrides only the props it exercises.
const baseProps: CardProps = {
  icon: <svg data-testid="brand-icon" />,
  name: 'Claude Agent',
  description: "Anthropic's agentic coding tool for the terminal.",
  ready: false,
  notReadyHint: 'Install Claude Agent below.',
  sourceLabel: 'anthropics/claude-code',
  sourceUrl: 'https://github.com/anthropics/claude-code',
  active: false,
  onSelect: vi.fn(),
  selectDisabled: false,
  uninstallCommand: 'npm uninstall -g @anthropic-ai/claude-code',
  managed: true,
  isUninstalling: false,
  isDetecting: false,
  onUninstall: vi.fn(),
  installSources: getClaudeInstallSources('darwin'),
  install: { isInstalling: false, installLogs: [] as string[], installProgress: null },
  installRunning: false,
  npmAvailable: true,
  onInstall: vi.fn()
}

const renderCard = (overrides: Partial<CardProps> = {}): void => {
  act(() => {
    root.render(<AgentFrameworkCard {...baseProps} {...overrides} />)
  })
}

// Radix menus open on pointerdown (not click), so the trigger needs the full event sequence —
// same pattern as the other dropdown tests in this codebase.
const openInstallMenu = (): void => {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Install"]')
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    trigger?.click()
  })
}

describe('AgentFrameworkCard', () => {
  it('marks the active card with a solid Active badge and a checked radio', () => {
    renderCard({ ready: true, path: '/bin/claude', version: '2.1.0', active: true })

    const radio = container.querySelector<HTMLElement>('[role="radio"]')
    expect(radio?.getAttribute('aria-checked')).toBe('true')
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.textContent).toBe('Active')
    expect(badge?.getAttribute('data-variant')).toBe('default')
    expect(container.querySelector('[data-slot="card"]')?.className).toContain('ring-primary')
  })

  it('shows name, muted v-prefixed version, description, path chip and repo link', () => {
    renderCard({ ready: true, path: '/bin/claude', version: '2.1.0' })

    expect(container.textContent).toContain('Claude Agent')
    expect(container.textContent).toContain('v2.1.0')
    expect(container.textContent).toContain("Anthropic's agentic coding tool for the terminal.")
    const chip = container.querySelector('code')
    expect(chip?.textContent).toBe('/bin/claude')
    const link = container.querySelector<HTMLAnchorElement>('a[href]')
    expect(link?.href).toBe('https://github.com/anthropics/claude-code')
    expect(link?.textContent).toContain('anthropics/claude-code')
  })

  it('selects the framework when anywhere on a ready card is clicked', () => {
    const onSelect = vi.fn()
    renderCard({ ready: true, path: '/bin/claude', onSelect })

    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.textContent).toBe('Installed')

    const radio = container.querySelector<HTMLElement>('[role="radio"]')
    expect(radio?.getAttribute('aria-checked')).toBe('false')
    act(() => radio?.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('does not select when the action column is clicked', () => {
    const onSelect = vi.fn()
    renderCard({ ready: true, path: '/bin/claude', onSelect })

    const uninstall = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Uninstall')
    )
    act(() => uninstall?.click())
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('recedes a not-installed card (dashed outline, muted badge) with no radio', () => {
    renderCard({ ready: false })

    expect(container.querySelector('[role="radio"]')).toBeNull()
    const card = container.querySelector('[data-slot="card"]')
    expect(card?.className).toContain('border-dashed')
    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge?.textContent).toBe('Not installed')
    expect(container.textContent).toContain('Install Claude Agent below.')
  })

  it('routes the chosen install source to onInstall', () => {
    const onInstall = vi.fn()
    renderCard({ ready: false, onInstall })
    openInstallMenu()

    const npmItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('npm (global install)'))
    expect(npmItem).toBeDefined()
    act(() => {
      npmItem?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      npmItem?.click()
    })

    expect(onInstall).toHaveBeenCalledWith('npm')
  })

  it('disables npm sources in the menu when npm is unavailable', () => {
    renderCard({ ready: false, npmAvailable: false })
    openInstallMenu()

    const npmItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('npm (global install)'))
    expect(npmItem?.getAttribute('data-disabled')).toBeDefined()
    expect(npmItem?.textContent).toContain('(npm not found)')
  })

  it('shows the progress bar and an "Installing…" button while its install runs', () => {
    renderCard({
      ready: false,
      install: {
        isInstalling: true,
        installLogs: [],
        installProgress: {
          kind: 'progress',
          installId: 'test',
          phase: 'downloading',
          receivedBytes: 50,
          totalBytes: 100
        }
      }
    })

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Install"]')
    expect(trigger?.textContent).toContain('Installing…')
    expect(trigger?.disabled).toBe(true)

    const bar = container.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('50')
  })

  it('surfaces an install error and force-shows the log for triage', () => {
    renderCard({
      ready: false,
      install: {
        isInstalling: false,
        installLogs: ['line one\n'],
        installProgress: null,
        installError: 'boom'
      }
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('boom')
    expect(container.querySelector('[aria-label="Install log"]')?.textContent).toContain('line one')
  })

  it('locks Uninstall on every card while ANY framework install runs', () => {
    // Another framework is installing (installRunning) but not this card (installing=false):
    // RuntimeUninstallControl's contract disables Uninstall globally, not just on the busy card.
    renderCard({ ready: true, path: '/bin/claude', installRunning: true })

    const uninstall = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Uninstall')
    )
    expect(uninstall?.disabled).toBe(true)
  })

  it('keeps the Install button available while only the uninstall is actionable for a broken install', () => {
    // Path resolved but not ready (e.g. Codex whose preflight failed): both repair paths stay reachable.
    renderCard({ ready: false, path: '/data/codex/adapter/index.js' })

    expect(
      Array.from(container.querySelectorAll('button')).some((b) =>
        b.textContent?.includes('Uninstall')
      )
    ).toBe(true)
    expect(container.querySelector('[aria-label^="Install"]')).not.toBeNull()
  })
})
