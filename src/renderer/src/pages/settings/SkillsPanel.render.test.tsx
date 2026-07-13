// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillsPanel } from './SkillsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const seedSkills = [
  {
    id: 'a',
    name: 'Alpha',
    description: 'First',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'b',
    name: 'Beta',
    description: 'Second',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: false
  },
  {
    id: 'personal-mine',
    name: 'Mine',
    description: 'Custom',
    source: 'personal' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  }
]

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: seedSkills,
    loadSkills: vi.fn().mockResolvedValue(undefined),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    createSkill: vi.fn().mockResolvedValue(undefined),
    updateSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    importSkill: vi.fn().mockResolvedValue({ status: 'imported', id: 'imported-foo', skills: [] }),
    importSkillZip: vi
      .fn()
      .mockResolvedValue({ status: 'imported', id: 'imported-zip', skills: [] }),
    previewSkillZip: vi.fn().mockResolvedValue({
      name: 'Bundled',
      description: 'From a bundle',
      files: ['SKILL.md'],
      alreadyImported: false
    }),
    scanRepoSkills: vi.fn().mockResolvedValue({
      skills: [
        {
          name: 'Foo',
          path: 'pack/foo',
          url: 'https://github.com/acme/skills/tree/main/pack/foo',
          alreadyImported: false
        }
      ]
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
})

const setValue = (label: string, value: string): void => {
  const field = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )
  const proto =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SkillsPanel (list view)', () => {
  it('renders skills grouped by source with one toggle each and an Add skill control', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Featured')
    expect(document.body.textContent).toContain('Personal')
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).toContain('Mine')
    expect(document.body.querySelectorAll('[role="switch"]')).toHaveLength(3)
    expect(document.body.textContent).toContain('Add skill')
  })

  it('toggles a skill and navigates to its detail on row click', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    act(() => document.body.querySelector<HTMLButtonElement>('[role="switch"]')?.click())
    expect(useSettingsStore.getState().setSkillEnabled).toHaveBeenCalledWith('a', false)

    const alphaRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Alpha')
    )
    act(() => alphaRow?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'detail', id: 'a' })
  })

  it('filters the list by the search query', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    setValue('Search skills', 'beta')
    expect(document.body.textContent).toContain('Beta')
    expect(document.body.textContent).not.toContain('Alpha')
  })

  it('deletes a personal skill from its row control', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    act(() => document.body.querySelector<HTMLButtonElement>('[aria-label="Delete Mine"]')?.click())
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenCalledWith('personal-mine')
  })
})

describe('SkillsPanel (sub-views)', () => {
  it('creates a skill from the create view and returns to the list', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={onNavigate} />)
    })

    expect(document.body.textContent).toContain('Identity')
    setValue('Skill name', 'My New Skill')
    setValue('Skill body', '# Body')

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'My New Skill',
      description: '',
      body: '# Body',
      slug: 'my-new-skill',
      references: []
    })
  })

  it('renders the GitHub import view with a Preview-first flow', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Import from GitHub')
    // The standalone single-URL "Import" button is gone; only Preview starts the flow.
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.some((button) => button.textContent?.trim() === 'Preview')).toBe(true)
    expect(buttons.some((button) => button.textContent?.trim() === 'Import')).toBe(false)
  })

  it('scans a repo and batch-imports the selected skills', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub skill URL or repo', 'acme/skills')

    const preview = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Preview'
    )
    await act(async () => {
      preview?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().scanRepoSkills).toHaveBeenCalledWith('acme/skills')
    // The scanned candidate (not already imported) is pre-selected; import it.
    expect(document.body.textContent).toContain('Found 1 skill')

    // Invert toggles the pre-selected candidate off, so nothing is selected.
    const invert = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Invert'
    )
    act(() => invert?.click())
    expect(document.body.textContent).toContain('Import selected (0)')

    // Select all re-selects the candidate.
    const selectAll = document.body.querySelector<HTMLInputElement>('[aria-label="Select all"]')
    act(() => selectAll?.click())
    expect(document.body.textContent).toContain('Import selected (1)')

    const importSelected = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Import selected'))
    await act(async () => {
      importSelected?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().importSkill).toHaveBeenCalledWith(
      'https://github.com/acme/skills/tree/main/pack/foo'
    )
  })

  it('renders the upload view and returns to the create view on "Write from scratch instead"', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'upload' }} onNavigate={onNavigate} />)
    })

    expect(document.body.textContent).toContain('Drag and drop or click to upload')

    const writeInstead = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Write from scratch instead')
    act(() => writeInstead?.click())

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'create' })
  })

  it('parses a dropped .md into a confirm step and flags a same-name duplicate', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'upload' }} onNavigate={vi.fn()} />)
    })

    // Drop a markdown skill whose name collides with a seeded skill ("Alpha").
    const label = document.body.querySelector('label')
    const file = new File(['---\nname: Alpha\ndescription: Dup\n---\nbody'], 'alpha.md', {
      type: 'text/markdown'
    })
    const dropEvent = new Event('drop', { bubbles: true })
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { types: ['Files'], files: [file] } })

    await act(async () => {
      label?.dispatchEvent(dropEvent)
      await file.text()
      await Promise.resolve()
    })

    // The confirm page shows, with the duplicate reminder (parse-first, not imported yet).
    expect(document.body.textContent).toContain('Confirm import')
    expect(document.body.textContent).toContain('Already uploaded')
    expect(document.body.textContent).toContain('A skill named "Alpha" already exists.')
    expect(useSettingsStore.getState().createSkill).not.toHaveBeenCalled()
  })
})
