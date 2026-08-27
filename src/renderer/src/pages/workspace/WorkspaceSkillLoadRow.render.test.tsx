// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import { WorkspaceSkillLoadRow } from './WorkspaceSkillLoadRow'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: 'mcp__skills__load_skill',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

describe('WorkspaceSkillLoadRow', () => {
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
    vi.clearAllMocks()
  })

  const renderRow = async (isExpanded: boolean): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <WorkspaceSkillLoadRow
          activity={createActivity({ providerToolName: 'mcp__skills__load_skill' })}
          skillName="mcp-pubmed"
          markdown={'# mcp-pubmed\n\nSearch **PubMed** articles.'}
          isExpanded={isExpanded}
          onToggle={() => {}}
        />
      )
    })
  }

  it('renders the loaded SKILL.md as markdown in a capped white sheet when expanded', async () => {
    await renderRow(true)

    const chip = container.querySelector('[data-testid="tool-chip"]')

    expect(chip?.textContent).toContain('Skill')
    expect(chip?.textContent).toContain('mcp-pubmed')

    const panel = container.querySelector('[data-testid="skill-load-details"]')

    expect(panel).not.toBeNull()

    const sheet = panel?.querySelector('div')

    expect(sheet?.className).toContain('max-h-[320px]')
    expect(sheet?.className).toContain('overflow-y-auto')
    expect(sheet?.className).toContain('bg-bg-000')
    expect(sheet?.className).toContain('shadow-card')
    expect(sheet?.className).not.toContain('border')

    expect(panel?.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(panel?.textContent).toContain('Search')
    expect(panel?.textContent).toContain('PubMed')
    expect(panel?.textContent).not.toContain('**')
  })

  it('keeps the markdown sheet hidden while collapsed', async () => {
    await renderRow(false)

    expect(container.querySelector('[data-testid="skill-load-details"]')).toBeNull()
    expect(container.querySelector('[data-testid="tool-chip"]')?.textContent).toContain('Skill')
  })
})
