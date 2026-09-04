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
    expect(panel?.querySelector('.shadow-sheet')).not.toBeNull()
    expect(container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain('Skill')
    expect(container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain(
      'mcp-pubmed'
    )
  })

  it('resolves on mount but keeps the document hidden while collapsed', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# mcp-pubmed')

    await renderRow(false)

    // Resolution is eager — the row must know whether ANY source provides the skill before it can
    // decide between the expandable and the compact presentation — but the body stays hidden.
    expect(getSkillDetail).toHaveBeenCalledWith('imported-mcp-pubmed')
    expect(container.querySelector('[data-testid="skill-load-details"]')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
  })

  it('resolves the document through the main-process resolver when the skill is unlisted', async () => {
    useSettingsStore.setState({ skills: [], skillsLoaded: true })
    const resolveSkillDocument = vi.fn().mockResolvedValue({
      name: 'mcp-pubmed',
      body: '# mcp-pubmed\n\nConnector document.'
    })
    window.api = { settings: { resolveSkillDocument } } as unknown as Window['api']

    await renderRow(true)

    expect(resolveSkillDocument).toHaveBeenCalledWith({ name: 'mcp-pubmed' })

    const panel = container.querySelector('[data-testid="skill-load-details"]')

    expect(panel?.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(panel?.textContent).toContain('Connector document.')
  })

  it('parses the imperative Load skill title variant', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# mcp-pubmed')

    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceSkillActivityRow
          activity={createActivity({
            providerToolName: 'Skill',
            title: 'Load skill: mcp-pubmed'
          })}
          isExpanded={true}
          onToggle={() => {}}
        />
      )
    })

    expect(getSkillDetail).toHaveBeenCalledWith('imported-mcp-pubmed')
    expect(container.querySelector('[data-testid="skill-load-details"]')).not.toBeNull()
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

  it('offers a retry when the catalog fetch fails', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValue({ body: '# mcp-pubmed\n\nRecovered.' })
    window.api = { settings: { getSkillDetail } } as unknown as Window['api']

    await renderRow(true)

    const retry = container.querySelector('[data-testid="skill-load-details"] button')

    expect(retry?.textContent).toBe('Retry')

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(getSkillDetail).toHaveBeenCalledTimes(2)

    const panel = container.querySelector('[data-testid="skill-load-details"]')

    expect(panel?.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(panel?.textContent).toContain('Recovered.')
  })
})
