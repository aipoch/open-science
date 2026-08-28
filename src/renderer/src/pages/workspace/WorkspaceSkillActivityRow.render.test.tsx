// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import type { SkillView } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'

import { WorkspaceSkillActivityRow } from './WorkspaceSkillActivityRow'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'Loaded skill: mcp-pubmed',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const catalogSkill: SkillView = {
  id: 'imported-mcp-pubmed',
  name: 'mcp-pubmed',
  displayName: 'mcp-pubmed',
  description: 'Search PubMed',
  source: 'imported',
  updatedAt: '2026-08-27T00:00:00Z',
  enabled: true
}

const installSkillDetail = (body: string): ReturnType<typeof vi.fn> => {
  const getSkillDetail = vi.fn().mockResolvedValue({ body })
  window.api = { settings: { getSkillDetail } } as unknown as Window['api']
  return getSkillDetail
}

describe('WorkspaceSkillActivityRow', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    useSettingsStore.setState({ skills: [], skillsLoaded: false })
    vi.clearAllMocks()
  })

  const renderRow = async (isExpanded: boolean): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceSkillActivityRow
          activity={createActivity({ providerToolName: 'skill' })}
          isExpanded={isExpanded}
          onToggle={() => {}}
        />
      )
    })
  }

  it('fetches the catalog SKILL.md on expand and renders it in the white sheet', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# mcp-pubmed\n\nSearch **PubMed** articles.')

    await renderRow(true)

    expect(getSkillDetail).toHaveBeenCalledWith('imported-mcp-pubmed')

    const panel = container.querySelector('[data-testid="skill-load-details"]')

    expect(panel?.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(panel?.querySelector('.shadow-card')).not.toBeNull()
    expect(container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain('Skill')
    expect(container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain(
      'mcp-pubmed'
    )
  })

  it('does not fetch the document while collapsed', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# mcp-pubmed')

    await renderRow(false)

    expect(getSkillDetail).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="skill-load-details"]')).toBeNull()
  })

  it('keeps the compact non-expandable row when the skill is not in the catalog', async () => {
    useSettingsStore.setState({ skills: [], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# unused')

    await renderRow(false)

    const chip = container.querySelector('[data-testid="tool-chip"]')

    expect(chip?.tagName).toBe('DIV')
    expect(chip?.textContent).toContain('Loaded skill: mcp-pubmed')
    expect(getSkillDetail).not.toHaveBeenCalled()
  })
})
