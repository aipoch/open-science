// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentHomeSkillView } from '../../../../shared/settings'
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
    expect(document.body.querySelectorAll('[data-slot="switch"]')).toHaveLength(3)
    const switches = document.body.querySelectorAll<HTMLElement>('[data-slot="switch"]')
    expect(switches[0]?.getAttribute('data-state')).toBe('checked')
    expect(switches[0]?.className).toContain('data-[state=checked]:bg-primary')
    expect(switches[0]?.className).toContain('ml-1')
    expect(switches[0]?.className).toContain('mr-3')
    expect(switches[1]?.getAttribute('data-state')).toBe('unchecked')
    expect(
      switches[0]?.querySelector<HTMLElement>('[data-slot="switch-thumb"]')?.className
    ).toContain('data-[state=checked]:translate-x')
    expect(document.body.querySelectorAll('[data-slot="settings-list-row"]')).toHaveLength(3)
    expect(document.body.textContent).toContain('Add skill')
    const addSkill = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Add skill')
    )
    expect(addSkill?.getAttribute('data-slot')).toBe('button')
    expect(addSkill?.getAttribute('data-variant')).toBe('outline')
    expect(addSkill?.className).toContain('bg-card')
    expect(switches[0]?.className).toContain('motion-reduce:transition-none')
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
