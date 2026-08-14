// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
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
    })
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
})
