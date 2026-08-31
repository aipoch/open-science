// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { SkillEditLoader } from './SkillEditor'

let container: HTMLDivElement
let root: Root

const detail = {
  id: 'personal-alpha',
  name: 'alpha',
  displayName: 'Alpha',
  description: 'Alpha description.',
  source: 'personal' as const,
  updatedAt: '2026-08-30T00:00:00.000Z',
  enabled: true,
  body: '# Alpha',
  metadata: {},
  references: [],
  packageFiles: [{ path: 'SKILL.md', sizeBytes: 7 }]
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: [],
    updateSkill: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('SkillEditLoader', () => {
  it('leaves loading for a retryable error when detail loading rejects', async () => {
    const getSkillDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error('detail unavailable'))
      .mockResolvedValueOnce(detail)
    ;(window as unknown as { api: unknown }).api = { settings: { getSkillDetail } }

    await act(async () => {
      root.render(<SkillEditLoader skillId="personal-alpha" onDone={vi.fn()} />)
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading…')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Open Science could not load this Skill.'
    )

    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => {
      retry?.click()
      await Promise.resolve()
    })

    expect(getSkillDetail).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Alpha description.')
  })

  it('distinguishes a missing Skill and returns to the Skills list', async () => {
    const onDone = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Error invoking remote method 'settings:get-skill-detail': Error: Unknown skill: personal-alpha"
            )
          )
      }
    }

    await act(async () => {
      root.render(<SkillEditLoader skillId="personal-alpha" onDone={onDone} />)
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'This Skill is no longer available.'
    )
    const back = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Back'
    )
    act(() => back?.click())
    expect(onDone).toHaveBeenCalledOnce()
  })
})
