// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { SkillBulkManageView } from './SkillBulkManageView'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'

let container: HTMLDivElement
let root: Root

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

const skills = [
  {
    id: 'featured-alpha',
    name: 'Alpha',
    displayName: 'Alpha',
    description: 'Featured',
    source: 'featured' as const,
    updatedAt: '2026-08-14T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'imported-team',
    name: 'Team',
    displayName: 'Team',
    description: 'Imported workflow',
    source: 'imported' as const,
    updatedAt: '2026-08-14T00:00:00.000Z',
    enabled: false
  },
  {
    id: 'personal-mine',
    name: 'Mine',
    displayName: 'Mine',
    description: 'Personal workflow',
    source: 'personal' as const,
    updatedAt: '2026-08-14T00:00:00.000Z',
    enabled: true
  }
]

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills,
    loadSkills: vi.fn().mockResolvedValue(undefined),
    setSkillsEnabled: vi.fn(async (ids: string[], enabled: boolean) => {
      useSettingsStore.setState((state) => ({
        skills: state.skills.map((skill) =>
          ids.includes(skill.id) ? { ...skill, enabled } : skill
        )
      }))
    }),
    deleteSkill: vi.fn(async (id: string) => {
      useSettingsStore.setState((state) => ({
        skills: state.skills.filter((skill) => skill.id !== id)
      }))
    })
  })
  useSpecialistStore.setState({
    items: [],
    isLoaded: true,
    load: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

const setSearch = (value: string): void => {
  const input = document.body.querySelector<HTMLInputElement>(
    '[aria-label="Search manageable skills"]'
  )
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )

describe('SkillBulkManageView', () => {
  it('filters manageable Skills by source and status', () => {
    act(() => root.render(<SkillBulkManageView />))

    openRadixMenu(
      document.body.querySelector<HTMLElement>('[aria-label="Filter manageable skills by source"]')
    )
    clickRadixMenuItem(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (option) => option.textContent === 'Imported'
      )
    )
    expect(document.body.textContent).toContain('Team')
    expect(document.body.textContent).not.toContain('Mine')

    openRadixMenu(
      document.body.querySelector<HTMLElement>('[aria-label="Filter manageable skills by source"]')
    )
    clickRadixMenuItem(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (option) => option.textContent === 'All sources'
      )
    )
    openRadixMenu(
      document.body.querySelector<HTMLElement>('[aria-label="Filter manageable skills by status"]')
    )
    clickRadixMenuItem(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (option) => option.textContent === 'Disabled'
      )
    )
    expect(document.body.textContent).toContain('Team')
    expect(document.body.textContent).not.toContain('Mine')
  })

  it('shows only manageable Skills and supports both bulk enable and disable', async () => {
    act(() => root.render(<SkillBulkManageView />))

    expect(document.body.textContent).not.toContain('Alpha')
    expect(document.body.textContent).toContain('Team')
    expect(document.body.textContent).toContain('Mine')
    expect(document.body.querySelector('[aria-label="Select Alpha"]')).toBeNull()

    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select all results"]')?.click()
    )
    expect(document.body.textContent).toContain('2 selected')

    await act(async () => button('Enable selected (2)')?.click())
    expect(useSettingsStore.getState().setSkillsEnabled).toHaveBeenCalledWith(
      ['imported-team', 'personal-mine'],
      true
    )
    expect(button('Selected (2)')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.body.querySelectorAll('[data-skill-status="enabled"]')).toHaveLength(2)

    await act(async () => button('Disable selected (2)')?.click())
    expect(useSettingsStore.getState().setSkillsEnabled).toHaveBeenLastCalledWith(
      ['imported-team', 'personal-mine'],
      false
    )
    expect(document.body.querySelectorAll('[data-skill-status="disabled"]')).toHaveLength(2)
  })

  it('keeps selections across searches and can show every selected Skill together', () => {
    act(() => root.render(<SkillBulkManageView />))

    setSearch('Team')
    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select all results"]')?.click()
    )
    setSearch('Mine')
    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select all results"]')?.click()
    )

    expect(document.body.textContent).not.toContain('Team')
    expect(document.body.textContent).toContain('Mine')
    act(() => button('Selected (2)')?.click())
    expect(document.body.textContent).toContain('Team')
    expect(document.body.textContent).toContain('Mine')

    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select all results"]')?.click()
    )
    expect(document.body.textContent).toContain('1 selected')
    expect(document.body.textContent).toContain('Team')
    expect(document.body.textContent).not.toContain('Mine')

    act(() => button('Clear selection')?.click())
    expect(document.body.textContent).toContain('0 selected')
    expect(button('Selected (0)')?.hasAttribute('disabled')).toBe(true)
  })

  it('keeps the selection and reports which bulk action failed', async () => {
    vi.mocked(useSettingsStore.getState().setSkillsEnabled).mockRejectedValue(
      new Error('Could not update selected Skills.')
    )
    act(() => root.render(<SkillBulkManageView />))
    act(() => document.body.querySelector<HTMLInputElement>('[aria-label="Select Team"]')?.click())

    await act(async () => button('Enable selected (1)')?.click())

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not update selected Skills.'
    )
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Team"]')?.checked
    ).toBe(true)
  })

  it('deletes every selected manageable Skill after confirmation', async () => {
    act(() => root.render(<SkillBulkManageView />))
    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select all results"]')?.click()
    )

    act(() => button('Delete selected (2)')?.click())
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      '2 selected Skills can be deleted.'
    )

    await act(async () => {
      button('Delete 2 Skills')?.click()
      await Promise.resolve()
    })
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenNthCalledWith(1, 'imported-team')
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenNthCalledWith(2, 'personal-mine')
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'Deleted 2 Skills.'
    )
  })

  it('keeps Specialist-owned or referenced Skills protected and selected', async () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'researcher',
          name: 'RESEARCHER',
          displayName: 'Research Specialist',
          description: '',
          systemPrompt: '',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: {
            skillIds: ['personal-mine'],
            connectorIds: [],
            connectorTools: []
          },
          revision: 1
        }
      ]
    })
    act(() => root.render(<SkillBulkManageView />))
    act(() =>
      document.body.querySelector<HTMLInputElement>('[aria-label="Select all results"]')?.click()
    )

    act(() => button('Delete selected (2)')?.click())
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('1 selected Skill can be deleted.')
    expect(dialog?.textContent).toContain('1 protected Skill will be kept.')
    expect(dialog?.textContent).toContain('Research Specialist')

    await act(async () => {
      button('Delete 1 Skill')?.click()
      await Promise.resolve()
    })
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenCalledWith('imported-team')
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Mine"]')?.checked
    ).toBe(true)
  })

  it('uses the project dialog hierarchy for a protected-only deletion impact', () => {
    useSpecialistStore.setState({
      items: [
        {
          kind: 'custom',
          id: 'researcher',
          name: 'RESEARCHER',
          displayName: 'Research Specialist',
          description: '',
          systemPrompt: '',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: {
            skillIds: ['personal-mine'],
            connectorIds: [],
            connectorTools: []
          },
          revision: 1
        }
      ]
    })
    act(() => root.render(<SkillBulkManageView />))
    act(() => document.body.querySelector<HTMLInputElement>('[aria-label="Select Mine"]')?.click())
    act(() => button('Delete selected (1)')?.click())

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const header = dialog?.querySelector<HTMLElement>('[data-slot="skill-bulk-delete-header"]')
    const description = dialog?.querySelector<HTMLElement>(
      '[data-slot="skill-bulk-delete-description"]'
    )
    const primarySummary = dialog?.querySelector<HTMLElement>(
      '[data-slot="skill-bulk-delete-primary-summary"]'
    )
    const protectedSummary = dialog?.querySelector<HTMLElement>(
      '[data-slot="skill-bulk-delete-protected-summary"]'
    )
    const protectedList = dialog?.querySelector<HTMLElement>(
      '[data-slot="skill-bulk-delete-protected-list"]'
    )

    expect(header?.textContent).toBe('Delete selected Skills?')
    expect(header?.contains(description ?? null)).toBe(false)
    expect(description?.textContent).toBe(
      'Deleted Skills are removed from this device and cannot be recovered.'
    )
    expect(primarySummary?.textContent).toBe('0 selected Skills can be deleted.')
    expect(primarySummary?.className).toContain('text-base')
    expect(dialog?.textContent).not.toContain('No selected Skills can be deleted.')
    expect(protectedSummary?.className).toContain('text-base')
    expect(protectedSummary?.className).toBe(primarySummary?.className)
    expect(protectedList?.className).toContain('text-xs')
    expect(protectedList?.textContent).toContain('Mine')
    expect(protectedList?.textContent).toContain('Research Specialist')
  })
})
