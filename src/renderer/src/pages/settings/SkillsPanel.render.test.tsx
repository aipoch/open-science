// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentHomeSkillView, SkillImportPreviewContent } from '../../../../shared/settings'
import { SkillsPanel } from './SkillsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { openRadixMenu } from './test-utils'

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
    setConversationSkillImportEnabled: vi.fn().mockResolvedValue(undefined),
    createSkill: vi.fn().mockResolvedValue(undefined),
    updateSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    importSkill: vi.fn().mockResolvedValue({ status: 'imported', id: 'imported-foo', skills: [] }),
    importSkillZip: vi
      .fn()
      .mockResolvedValue({ status: 'imported', id: 'imported-zip', skills: [] }),
    importSkillZipBatch: vi.fn().mockResolvedValue({
      results: [{ subPath: '', status: 'imported', id: 'imported-zip' }],
      skills: []
    }),
    previewSkillZip: vi.fn().mockResolvedValue({
      previews: [
        {
          subPath: '',
          name: 'Bundled',
          description: 'From a bundle',
          metadata: { license: 'MIT' },
          body: '# Bundled body',
          files: ['SKILL.md'],
          alreadyImported: false
        }
      ],
      skipped: []
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
    }),
    previewGitHubSkill: vi.fn().mockResolvedValue({
      name: 'Foo',
      description: 'Remote preview',
      sourceLabel: 'github.com/acme/skills/pack/foo',
      metadata: { license: 'MIT' },
      body: '# Remote body',
      files: ['SKILL.md']
    }),
    listAgentHomeSkills: vi.fn().mockResolvedValue([
      {
        source: 'agents',
        slug: 'shared',
        name: 'Shared',
        description: 'Shared agent skill',
        alreadyImported: false
      },
      {
        source: 'claude',
        slug: 'claude-alpha',
        name: 'Claude Alpha',
        description: 'Claude-specific skill',
        alreadyImported: false
      },
      {
        source: 'agents',
        slug: 'existing',
        name: 'Existing',
        description: 'Already copied',
        alreadyImported: true
      }
    ]),
    previewAgentHomeSkill: vi.fn().mockResolvedValue({
      name: 'Shared',
      description: 'Shared agent skill',
      sourceLabel: '~/.agents/skills/shared',
      metadata: { author: 'Ada' },
      body: '# Installed body',
      files: ['SKILL.md', 'references/guide.md']
    }),
    importAgentHomeSkills: vi.fn().mockResolvedValue({
      results: [
        {
          source: 'agents',
          slug: 'shared',
          status: 'imported',
          id: 'imported-shared'
        }
      ],
      skills: []
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

const pasteValue = (label: string, value: string): void => {
  const field = document.body.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)
  field?.setSelectionRange(0, field.value.length)
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? value : '') }
  })
  act(() => field?.dispatchEvent(event))
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
    expect(document.body.querySelectorAll('[role="switch"]')).toHaveLength(4)
    expect(document.body.querySelectorAll('[data-slot="switch"]')).toHaveLength(4)
    const alphaSwitch = document.body.querySelector<HTMLElement>('[aria-label="Toggle Alpha"]')
    const betaSwitch = document.body.querySelector<HTMLElement>('[aria-label="Toggle Beta"]')
    expect(alphaSwitch?.getAttribute('data-state')).toBe('checked')
    expect(alphaSwitch?.className).toContain('data-[state=checked]:bg-primary')
    expect(alphaSwitch?.className).toContain('ml-1')
    expect(alphaSwitch?.className).toContain('mr-3')
    expect(betaSwitch?.getAttribute('data-state')).toBe('unchecked')
    expect(
      alphaSwitch?.querySelector<HTMLElement>('[data-slot="switch-thumb"]')?.className
    ).toContain('data-[state=checked]:translate-x')
    expect(document.body.querySelectorAll('[data-slot="settings-list-row"]')).toHaveLength(3)
    expect(document.body.textContent).toContain('Add skill')
    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )
    expect(addSkill?.getAttribute('data-slot')).toBe('button')
    expect(addSkill?.getAttribute('data-variant')).toBe('outline')
    expect(addSkill?.className).toContain('bg-card')
    expect(alphaSwitch?.className).toContain('motion-reduce:transition-none')
  })

  it('shows the default-on conversation import preference and lets the user disable it', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Conversation imports')
    expect(document.body.textContent).toContain(
      'Choose what conversations can import into Open Science.'
    )
    expect(document.body.textContent).toContain('Skill packages')
    expect(document.body.textContent).toContain('ask before importing them')
    const section = document.body.querySelector<HTMLElement>(
      '[data-slot="settings-section"][aria-label="Conversation imports"]'
    )
    const row = section?.querySelector<HTMLElement>('[data-slot="settings-row"]')
    expect(section?.className).toContain('pb-4')
    expect(row?.className).toContain('min-h-0')
    expect(row?.querySelector('.line-clamp-2')).not.toBeNull()
    const toggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle conversation Skill imports"]'
    )
    expect(toggle?.getAttribute('data-state')).toBe('checked')

    act(() => toggle?.click())
    expect(useSettingsStore.getState().setConversationSkillImportEnabled).toHaveBeenCalledWith(
      false
    )
  })

  it('toggles a skill and navigates to its detail on row click', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    act(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Alpha"]')?.click()
    )
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

    const edit = document.body.querySelector<HTMLButtonElement>('[aria-label="Edit Mine"]')
    const remove = document.body.querySelector<HTMLButtonElement>('[aria-label="Delete Mine"]')
    expect(edit?.getAttribute('data-slot')).toBe('button')
    expect(remove?.getAttribute('data-slot')).toBe('button')
    expect(edit?.getAttribute('data-size')).toBe('icon-sm')
    expect(remove?.getAttribute('data-size')).toBe('icon-sm')
    expect(edit?.getAttribute('data-state')).toBe('closed')
    expect(remove?.getAttribute('data-state')).toBe('closed')

    act(() => remove?.click())
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenCalledWith('personal-mine')
  })

  it('always offers installed-skill import, including for other frameworks', () => {
    useSettingsStore.setState({ agentFrameworkId: 'opencode' })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )
    openRadixMenu(addSkill)

    expect(document.body.textContent).toContain('Import installed skills')
    expect(document.body.textContent).toContain('Scan global skill folders')
  })

  it('hides installed-skill import when the desktop bridge is unavailable', () => {
    act(() => {
      root.render(
        <SkillsPanel
          view={{ kind: 'list' }}
          onNavigate={vi.fn()}
          canImportInstalledSkills={false}
        />
      )
    })
    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )
    openRadixMenu(addSkill)

    expect(document.body.textContent).not.toContain('Import installed skills')
  })
})

