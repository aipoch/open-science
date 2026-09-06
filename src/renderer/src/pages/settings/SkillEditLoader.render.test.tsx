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
  etag: 'loaded-version',
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

it('submits the loaded etag and retains the draft on a stale-save rejection', async () => {
  const onDone = vi.fn()
  const updateSkill = vi
    .fn()
    .mockRejectedValue(new Error('This Skill changed. Reload it before saving.'))
  useSettingsStore.setState({ updateSkill })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getSkillDetail: vi.fn().mockResolvedValue({ ...detail, etag: 'loaded-version' })
    }
  }
  await act(async () => {
    root.render(<SkillEditLoader skillId={detail.id} onDone={onDone} />)
  })
  const body = container.querySelector<HTMLTextAreaElement>('[aria-label="Skill body"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      body,
      'My unsaved draft'
    )
    body.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Save'
  )!
  expect(save).toBeDefined()
  await act(async () => {
    save.click()
  })
  expect
    .soft(updateSkill)
    .toHaveBeenCalledWith(
      expect.objectContaining({ etag: 'loaded-version', body: 'My unsaved draft' })
    )
  expect(body.value).toBe('My unsaved draft')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Review Skill changes')
  expect(onDone).not.toHaveBeenCalled()
  expect(save.disabled).toBe(false)
})

const clickButton = async (label: string): Promise<void> => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label
  )
  expect(button, label).toBeDefined()
  await act(async () => {
    button!.click()
  })
}

const editBody = async (value: string): Promise<void> => {
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Skill body"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const latest = {
  ...detail,
  etag: 'latest-version',
  body: 'Newer body',
  description: 'Newer description',
  references: [{ path: 'new.csv', sizeBytes: 10 }]
}
const conflictError = new Error('This Skill changed. Reload it before saving.')

const mountConflict = async (): Promise<{
  getSkillDetail: ReturnType<typeof vi.fn>
  updateSkill: ReturnType<typeof vi.fn>
  onDone: ReturnType<typeof vi.fn>
}> => {
  const getSkillDetail = vi.fn().mockResolvedValueOnce(detail).mockResolvedValue(latest)
  const updateSkill = vi.fn().mockRejectedValueOnce(conflictError).mockResolvedValue(undefined)
  const onDone = vi.fn()
  useSettingsStore.setState({ updateSkill })
  ;(window as unknown as { api: unknown }).api = { settings: { getSkillDetail } }
  await act(async () => {
    root.render(<SkillEditLoader skillId={detail.id} onDone={onDone} />)
  })
  await editBody('My draft')
  await clickButton('Save')
  return { getSkillDetail, updateSkill, onDone }
}

it('shows both versions and reference names without replacing the draft on conflict', async () => {
  const { updateSkill, onDone } = await mountConflict()
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog?.textContent).toContain('My draft')
  expect(dialog?.textContent).toContain('Newer body')
  expect(dialog?.textContent).toContain('new.csv')
  await clickButton('Keep editing')
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Skill body"]')!.value).toBe(
    'My draft'
  )
  expect(updateSkill).toHaveBeenCalledOnce()
  expect(onDone).not.toHaveBeenCalled()
})

it('overwrites only after explicit review using the latest etag', async () => {
  const { updateSkill, onDone } = await mountConflict()
  await clickButton('Overwrite with my draft')
  expect(updateSkill).toHaveBeenLastCalledWith(
    expect.objectContaining({ etag: 'latest-version', body: 'My draft', references: [] })
  )
  expect(onDone).toHaveBeenCalledOnce()
})

it('loads the reviewed latest version only on explicit choice', async () => {
  const { updateSkill } = await mountConflict()
  await clickButton('Load latest version')
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Skill body"]')!.value).toBe(
    'Newer body'
  )
  expect(container.textContent).toContain('new.csv')
  await clickButton('Save')
  expect(updateSkill).toHaveBeenLastCalledWith(
    expect.objectContaining({
      etag: 'latest-version',
      body: 'Newer body',
      references: [{ path: 'new.csv', dataBase64: undefined }]
    })
  )
})

it('requires review again when the resource changes after the overwrite review', async () => {
  const { getSkillDetail, updateSkill, onDone } = await mountConflict()
  updateSkill.mockRejectedValueOnce(conflictError)
  getSkillDetail.mockResolvedValueOnce({ ...latest, etag: 'third-version', body: 'Changed again' })
  await clickButton('Overwrite with my draft')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Changed again')
  expect(onDone).not.toHaveBeenCalled()
  await clickButton('Overwrite with my draft')
  expect(updateSkill).toHaveBeenLastCalledWith(
    expect.objectContaining({ etag: 'third-version', body: 'My draft' })
  )
  expect(onDone).toHaveBeenCalledOnce()
})

it('retains the draft when loading the latest version fails and permits another save attempt', async () => {
  const getSkillDetail = vi
    .fn()
    .mockResolvedValueOnce(detail)
    .mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValue(latest)
  useSettingsStore.setState({ updateSkill: vi.fn().mockRejectedValue(conflictError) })
  ;(window as unknown as { api: unknown }).api = { settings: { getSkillDetail } }
  await act(async () => {
    root.render(<SkillEditLoader skillId={detail.id} onDone={vi.fn()} />)
  })
  await editBody('My draft')
  await clickButton('Save')
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Skill body"]')!.value).toBe(
    'My draft'
  )
  expect(container.querySelector('[role=alert]')?.textContent).toContain('read failed')
  await clickButton('Save')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Newer body')
})

it('does not let the editor fall back to an unconditional save when detail has no etag', async () => {
  const updateSkill = vi.fn()
  useSettingsStore.setState({ updateSkill })
  ;(window as unknown as { api: unknown }).api = {
    settings: { getSkillDetail: vi.fn().mockResolvedValue({ ...detail, etag: undefined }) }
  }
  await act(async () => {
    root.render(<SkillEditLoader skillId={detail.id} onDone={vi.fn()} />)
  })
  expect(container.textContent).toContain('Open Science could not load this Skill.')
  expect(updateSkill).not.toHaveBeenCalled()
})
