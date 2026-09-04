// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import type { SkillView } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'

import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { scrollToMessage } = vi.hoisted(() => ({ scrollToMessage: vi.fn() }))

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ scrollToMessage })
}))

const SKILL_LOAD_ACTIVITY: ToolActivity = {
  id: 'activity-skill-load-1',
  kind: 'tool',
  title: 'mcp__skills__load_skill',
  providerToolName: 'mcp__skills__load_skill',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1,
  rawInput: { skill: 'mcp-pubmed' },
  toolContent: [
    {
      type: 'content',
      content: {
        type: 'text',
        text: 'Base directory for this skill: /skills/mcp-pubmed\n\n# mcp-pubmed\n\nSearch PubMed.'
      }
    }
  ]
}

describe('WorkspaceActivityGroup row toggling', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    scrollToMessage.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    useSettingsStore.setState({ skills: [], skillsLoaded: false })
    vi.clearAllMocks()
  })

  it('leaves bottom-follow mode before a row expansion changes the group height', async () => {
    const onToggleRow = vi.fn()

    await act(async () => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-skill-1',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            title: '',
            activities: [SKILL_LOAD_ACTIVITY]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{}}
          onToggleRow={onToggleRow}
        />
      )
    })

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')

    expect(chip).not.toBeNull()

    await act(async () => {
      chip?.click()
    })

    expect(scrollToMessage).toHaveBeenCalledWith('group-skill-1', {
      align: 'nearest',
      behavior: 'auto'
    })
    expect(onToggleRow).toHaveBeenCalledWith('activity-skill-load-1', true)
    // The bottom-follow escape must happen before the expansion state changes.
    expect(scrollToMessage.mock.invocationCallOrder[0]).toBeLessThan(
      onToggleRow.mock.invocationCallOrder[0]
    )
  })

  it('restores the scroll offset when the mode escape itself moves the viewport', async () => {
    const onToggleRow = vi.fn()
    const viewport = document.createElement('div')
    viewport.dataset.slot = 'message-scroller-viewport'
    document.body.appendChild(viewport)
    viewport.appendChild(container)
    // Simulate the primitive scrolling to reveal a taller-than-viewport group on align:'nearest'.
    viewport.scrollTop = 120
    scrollToMessage.mockImplementation(() => {
      viewport.scrollTop = 0
    })

    await act(async () => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-skill-1',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            title: '',
            activities: [SKILL_LOAD_ACTIVITY]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{}}
          onToggleRow={onToggleRow}
        />
      )
    })

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')

    await act(async () => {
      chip?.click()
    })

    expect(scrollToMessage).toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(120)
    expect(onToggleRow).toHaveBeenCalledWith('activity-skill-load-1', true)

    viewport.remove()
  })

  it('routes a documentless load_skill row to the catalog/IPC skill row, not the generic JSON details', async () => {
    // Claude-reported skill loads arrive WITHOUT any payload (main strips it): the row must still
    // expand into the SKILL.md document resolved by invocation name, never the raw input JSON.
    const documentless: ToolActivity = {
      ...SKILL_LOAD_ACTIVITY,
      id: 'activity-skill-load-2',
      title: 'Load skill: mcp-pubmed',
      providerToolName: 'Skill',
      toolContent: undefined
    }
    const catalogSkill: SkillView = {
      id: 'imported-mcp-pubmed',
      name: 'mcp-pubmed',
      displayName: 'mcp-pubmed',
      description: 'Search PubMed',
      source: 'imported',
      updatedAt: '2026-08-27T00:00:00Z',
      enabled: true
    }
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = vi.fn().mockResolvedValue({
      ...catalogSkill,
      body: '# mcp-pubmed\n\nResolved document.',
      references: [],
      packageFiles: []
    })
    window.api = { settings: { getSkillDetail } } as unknown as Window['api']

    await act(async () => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-skill-2',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            title: '',
            activities: [documentless]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-skill-load-2': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    expect(getSkillDetail).toHaveBeenCalledWith('imported-mcp-pubmed')

    const panel = container.querySelector('[data-testid="skill-load-details"]')

    expect(panel?.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(container.textContent).not.toContain('"skill"')
  })
})