describe('SkillsPanel (sub-views)', () => {
  it('preserves imported frontmatter metadata when saving an edited skill', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          id: 'personal-mine',
          name: 'Mine',
          description: 'Custom',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true,
          body: '# Body',
          metadata: { author: 'Ada', license: 'MIT', category: 'research' },
          references: []
        })
      }
    }

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'edit', id: 'personal-mine' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().updateSkill).toHaveBeenCalledWith({
      id: 'personal-mine',
      name: 'Mine',
      description: 'Custom',
      body: '# Body',
      metadata: { author: 'Ada', license: 'MIT', category: 'research' },
      references: []
    })
  })

  it('saves the current frontmatter metadata after replacing editor content', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          id: 'personal-mine',
          name: 'Mine',
          description: 'Custom',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true,
          body: '# Old body',
          metadata: { author: 'Ada', license: 'MIT' },
          references: []
        })
      }
    }

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'edit', id: 'personal-mine' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    pasteValue(
      'Skill body',
      [
        '---',
        'name: Mine',
        'description: Custom',
        'author: Grace',
        'tags:',
        '  - analysis',
        '  - writing',
        '---',
        '# New body'
      ].join('\n')
    )

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().updateSkill).toHaveBeenCalledWith({
      id: 'personal-mine',
      name: 'Mine',
      description: 'Custom',
      body: '# New body',
      metadata: { author: 'Grace', tags: 'analysis, writing' },
      references: []
    })
  })

  it('consumes metadata-only frontmatter without replacing the existing identity', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          id: 'personal-mine',
          name: 'Mine',
          description: 'Custom',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true,
          body: '# Old body',
          metadata: { author: 'Old author' },
          references: []
        })
      }
    }

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'edit', id: 'personal-mine' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    pasteValue('Skill body', ['---', 'author: Ada', 'license: MIT', '---', '# New body'].join('\n'))

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().updateSkill).toHaveBeenCalledWith({
      id: 'personal-mine',
      name: 'Mine',
      description: 'Custom',
      body: '# New body',
      metadata: { author: 'Ada', license: 'MIT' },
      references: []
    })
  })

  it('preserves existing metadata through ordinary body edits and exposes a clear action', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          id: 'personal-mine',
          name: 'Mine',
          description: 'Custom',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true,
          body: '# Old body',
          metadata: { author: 'Old author', license: 'MIT' },
          references: []
        })
      }
    }

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'edit', id: 'personal-mine' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    setValue('Skill body', '# Plain replacement')

    expect(document.body.querySelector('[aria-label="Skill metadata"]')?.textContent).toContain(
      'Old author'
    )
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Clear skill metadata"]')
    ).not.toBeNull()

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().updateSkill).toHaveBeenCalledWith({
      id: 'personal-mine',
      name: 'Mine',
      description: 'Custom',
      body: '# Plain replacement',
      metadata: { author: 'Old author', license: 'MIT' },
      references: []
    })
  })

  it('clears existing metadata only through the explicit clear action', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          id: 'personal-mine',
          name: 'Mine',
          description: 'Custom',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true,
          body: '# Body',
          metadata: { author: 'Ada', license: 'MIT' },
          references: []
        })
      }
    }

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'edit', id: 'personal-mine' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Clear skill metadata"]')?.click()
    )

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: undefined })
    )
  })

  it('syncs identity edits made in visible imported frontmatter', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })
    pasteValue(
      'Skill body',
      ['---', 'name: Original', 'description: Before', 'author: Ada', '---', '# Body'].join('\n')
    )
    setValue(
      'Skill body',
      ['---', 'name: Revised', 'description: After', 'author: Ada', '---', '# Body'].join('\n')
    )

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'Revised',
      description: 'After',
      body: '# Body',
      metadata: { author: 'Ada' },
      slug: 'revised',
      references: []
    })
  })

  it('preserves a leading YAML block authored as ordinary skill body content', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })
    setValue('Skill name', 'YAML Example')
    const body = ['---', 'example: literal documentation', '---', '# Instructions'].join('\n')
    setValue('Skill body', body)

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'YAML Example',
      description: '',
      body,
      metadata: undefined,
      slug: 'yaml-example',
      references: []
    })
  })

  it('creates a skill from the create view and returns to the list', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={onNavigate} />)
    })

    expect(document.body.textContent).toContain('Identity')
    expect(
      document.body.querySelector('[aria-label="Skill description"]')?.getAttribute('data-slot')
    ).toBe('textarea')
    expect(
      document.body.querySelector('[aria-label="Skill body"]')?.getAttribute('data-slot')
    ).toBe('textarea')
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

  it('preserves frontmatter metadata pasted into the create editor', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })

    const pasted = [
      '---',
      'name: Pasted Skill',
      'description: Pasted description',
      'author: Ada',
      'category: research',
      '---',
      '# Body'
    ].join('\n')
    pasteValue('Skill body', pasted)
    expect(
      document.body.querySelector<HTMLTextAreaElement>('[aria-label="Skill body"]')?.value
    ).toBe(pasted)
    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'Pasted Skill',
      description: 'Pasted description',
      body: '# Body',
      metadata: { author: 'Ada', category: 'research' },
      slug: 'pasted-skill',
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

  it('opens and closes a GitHub candidate preview without changing its selection', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    setValue('GitHub skill URL or repo', 'acme/skills')
    const runScan = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Preview'
    )
    await act(async () => {
      runScan?.click()
      await Promise.resolve()
    })

    const checkbox = document.body.querySelector<HTMLInputElement>('[aria-label="Select Foo"]')
    expect(checkbox?.checked).toBe(true)

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Foo"]')?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().previewGitHubSkill).toHaveBeenCalledWith(
      'https://github.com/acme/skills/tree/main/pack/foo'
    )
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Remote body')
    expect(checkbox?.checked).toBe(true)

    act(() => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click()
    })
    expect(checkbox?.checked).toBe(true)
    act(() => checkbox?.click())
    expect(checkbox?.checked).toBe(false)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('invalidates a pending GitHub candidate preview when a new scan replaces the list', async () => {
    let finishOldPreview: (value: SkillImportPreviewContent) => void = () => undefined
    const oldPreview = new Promise<SkillImportPreviewContent>((resolve) => {
      finishOldPreview = resolve
    })
    useSettingsStore.setState({
      scanRepoSkills: vi
        .fn()
        .mockResolvedValueOnce({
          skills: [
            {
              name: 'Old',
              path: 'old',
              url: 'https://github.com/acme/old/tree/main/old',
              alreadyImported: false
            }
          ]
        })
        .mockResolvedValueOnce({
          skills: [
            {
              name: 'New',
              path: 'new',
              url: 'https://github.com/acme/new/tree/main/new',
              alreadyImported: false
            }
          ]
        }),
      previewGitHubSkill: vi.fn().mockReturnValue(oldPreview)
    })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    const scanButton = (): HTMLButtonElement | undefined =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Preview'
      )

    setValue('GitHub skill URL or repo', 'acme/old')
    await act(async () => {
      scanButton()?.click()
      await Promise.resolve()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Old"]')?.click()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    setValue('GitHub skill URL or repo', 'acme/new')
    await act(async () => {
      scanButton()?.click()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      finishOldPreview({
        name: 'Old',
        description: 'Stale preview',
        sourceLabel: 'github.com/acme/old/old',
        metadata: {},
        body: '# Stale body',
        files: ['SKILL.md']
      })
      await oldPreview
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Stale body')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('preselects available installed skills and batch-imports the checked rows', async () => {
    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Import installed skills')
    expect(document.body.textContent).toContain('~/.agents/skills')
    expect(document.body.textContent).toContain('~/.claude/skills')
    expect(document.body.textContent).toContain('Import selected (2)')
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Existing"]')?.disabled
    ).toBe(true)

    act(() => {
      document.body.querySelector<HTMLInputElement>('[aria-label="Select Claude Alpha"]')?.click()
    })
    expect(document.body.textContent).toContain('Import selected (1)')

    const importSelected = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Import selected'))
    await act(async () => {
      importSelected?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().importAgentHomeSkills).toHaveBeenCalledWith([
      { source: 'agents', slug: 'shared' }
    ])
  })

  it('advertises only the shared installed-skill source for OpenCode', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      listAgentHomeSkills: vi.fn().mockResolvedValue([])
    })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('~/.agents/skills')
    expect(document.body.textContent).not.toContain('~/.claude/skills')
    expect(document.body.textContent).not.toContain('~/.codex/skills')
  })

  it('invalidates installed-skill rows while a framework-switch rescan is pending', async () => {
    let finishCodexScan: (skills: []) => void = () => undefined
    const pendingCodexScan = new Promise<[]>((resolve) => {
      finishCodexScan = resolve
    })
    const listAgentHomeSkills = vi
      .fn()
      .mockResolvedValueOnce([
        {
          source: 'claude',
          slug: 'claude-alpha',
          name: 'Claude Alpha',
          description: 'Claude-specific skill',
          alreadyImported: false
        }
      ])
      .mockReturnValueOnce(pendingCodexScan)
    useSettingsStore.setState({ agentFrameworkId: 'claude-code', listAgentHomeSkills })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Claude Alpha')

    await act(async () => {
      useSettingsStore.setState({ agentFrameworkId: 'codex' })
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('Claude Alpha')
    expect(document.body.textContent).toContain('Scanning…')
    const importSelected = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Import selected'))
    expect(importSelected === undefined || importSelected.disabled).toBe(true)

    await act(async () => {
      finishCodexScan([])
      await pendingCodexScan
    })
  })

  it('does not restore cached rows when switching back before the new scan finishes', async () => {
    const pendingScan = new Promise<AgentHomeSkillView[]>(() => undefined)
    const listAgentHomeSkills = vi
      .fn()
      .mockResolvedValueOnce([
        {
          source: 'claude',
          slug: 'claude-alpha',
          name: 'Claude Alpha',
          description: 'Claude-specific skill',
          alreadyImported: false
        }
      ])
      .mockReturnValue(pendingScan)
    useSettingsStore.setState({ agentFrameworkId: 'claude-code', listAgentHomeSkills })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Claude Alpha')

    await act(async () => {
      useSettingsStore.setState({ agentFrameworkId: 'codex' })
      await Promise.resolve()
    })
    expect(listAgentHomeSkills).toHaveBeenCalledTimes(2)

    act(() => useSettingsStore.setState({ agentFrameworkId: 'claude-code' }))

    expect(document.body.textContent).not.toContain('Claude Alpha')
    expect(document.body.textContent).toContain('Scanning…')
  })

  it('ignores an older manual rescan that finishes after a framework switch', async () => {
    const finishScans: Array<(skills: AgentHomeSkillView[]) => void> = []
    const listAgentHomeSkills = vi.fn(
      () =>
        new Promise<AgentHomeSkillView[]>((resolve) => {
          finishScans.push(resolve)
        })
    )
    useSettingsStore.setState({ agentFrameworkId: 'claude-code', listAgentHomeSkills })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
    })
    expect(listAgentHomeSkills).toHaveBeenCalledTimes(1)
    await act(async () => {
      finishScans[0]([
        {
          source: 'claude',
          slug: 'claude-alpha',
          name: 'Claude Alpha',
          description: 'Claude-specific skill',
          alreadyImported: false
        }
      ])
      await Promise.resolve()
      await Promise.resolve()
    })
    const rescan = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Rescan'
    )
    expect(rescan).toBeDefined()
    act(() => rescan?.click())
    expect(listAgentHomeSkills).toHaveBeenCalledTimes(2)

    await act(async () => {
      useSettingsStore.setState({ agentFrameworkId: 'codex' })
      await Promise.resolve()
    })
    expect(listAgentHomeSkills).toHaveBeenCalledTimes(3)
    await act(async () => {
      finishScans[2]([
        {
          source: 'codex',
          slug: 'codex-beta',
          name: 'Codex Beta',
          description: 'Codex-specific skill',
          alreadyImported: false
        }
      ])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Codex Beta')

    await act(async () => {
      finishScans[1]([
        {
          source: 'claude',
          slug: 'stale-claude',
          name: 'Stale Claude',
          description: 'Late result',
          alreadyImported: false
        }
      ])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Codex Beta')
    expect(document.body.textContent).not.toContain('Stale Claude')
    expect(document.body.textContent).not.toContain('Scanning…')
  })

  it('opens and closes an installed candidate preview without changing its selection', async () => {
    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const checkbox = document.body.querySelector<HTMLInputElement>('[aria-label="Select Shared"]')
    expect(checkbox?.checked).toBe(true)

    const preview = document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Shared"]')
    await act(async () => {
      preview?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().previewAgentHomeSkill).toHaveBeenCalledWith({
      source: 'agents',
      slug: 'shared'
    })
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Installed body')
    expect(checkbox?.checked).toBe(true)

    act(() => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click()
    })
    expect(checkbox?.checked).toBe(true)

    act(() => checkbox?.click())
    expect(checkbox?.checked).toBe(false)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('invalidates a pending installed preview when a rescan replaces the list', async () => {
    let finishOldPreview: (value: SkillImportPreviewContent) => void = () => undefined
    const oldPreview = new Promise<SkillImportPreviewContent>((resolve) => {
      finishOldPreview = resolve
    })
    const listAgentHomeSkills = vi
      .fn()
      .mockResolvedValueOnce([
        {
          source: 'agents',
          slug: 'old',
          name: 'Old installed',
          description: 'Old framework',
          alreadyImported: false
        }
      ])
      .mockResolvedValueOnce([
        {
          source: 'agents',
          slug: 'new',
          name: 'New installed',
          description: 'New framework',
          alreadyImported: false
        }
      ])
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      listAgentHomeSkills,
      previewAgentHomeSkill: vi.fn().mockReturnValue(oldPreview)
    })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'import-agent-home' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Preview Old installed"]')
        ?.click()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    const rescan = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Rescan'
    )
    await act(async () => {
      rescan?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      finishOldPreview({
        name: 'Old installed',
        description: 'Stale preview',
        sourceLabel: '~/.agents/skills/old',
        metadata: {},
        body: '# Stale installed body',
        files: ['SKILL.md']
      })
      await oldPreview
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Stale installed body')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
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
    expect(document.body.textContent).toContain('Name exists')
    expect(useSettingsStore.getState().createSkill).not.toHaveBeenCalled()
  })
})
