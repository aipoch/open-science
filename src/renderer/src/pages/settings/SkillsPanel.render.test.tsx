// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentHomeSkillView, SkillImportPreviewContent } from '../../../../shared/settings'
import { SkillsPanel } from './SkillsPanel'
import { SKILL_IMPORT_LIMITS } from '../../../../shared/skill-import-limits'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'

let container: HTMLDivElement
let root: Root

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

const seedSkills = [
  {
    id: 'a',
    name: 'Alpha',
    displayName: 'Alpha',
    description: 'First',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  },
  {
    id: 'b',
    name: 'Beta',
    displayName: 'Beta',
    description: 'Second',
    source: 'featured' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: false
  },
  {
    id: 'personal-mine',
    name: 'Mine',
    displayName: 'Mine',
    description: 'Custom',
    source: 'personal' as const,
    updatedAt: '2026-07-08T00:00:00.000Z',
    enabled: true
  }
]

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
  useNavigationStore.setState({
    view: 'home',
    activeProjectId: undefined,
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingCustomizePrefill: undefined
  })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getGitHubTokenStatus: vi.fn().mockResolvedValue({ configured: false }),
      saveGitHubToken: vi.fn(),
      removeGitHubToken: vi.fn()
    }
  }
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    skills: seedSkills,
    loadSkills: vi.fn().mockResolvedValue(undefined),
    setSkillEnabled: vi.fn().mockResolvedValue(undefined),
    setSkillsEnabled: vi.fn().mockResolvedValue(undefined),
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
  useSpecialistStore.setState({
    items: [
      {
        kind: 'custom',
        id: 'literature-reviewer',
        name: 'LITERATURE_REVIEWER',
        displayName: 'Literature Reviewer',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: ['a', 'b'], connectorIds: [], connectorTools: [] },
        revision: 1
      }
    ],
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

  it('keeps filters and search above right-aligned list actions', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const filters = document.body.querySelector<HTMLElement>('[data-slot="skills-filter-bar"]')
    const actions = document.body.querySelector<HTMLElement>('[data-slot="skills-action-bar"]')
    const manage = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Manage'
    )
    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )

    expect(filters?.querySelector('[aria-label="Filter skills by source"]')).not.toBeNull()
    expect(filters?.querySelector('[aria-label="Filter Skills by agent"]')).not.toBeNull()
    expect(filters?.querySelector('[aria-label="Filter by Tag"]')).not.toBeNull()
    const search = filters?.querySelector<HTMLInputElement>('[aria-label="Search skills"]')
    expect(search?.parentElement?.className).toContain('min-w-56')
    expect(filters?.contains(manage ?? null)).toBe(false)
    expect(filters?.contains(addSkill ?? null)).toBe(false)
    expect(actions?.contains(manage ?? null)).toBe(true)
    expect(actions?.contains(addSkill ?? null)).toBe(true)
    expect(actions?.className).toContain('justify-end')
    expect(filters?.compareDocumentPosition(actions!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps matching import menus in Add skill and the Imported group', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    const importedGroup = document.body.querySelector<HTMLElement>(
      '[data-slot="skills-source-group"][data-source="imported"]'
    )
    expect(importedGroup?.textContent).toContain('Skills you imported into Open Science.')
    expect(importedGroup?.textContent).toContain('No imported skills yet.')

    const importButton = Array.from(
      importedGroup?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.trim() === 'Import')
    expect(importButton?.getAttribute('data-variant')).toBe('outline')
    expect(importButton?.className).toContain('whitespace-nowrap')

    openRadixMenu(importButton)
    const importedGroupItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    )
    expect(importedGroupItems.map((item) => item.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Upload skills'),
        expect.stringContaining('Import from GitHub'),
        expect.stringContaining('Import installed skills')
      ])
    )
    clickRadixMenuItem(
      importedGroupItems.find((item) => item.textContent?.includes('Import from GitHub'))
    )
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'import' })

    const importedDisclosure = importedGroup?.querySelector<HTMLButtonElement>(
      'button[aria-expanded="true"]'
    )
    act(() => importedDisclosure?.click())
    expect(importedGroup?.textContent).not.toContain('No imported skills yet.')
    expect(importedGroup?.contains(importButton ?? null)).toBe(true)

    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )
    openRadixMenu(addSkill)
    const addSkillItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    )
    expect(addSkillItems.map((item) => item.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Upload skills'),
        expect.stringContaining('Import from GitHub'),
        expect.stringContaining('Import installed skills')
      ])
    )
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
    expect(section?.className).toContain('mb-4')
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

  it('shows identity-conflicting Skills without exposing ambiguous actions', () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      skills: [
        {
          id: 'shared-id',
          catalogEntryKey: 'personal:shared-id:0',
          name: 'conflicting',
          displayName: 'Conflicting Skill',
          description: 'Installed directly.',
          source: 'personal',
          updatedAt: '2026-09-02T00:00:00.000Z',
          enabled: true,
          available: false,
          availability: 'identity-conflict'
        }
      ]
    })

    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    expect(document.body.textContent).toContain('Conflicting Skill')
    expect(document.body.textContent).toContain('Identity conflict')
    expect(document.body.querySelector('[aria-label="Actions for Conflicting Skill"]')).toBeNull()
    const toggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle Conflicting Skill"]'
    )
    expect(toggle?.disabled).toBe(true)
    const title = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Conflicting Skill')
    )
    expect(title?.disabled).toBe(true)
    act(() => title?.click())
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('shows a distinct loading state before an empty Skill catalog settles', () => {
    useSettingsStore.setState({
      skills: [],
      loadSkills: vi.fn(() => new Promise<void>(() => undefined))
    })

    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('Loading Skills…')
    expect(document.body.textContent).not.toContain('No skills match your search.')
    expect(document.body.textContent).not.toContain('No imported skills yet.')
  })

  it('shows a retryable error instead of an empty catalog when Skill loading fails', async () => {
    const loadSkills = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce(undefined)
    useSettingsStore.setState({ skills: [], loadSkills })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Open Science could not load Skills.'
    )
    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => retry?.click())
    expect(loadSkills).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected Skill access change after the optimistic rollback', async () => {
    useSettingsStore.setState({
      setSkillEnabled: vi.fn().mockRejectedValue(new Error('write failed'))
    })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle Alpha"]')?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save this setting. The previous value was restored.'
    )
  })

  it('opens bulk management as a dedicated Skills sub-view', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    const manage = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Manage'
    )
    act(() => manage?.click())

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'manage' })
    expect(document.body.querySelector('[aria-label="Select Mine"]')).toBeNull()
  })

  it('filters the list by the search query', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    setValue('Search skills', 'beta')
    expect(document.body.textContent).toContain('Beta')
    expect(document.body.textContent).not.toContain('Alpha')
  })

  it('combines Main Agent and Specialists in the All Agents/Specialists filter', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.querySelector('[aria-label="Filter Skills by scope"]')).toBeNull()
    const agentFilter = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter Skills by agent"]'
    )
    expect(agentFilter?.textContent).toContain('All Agents/Specialists')

    openRadixMenu(agentFilter)
    clickRadixMenuItem(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (option) => option.textContent === 'Main Agent'
      )
    )
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).toContain('Mine')
    expect(document.body.textContent).not.toContain('Beta')

    openRadixMenu(agentFilter)
    clickRadixMenuItem(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (option) => option.textContent === 'Literature Reviewer'
      )
    )
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.textContent).toContain('Beta')
    expect(document.body.textContent).not.toContain('Mine')
  })

  it('shows compact agent stacks without the verbose scope line', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const alphaRow = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="settings-list-row"]')
    ).find((row) => row.textContent?.includes('Alpha'))
    const betaRow = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="settings-list-row"]')
    ).find((row) => row.textContent?.includes('Beta'))

    const alphaAgents = alphaRow?.querySelector<HTMLButtonElement>(
      '[data-slot="skill-usage-agents-trigger"]'
    )
    const betaAgents = betaRow?.querySelector<HTMLButtonElement>(
      '[data-slot="skill-usage-agents-trigger"]'
    )
    expect(alphaAgents?.dataset.mainEnabled).toBe('true')
    expect(betaAgents?.dataset.mainEnabled).toBe('false')
    expect(alphaRow?.textContent).not.toContain('Shared with Main')
    expect(betaRow?.textContent).not.toContain('Specialist only')
    expect(alphaRow?.textContent).not.toContain('Main Agent')
    expect(betaRow?.textContent).not.toContain('Main Agent')
    expect(alphaRow?.textContent).toContain('Used by')
    expect(betaRow?.textContent).toContain('Used by')
    expect(alphaRow?.querySelector('[aria-label="Toggle Alpha"]')?.getAttribute('data-state')).toBe(
      'checked'
    )
    expect(betaRow?.querySelector('[aria-label="Toggle Beta"]')?.getAttribute('data-state')).toBe(
      'unchecked'
    )
    const tagMenu = alphaRow?.querySelector('[aria-label="Manage Tags"]')
    const toggle = alphaRow?.querySelector('[aria-label="Toggle Alpha"]')
    expect(tagMenu).not.toBeNull()
    expect(toggle).not.toBeNull()
    expect(tagMenu!.compareDocumentPosition(toggle!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await act(async () => alphaAgents?.focus())
    expect(
      document.body.querySelector('[data-slot="skill-usage-agents-popover"]')?.textContent
    ).toContain('Literature Reviewer')
    expect(
      document.body.querySelector('[data-slot="skill-usage-agents-popover"]')?.textContent
    ).toContain('Main Agent')
  })

  it('edits and deletes a personal skill from its row action menu', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    })

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    const edit = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'Edit'
    )
    clickRadixMenuItem(edit)
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'personal-mine' })

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    const remove = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.trim() === 'Delete')
    clickRadixMenuItem(remove)
    expect(useSettingsStore.getState().deleteSkill).toHaveBeenCalledWith('personal-mine')
  })

  it('exports imported and personal Skills but never built-in Skills', async () => {
    const exportSkill = vi.fn().mockResolvedValue({ saved: true })
    ;(window as unknown as { api: unknown }).api = { settings: { exportSkill } }
    useSettingsStore.setState({
      skills: [
        ...seedSkills,
        {
          id: 'imported-shared',
          name: 'Shared',
          displayName: 'Shared',
          description: 'Imported',
          source: 'imported',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true
        }
      ]
    })

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.querySelector('[aria-label="Actions for Alpha"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Actions for Shared"]')).not.toBeNull()
    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
          (item) => item.textContent?.trim() === 'Export'
        )
      )
      await Promise.resolve()
    })
    expect(exportSkill).toHaveBeenCalledWith({ id: 'personal-mine' })
    const status = document.body.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Exported Mine.')
    expect(status?.closest('[data-slot="settings-list-row"]')?.textContent).toContain('Mine')
  })

  it('re-enables Skill export after the user cancels Save As', async () => {
    const exportSkill = vi.fn().mockResolvedValue({ saved: false })
    ;(window as unknown as { api: unknown }).api = { settings: { exportSkill } }
    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    const exportOnce = async (): Promise<void> => {
      openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
      await act(async () => {
        clickRadixMenuItem(
          Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
            (item) => item.textContent?.trim() === 'Export'
          )
        )
        await Promise.resolve()
      })
    }
    await exportOnce()

    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for Mine"]')?.disabled
    ).toBe(false)
    await exportOnce()
    expect(exportSkill).toHaveBeenCalledTimes(2)
  })

  it('serializes Skill exports across row action menus', async () => {
    let finishExport: ((result: { saved: boolean }) => void) | undefined
    const exportSkill = vi.fn(
      (): Promise<{ saved: boolean }> =>
        new Promise((resolve) => {
          finishExport = resolve
        })
    )
    ;(window as unknown as { api: unknown }).api = { settings: { exportSkill } }
    useSettingsStore.setState({
      skills: [
        ...seedSkills,
        {
          id: 'imported-shared',
          name: 'Shared',
          displayName: 'Shared',
          description: 'Imported',
          source: 'imported',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true
        }
      ]
    })
    await act(async () => root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />))

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
          (item) => item.textContent?.trim() === 'Export'
        )
      )
      await Promise.resolve()
    })

    expect(exportSkill).toHaveBeenCalledOnce()
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for Mine"]')?.disabled
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for Shared"]')?.disabled
    ).toBe(true)

    await act(async () => finishExport?.({ saved: false }))
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for Mine"]')?.disabled
    ).toBe(false)
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for Shared"]')?.disabled
    ).toBe(false)
  })

  it('hides Skill export when the desktop bridge is unavailable', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).some(
        (item) => item.textContent?.trim() === 'Export'
      )
    ).toBe(false)
  })

  it('shows a Settings error when Skill export fails', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        exportSkill: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Error invoking remote method 'settings:export-skill': Error: Archive could not be written."
            )
          )
      }
    }
    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
          (item) => item.textContent?.trim() === 'Export'
        )
      )
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Archive could not be written.'
    )
  })

  it('shows the shared Specialist reference guard when direct deletion is rejected', async () => {
    useSettingsStore.setState({
      deleteSkill: vi.fn().mockRejectedValue(new Error('Skill is referenced by rna-reviewer.'))
    })
    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    await act(async () => {
      clickRadixMenuItem(
        Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
          (item) => item.textContent?.trim() === 'Delete'
        )
      )
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Skill is referenced by rna-reviewer.'
    )
  })

  it('explains and blocks deletion for a Skill still owned by a Specialist', async () => {
    const deleteSkill = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ deleteSkill })
    useSpecialistStore.setState((state) => ({
      items: state.items.map((item) =>
        item.kind === 'custom'
          ? {
              ...item,
              selectedCapabilities: {
                ...item.selectedCapabilities,
                skillIds: item.selectedCapabilities.skillIds.filter(
                  (skillId) => skillId !== 'personal-mine'
                )
              },
              ownedSkillIds: ['personal-mine']
            }
          : item
      )
    }))

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Actions for Mine"]'))
    const remove = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Delete'))
    expect(remove?.getAttribute('aria-disabled')).toBe('true')
    expect(remove?.textContent?.trim()).toBe('Delete')
    expect(remove?.querySelector('[data-slot="skill-delete-blocked-tip"]')).not.toBeNull()

    await act(async () => remove?.focus())
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Owned by Literature Reviewer. Delete this Skill when deleting that Specialist.'
    )

    clickRadixMenuItem(remove)
    expect(deleteSkill).not.toHaveBeenCalled()
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

  it('opens a new Skill Creator conversation with the Skill Customize goal', async () => {
    useProjectStore.setState({
      projects: [
        {
          id: 'project-a',
          name: 'Project A',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      isLoaded: true
    })
    const closeSettings = vi.spyOn(useSettingsStore.getState(), 'closeSettings')
    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    })
    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )
    openRadixMenu(addSkill)
    const chat = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Chat with agent')
    )
    await act(async () => chat?.click())

    expect(closeSettings).toHaveBeenCalledOnce()
    expect(useNavigationStore.getState().pendingCustomizePrefill).toMatchObject({
      projectId: 'project-a',
      goal: 'skill'
    })
    closeSettings.mockRestore()
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

    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Skill name"]')?.disabled
    ).toBe(true)
    expect(document.body.querySelector('[aria-label="Skill ID"]')).toBeNull()

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      save?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().updateSkill).toHaveBeenCalledWith({
      id: 'personal-mine',
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
      ['---', 'name: original', 'description: Before', 'author: Ada', '---', '# Body'].join('\n')
    )
    setValue(
      'Skill body',
      ['---', 'name: revised', 'description: After', 'author: Ada', '---', '# Body'].join('\n')
    )

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'revised',
      description: 'After',
      body: '# Body',
      metadata: { author: 'Ada' },
      references: []
    })
  })

  it('uses one Content mode Tab stop and switches mode with ArrowRight', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })

    const radios = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="Content mode"] [role="radio"]'
      )
    )
    const group = document.body.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Content mode"]'
    )
    expect(group?.tabIndex).toBe(0)
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1])

    act(() => {
      group?.focus()
    })
    expect(document.activeElement).toBe(radios[0])
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1])

    await act(async () => {
      radios[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('Upload a SKILL.md or text file')
    expect(document.activeElement).toBe(radios[1])
  })

  it('preserves a leading YAML block authored as ordinary skill body content', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })
    setValue('Skill name', 'yaml-example')
    const body = ['---', 'example: literal documentation', '---', '# Instructions'].join('\n')
    setValue('Skill body', body)

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'yaml-example',
      description: '',
      body,
      metadata: undefined,
      references: []
    })
  })

  it('creates a skill from the create view and returns to the list', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={onNavigate} />)
    })

    const advanced = document.body.querySelector<HTMLButtonElement>(
      'button[aria-controls="skill-advanced-settings"]'
    )
    expect(advanced?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[aria-label="Add reference files"]')).toBeNull()
    expect(
      document.body.querySelector('[aria-label="Skill description"]')?.getAttribute('data-slot')
    ).toBe('textarea')
    expect(
      document.body.querySelector('[aria-label="Skill body"]')?.getAttribute('data-slot')
    ).toBe('textarea')
    expect(document.body.querySelector('[aria-label="Skill ID"]')).toBeNull()
    expect(document.body.querySelectorAll('[data-slot="settings-row"]')).toHaveLength(0)
    for (const label of ['Skill name', 'Skill description', 'Skill body']) {
      expect(
        document.body
          .querySelector(`[aria-label="${label}"]`)
          ?.closest('[data-slot="settings-editor-field"]')
      ).not.toBeNull()
    }
    act(() => advanced?.click())
    expect(advanced?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[aria-label="Add reference files"]')).not.toBeNull()
    setValue('Skill name', 'my-new-skill')
    setValue('Skill body', '# Body')

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    act(() => publish?.click())

    expect(useSettingsStore.getState().createSkill).toHaveBeenCalledWith({
      name: 'my-new-skill',
      description: '',
      body: '# Body',
      references: []
    })
  })

  it('rejects an oversized reference before starting a Base64 read', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })
    setValue('Skill name', 'bounded-reference')
    setValue('Skill body', '# Body')
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-controls="skill-advanced-settings"]')
        ?.click()
    )

    const input = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Add reference files"]'
    )
    const file = new File(['x'], 'too-large.bin')
    Object.defineProperty(file, 'size', { value: SKILL_IMPORT_LIMITS.maxFileBytes + 1 })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')

    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })

    expect(read).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('too-large.bin')
    expect(document.body.textContent).toContain('per-file limit')
    read.mockRestore()
  })

  it('reads references sequentially while disabling Save and reporting progress', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })
    setValue('Skill name', 'sequential-references')
    setValue('Skill body', '# Body')
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-controls="skill-advanced-settings"]')
        ?.click()
    )

    const input = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Add reference files"]'
    )
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]
    Object.defineProperty(input, 'files', { configurable: true, value: files })

    const pending: FileReader[] = []
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
      this: FileReader
    ): void {
      pending.push(this)
    })
    const finishRead = (reader: FileReader, value: string): void => {
      Object.defineProperty(reader, 'result', {
        configurable: true,
        value: `data:application/octet-stream;base64,${value}`
      })
      reader.onload?.call(reader, new ProgressEvent('load') as ProgressEvent<FileReader>)
    }

    try {
      await act(async () => {
        input?.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })

      const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Publish'
      )
      expect(pending).toHaveLength(1)
      expect(input?.disabled).toBe(true)
      expect(publish?.disabled).toBe(true)
      expect(document.body.textContent).toContain('0 / 2')

      await act(async () => {
        finishRead(pending[0], 'YQ==')
        await Promise.resolve()
      })
      expect(pending).toHaveLength(2)
      expect(document.body.textContent).toContain('1 / 2')

      await act(async () => {
        finishRead(pending[1], 'Yg==')
        await Promise.resolve()
      })
      expect(input?.disabled).toBe(false)
      expect(publish?.disabled).toBe(false)
      expect(document.body.textContent).toContain('references/a.txt')
      expect(document.body.textContent).toContain('references/b.txt')
    } finally {
      read.mockRestore()
    }
  })

  it('keeps the editor open and shows a Main-process save failure inline', async () => {
    const createSkill = vi.fn().mockRejectedValue(new Error('Skill package has too many files.'))
    const onNavigate = vi.fn()
    useSettingsStore.setState({ createSkill })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={onNavigate} />)
    })
    setValue('Skill name', 'save-failure')
    setValue('Skill body', '# Body')

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    await act(async () => {
      publish?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Skill package has too many files.'
    )
    expect(document.body.querySelector('[aria-label="Skill name"]')).not.toBeNull()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('shows persisted reference and preserved package file usage in the edit view', async () => {
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
          references: [{ path: 'guide.md', sizeBytes: 4096 }],
          packageFiles: [
            { path: 'SKILL.md', sizeBytes: 128 },
            { path: '.source.json', sizeBytes: SKILL_IMPORT_LIMITS.maxFileBytes },
            { path: '.specialist-package.json', sizeBytes: SKILL_IMPORT_LIMITS.maxFileBytes },
            { path: 'references/guide.md', sizeBytes: 4096 },
            { path: 'references/guides/deep.md', sizeBytes: 1024 },
            { path: 'scripts/run.sh', sizeBytes: 2048 }
          ]
        })
      }
    }

    await act(async () => {
      root.render(<SkillsPanel view={{ kind: 'edit', id: 'personal-mine' }} onNavigate={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      document.body.querySelector('[aria-label="Skill package usage"]')?.textContent
    ).toContain(`References: 1 / ${SKILL_IMPORT_LIMITS.maxFiles - 3}`)
    expect(document.body.textContent).toContain('references/guide.md')
    expect(document.body.textContent).toContain('references/guides/deep.md')
    expect(document.body.textContent).toContain('scripts/run.sh')
    expect(document.body.textContent).toContain('4 KB')
    expect(document.body.textContent).toContain('2 KB')
    expect(document.body.textContent).not.toContain('.source.json')
    expect(document.body.textContent).not.toContain('.specialist-package.json')
  })

  it('includes preserved package files in the total budget before enabling Save', async () => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        getSkillDetail: vi.fn().mockResolvedValue({
          id: 'personal-budgeted',
          name: 'budgeted',
          description: 'Custom',
          source: 'personal',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true,
          body: '# Body',
          references: [],
          packageFiles: [
            { path: 'SKILL.md', sizeBytes: 128 },
            { path: 'scripts/large-a.bin', sizeBytes: SKILL_IMPORT_LIMITS.maxFileBytes },
            { path: 'assets/large-b.bin', sizeBytes: SKILL_IMPORT_LIMITS.maxFileBytes },
            { path: 'data/large-c.bin', sizeBytes: 30 * 1024 * 1024 }
          ]
        })
      }
    }

    await act(async () => {
      root.render(
        <SkillsPanel view={{ kind: 'edit', id: 'personal-budgeted' }} onNavigate={vi.fn()} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    expect(document.body.textContent).toContain(
      'The skill package exceeds the 128 MB total size limit.'
    )
    expect(document.body.textContent).toContain('scripts/large-a.bin')
    expect(document.body.textContent).toContain('assets/large-b.bin')
    expect(save?.disabled).toBe(true)
  })

  it('requires the personal skill name to be the immutable lowercase identity', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })
    setValue('Skill name', 'My New Skill')
    setValue('Skill body', '# Body')

    const publish = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Publish'
    )
    expect(document.body.textContent).toContain(
      'Use up to 64 lowercase letters, numbers, and single hyphens.'
    )
    expect(publish?.disabled).toBe(true)
    expect(useSettingsStore.getState().createSkill).not.toHaveBeenCalled()
  })

  it('preserves frontmatter metadata pasted into the create editor', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'create' }} onNavigate={vi.fn()} />)
    })

    const pasted = [
      '---',
      'name: pasted-skill',
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
      name: 'pasted-skill',
      description: 'Pasted description',
      body: '# Body',
      metadata: { author: 'Ada', category: 'research' },
      references: []
    })
  })

  it('renders the GitHub import view with a find-first flow', () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Import from GitHub')
    // One action handles both repository discovery and direct repository scanning.
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.some((button) => button.textContent?.trim() === 'Find skills')).toBe(true)
    expect(buttons.some((button) => button.textContent?.trim() === 'Import')).toBe(false)
    const importedHeading = Array.from(document.body.querySelectorAll('h3')).find(
      (heading) => heading.textContent?.trim() === 'Imported skills'
    )
    const importedSection = importedHeading?.closest('section')
    expect(importedSection?.textContent).toContain('No imported skills yet')
    expect(importedSection?.textContent).toContain('Repos you import from will appear here.')
    expect(importedSection?.querySelector('svg')).not.toBeNull()
    expect(importedHeading?.nextElementSibling?.className).toContain('items-center')
  })

  it('shows row-level scan progress, then collapses repository results after scanning', async () => {
    let finishScan: (result: {
      skills: Array<{
        name: string
        path: string
        url: string
        alreadyImported: boolean
      }>
    }) => void = () => undefined
    const pendingScan = new Promise<{
      skills: Array<{
        name: string
        path: string
        url: string
        alreadyImported: boolean
      }>
    }>((resolve) => {
      finishScan = resolve
    })
    useSettingsStore.setState({
      scanRepoSkills: vi
        .fn()
        .mockResolvedValueOnce({
          skills: [],
          repositories: [
            {
              fullName: 'hugohe3/ppt-master',
              description: 'Presentation generation skills',
              url: 'https://github.com/hugohe3/ppt-master',
              stars: 42
            }
          ]
        })
        .mockReturnValueOnce(pendingScan)
    })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'ppt master')
    const runSearch = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    await act(async () => {
      runSearch?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Repositories (1)')
    expect(document.body.textContent).toContain('hugohe3/ppt-master')
    expect(document.body.textContent).toContain('42')
    expect(
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Hide repositories"]')
        ?.getAttribute('aria-expanded')
    ).toBe('true')
    const scanRepository = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Scan hugohe3/ppt-master for skills"]'
    )
    act(() => scanRepository?.click())
    const scanningButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Scan hugohe3/ppt-master for skills"]'
    )
    expect(scanningButton?.textContent).toContain('Scanning…')
    expect(scanningButton?.querySelector('.animate-spin')).not.toBeNull()
    expect(
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Hide repositories"]')
        ?.getAttribute('aria-expanded')
    ).toBe('true')

    await act(async () => {
      finishScan({
        skills: [
          {
            name: 'ppt-master',
            path: 'skills/ppt-master',
            url: 'https://github.com/hugohe3/ppt-master/tree/main/skills/ppt-master',
            alreadyImported: false
          }
        ]
      })
      await pendingScan
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().scanRepoSkills).toHaveBeenNthCalledWith(1, 'ppt master')
    expect(useSettingsStore.getState().scanRepoSkills).toHaveBeenNthCalledWith(
      2,
      'hugohe3/ppt-master'
    )
    expect(document.body.textContent).toContain('Repositories')
    expect(document.body.textContent).toContain('Skills in hugohe3/ppt-master')
    expect(document.body.textContent).toContain('ppt-master')
    expect(
      document.body.querySelector('[aria-label="Scan hugohe3/ppt-master for skills"]')
    ).toBeNull()

    act(() => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Show repositories"]')?.click()
    })
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Scan hugohe3/ppt-master for skills"]'
      )?.textContent
    ).toContain('Scanned')

    const selectionControls = document.body.querySelector('[aria-label="Skill selection controls"]')
    expect(selectionControls?.textContent).toContain('Select all')
    expect(selectionControls?.textContent).toContain('Invert selection')
    expect(selectionControls?.textContent).not.toContain('Skills in hugohe3/ppt-master')
  })

  it('renders GitHub search failures in the Settings danger banner', async () => {
    useSettingsStore.setState({
      scanRepoSkills: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'GitHub search is temporarily rate-limited. Try again later or paste an owner/repo reference.'
          )
        )
    })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'slides')
    const runSearch = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    await act(async () => {
      runSearch?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'GitHub search is temporarily rate-limited'
    )
  })

  it('marks an overlength GitHub keyword invalid after bounded main-process validation', async () => {
    useSettingsStore.setState({
      scanRepoSkills: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'GitHub search is limited to 256 characters. Shorten the keywords or paste an owner/repo reference.'
          )
        )
    })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'x'.repeat(257))
    const runSearch = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    await act(async () => {
      runSearch?.click()
      await Promise.resolve()
    })

    const input = document.body.querySelector<HTMLInputElement>(
      '[aria-label="GitHub keyword or repository"]'
    )
    expect(input?.getAttribute('aria-invalid')).toBe('true')
    expect(useSettingsStore.getState().scanRepoSkills).toHaveBeenCalledWith('x'.repeat(257))
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'GitHub search is limited to 256 characters.'
    )
  })

  it('preserves direct scanning for a repository reference longer than the keyword limit', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    const directReference = `acme/skills@${'release-'.repeat(40)}`
    setValue('GitHub keyword or repository', directReference)
    const runScan = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    await act(async () => {
      runScan?.click()
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().scanRepoSkills).toHaveBeenCalledWith(directReference)
    expect(
      document.body
        .querySelector<HTMLInputElement>('[aria-label="GitHub keyword or repository"]')
        ?.getAttribute('aria-invalid')
    ).toBeNull()
  })

  it('keeps the keyword input as the recovery path when search has no matches', async () => {
    useSettingsStore.setState({
      scanRepoSkills: vi.fn().mockResolvedValue({ skills: [], repositories: [] })
    })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'unlikely phrase')
    const runSearch = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    await act(async () => {
      runSearch?.click()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain(
      'No matching Skill repositories found. Try another keyword or paste an owner/repo reference.'
    )
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="GitHub keyword or repository"]')
        ?.value
    ).toBe('unlikely phrase')
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not apply search results after the user edits the in-flight query', async () => {
    let finishSearch: (result: {
      skills: []
      repositories: Array<{
        fullName: string
        description: string | null
        url: string
        stars: number
      }>
    }) => void = () => undefined
    const pendingSearch = new Promise<{
      skills: []
      repositories: Array<{
        fullName: string
        description: string | null
        url: string
        stars: number
      }>
    }>((resolve) => {
      finishSearch = resolve
    })
    useSettingsStore.setState({ scanRepoSkills: vi.fn().mockReturnValue(pendingSearch) })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'slides')
    const runSearch = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    act(() => runSearch?.click())
    const findingButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Finding…')
    expect(findingButton?.querySelector('.animate-spin')).not.toBeNull()
    setValue('GitHub keyword or repository', 'presentations')

    await act(async () => {
      finishSearch({
        skills: [],
        repositories: [
          {
            fullName: 'acme/stale-slides',
            description: null,
            url: 'https://github.com/acme/stale-slides',
            stars: 1
          }
        ]
      })
      await pendingSearch
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('acme/stale-slides')
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="GitHub keyword or repository"]')
        ?.value
    ).toBe('presentations')
  })

  it('scans a repo and batch-imports the selected skills', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'acme/skills')

    const preview = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
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
      (button) => button.textContent?.trim() === 'Invert selection'
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

  it('shows import progress in the batch action instead of a page-level loader', async () => {
    let finishImport: (result: { status: 'imported'; id: string; skills: [] }) => void = () =>
      undefined
    const pendingImport = new Promise<{ status: 'imported'; id: string; skills: [] }>((resolve) => {
      finishImport = resolve
    })
    useSettingsStore.setState({ importSkill: vi.fn().mockReturnValue(pendingImport) })
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })

    setValue('GitHub keyword or repository', 'acme/skills')
    const find = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
    )
    await act(async () => {
      find?.click()
      await Promise.resolve()
    })

    const importSelected = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Import selected (1)')
    act(() => importSelected?.click())

    const importing = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Importing…'
    )
    expect(importing?.querySelector('.animate-spin')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Working with GitHub…')

    await act(async () => {
      finishImport({ status: 'imported', id: 'imported-foo', skills: [] })
      await pendingImport
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Imported 1 skill.')
  })

  it('opens and closes a GitHub candidate preview without changing its selection', async () => {
    act(() => {
      root.render(<SkillsPanel view={{ kind: 'import' }} onNavigate={vi.fn()} />)
    })
    setValue('GitHub keyword or repository', 'acme/skills')
    const runScan = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Find skills'
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
        (button) => button.textContent?.trim() === 'Find skills'
      )

    setValue('GitHub keyword or repository', 'acme/old')
    await act(async () => {
      scanButton()?.click()
      await Promise.resolve()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Preview Old"]')?.click()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

    setValue('GitHub keyword or repository', 'acme/new')
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
