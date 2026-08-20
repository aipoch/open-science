// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillUsageAgents } from './SkillUsageAgents'
import type { SpecialistUsage } from './specialist-resource-scope'

let container: HTMLDivElement
let root: Root

const usages: SpecialistUsage[] = [
  {
    id: 'alpha',
    name: 'Alpha Specialist',
    kind: 'custom',
    iconKey: 'microscope',
    colorKey: 'teal'
  },
  { id: 'beta', name: 'Beta Specialist', kind: 'custom' },
  { id: 'gamma', name: 'Gamma Specialist', kind: 'builtin' },
  { id: 'delta', name: 'Delta Specialist', kind: 'custom' }
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SkillUsageAgents', () => {
  it('keeps an enabled Main Agent first, caps the compact stack, and spreads on hover', () => {
    act(() => root.render(<SkillUsageAgents mainEnabled usages={usages} />))

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="skill-usage-agents-trigger"]'
    )
    const secondAvatar = document.body.querySelector<HTMLElement>('[data-agent-id="alpha"]')
    expect(trigger?.dataset.mainEnabled).toBe('true')
    expect(trigger?.className).toContain('h-6')
    expect(
      document.body.querySelector('[data-slot="skill-usage-agents-overflow"]')?.textContent
    ).toBe('+2')
    expect(secondAvatar?.style.transform).toBe('translate(11px, -50%)')
    expect(secondAvatar?.querySelector('[data-avatar-size="sm"]')).not.toBeNull()

    act(() => trigger?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    expect(secondAvatar?.style.transform).toBe('translate(17px, -50%)')
  })

  it('renders only actual users and navigates for named Specialists', async () => {
    const onOpenSpecialist = vi.fn()
    act(() =>
      root.render(
        <SkillUsageAgents mainEnabled={false} usages={usages} onOpenSpecialist={onOpenSpecialist} />
      )
    )

    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="skill-usage-agents-trigger"]')
        ?.focus()
    )

    const popover = document.body.querySelector<HTMLElement>(
      '[data-slot="skill-usage-agents-popover"]'
    )
    expect(popover?.querySelector('[data-slot="skill-usage-agents-title"]')?.textContent).toBe(
      'Used by Agents and Specialists'
    )
    expect(popover?.textContent).not.toContain('Main Agent')
    expect(popover?.textContent).not.toContain('Unavailable')
    expect(popover?.textContent).not.toContain('Availability')
    expect(popover?.textContent).toContain('Alpha Specialist')
    expect(popover?.textContent).toContain('Delta Specialist')
    expect(popover?.querySelector('.overflow-y-auto')).not.toBeNull()
    const compactMain = document.body.querySelector('[data-slot="skill-usage-main-avatar"]')
    expect(compactMain).toBeNull()
    expect(
      document.body.querySelector('[data-slot="skill-usage-agents-overflow"]')?.textContent
    ).toBe('+1')
    expect(
      Array.from(popover?.querySelectorAll<HTMLButtonElement>('button') ?? []).some((button) =>
        button.textContent?.includes('Main Agent')
      )
    ).toBe(false)

    act(() =>
      popover
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="Open Gamma Specialist in Specialist Settings"]'
        )
        ?.click()
    )
    expect(onOpenSpecialist).toHaveBeenCalledWith(usages[2])
  })

  it('shows Main Agent as a neutral informational row only when enabled', async () => {
    act(() => root.render(<SkillUsageAgents mainEnabled usages={[]} />))

    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="skill-usage-agents-trigger"]')
        ?.focus()
    )

    const popover = document.body.querySelector<HTMLElement>(
      '[data-slot="skill-usage-agents-popover"]'
    )
    expect(popover?.querySelector('[data-slot="skill-usage-agents-title"]')?.textContent).toBe(
      'Used by Agents and Specialists'
    )
    expect(popover?.textContent).toContain('Main Agent')
    expect(popover?.querySelector('[data-slot="skill-usage-main-row"]')).not.toBeNull()
    expect(popover?.querySelector('button')).toBeNull()
  })

  it('dismisses when the Settings surface scrolls but stays open for its own list scroll', async () => {
    act(() => root.render(<SkillUsageAgents mainEnabled usages={usages} />))

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="skill-usage-agents-trigger"]'
    )
    await act(async () => trigger?.focus())

    const usageList = document.body.querySelector<HTMLElement>(
      '[data-slot="skill-usage-agents-popover"] .overflow-y-auto'
    )
    expect(usageList).not.toBeNull()

    act(() => usageList?.dispatchEvent(new Event('scroll')))
    expect(document.body.querySelector('[data-slot="skill-usage-agents-popover"]')).not.toBeNull()

    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="skill-usage-specialist-row"]')
        ?.focus()
    )
    act(() => container.dispatchEvent(new Event('scroll')))
    expect(document.body.querySelector('[data-slot="skill-usage-agents-popover"]')).toBeNull()
    expect(document.activeElement).not.toBe(trigger)
  })

  it('renders no avatar entry when no agent uses the Skill', () => {
    act(() => root.render(<SkillUsageAgents mainEnabled={false} usages={[]} />))

    expect(document.body.querySelector('[data-slot="skill-usage-agents-trigger"]')).toBeNull()
  })

  it('describes the shared avatar stack as Connector availability when requested', () => {
    act(() =>
      root.render(
        <SkillUsageAgents resourceKind="Connector" mainEnabled usages={usages.slice(0, 1)} />
      )
    )

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="skill-usage-agents-trigger"]'
    )
    expect(trigger?.dataset.resourceKind).toBe('connector')
    expect(trigger?.getAttribute('aria-label')).toBe('View Connector availability for 2 agents')
  })
})
