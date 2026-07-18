// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentFrameworkView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { AgentFrameworkSection } from './AgentFrameworkSection'

// Radix Select/AlertDialog call pointer-capture and scroll APIs jsdom does not implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root

const FRAMEWORKS: AgentFrameworkView[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    supportsSkills: true,
    supportedApiTypes: ['anthropic']
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    supportsSkills: true,
    supportedApiTypes: ['anthropic', 'openai']
  }
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState(createInitialSettingsState())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const render = (): void => {
  act(() => root.render(<AgentFrameworkSection />))
}

const openSelect = (): void => {
  // The SettingsSection wrapper shares this aria-label, so target the trigger button specifically.
  const trigger = document.body.querySelector<HTMLButtonElement>(
    'button[aria-label="Agent framework"]'
  )
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const clickOption = (text: string): void => {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(text)
  )
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const clickButtonByText = (text: string): void => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  )
  act(() => button?.click())
}

// Choose a framework in the (deferred) select, which opens the confirmation dialog.
const chooseFramework = (displayName: string): void => {
  openSelect()
  clickOption(displayName)
}

describe('AgentFrameworkSection', () => {
  it('shows the selected framework name in the trigger', () => {
    useSettingsStore.setState({ agentFrameworkId: 'opencode', agentFrameworks: FRAMEWORKS })
    render()

    expect(container.querySelector('[aria-label="Agent framework"]')?.textContent).toContain(
      'OpenCode'
    )
  })

  it('defaults to Claude Code when no framework is set', () => {
    useSettingsStore.setState({ agentFrameworkId: undefined, agentFrameworks: [] })
    render()

    // Falls back to the known list, so both options exist even before a snapshot arrives.
    expect(container.querySelector('[aria-label="Agent framework"]')?.textContent).toContain(
      'Claude Code'
    )
    openSelect()
    const options = Array.from(document.body.querySelectorAll('[role="option"]')).map((option) =>
      option.textContent?.trim()
    )
    expect(options).toContain('Claude Code')
    expect(options).toContain('OpenCode')
  })

  it('defers the switch behind a confirmation dialog instead of applying it immediately', () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      setAgentFramework
    })
    render()

    chooseFramework('OpenCode')

    // The dialog is shown but the store action has not fired yet.
    expect(document.body.textContent).toContain('Switch to OpenCode?')
    expect(setAgentFramework).not.toHaveBeenCalled()
  })

  it('applies the switch only after the user confirms', () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      setAgentFramework
    })
    render()

    chooseFramework('OpenCode')
    clickButtonByText('Switch')

    expect(setAgentFramework).toHaveBeenCalledWith('opencode')
  })

  it('cancels the switch and leaves the framework unchanged', () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      setAgentFramework
    })
    render()

    chooseFramework('OpenCode')
    clickButtonByText('Cancel')

    expect(setAgentFramework).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Switch to OpenCode?')
  })

  it('warns that skills are unavailable when the selected framework lacks skill support', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      // The snapshot entry wins over the known fallback, so a skills-less OpenCode is reflected.
      agentFrameworks: [FRAMEWORKS[0], { ...FRAMEWORKS[1], supportsSkills: false }]
    })
    render()

    expect(container.textContent).toContain("Skills aren't available with OpenCode")
  })

  it('does not warn about skills for a framework that supports them', () => {
    useSettingsStore.setState({ agentFrameworkId: 'claude-code', agentFrameworks: FRAMEWORKS })
    render()

    expect(container.textContent).not.toContain("Skills aren't available")
  })
})
