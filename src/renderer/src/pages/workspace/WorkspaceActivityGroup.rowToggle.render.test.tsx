// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import type { SkillView } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'

import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { fetchActivity, fetchResult } from './workspace-web-fetch-test-fixtures'
import { searchActivity, searchResult } from './workspace-web-search-test-fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { stopAutoScroll } = vi.hoisted(() => ({ stopAutoScroll: vi.fn() }))

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMessageScroller: () => ({ stopAutoScroll })
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
    stopAutoScroll.mockReset()
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

  const renderExpandedActivity = (id: string, activity: ToolActivity): Promise<void> =>
    act(async () =>
      root.render(
        <WorkspaceActivityGroup
          group={{
            id,
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [activity]
          }}
          isExpanded
          onToggleGroup={vi.fn()}
          onToggleRow={vi.fn()}
          expansionOverrides={{ [activity.id]: true }}
        />
      )
    )

  it.each([
    ['save_to_inbox', { results: [{ kind: 'candidate', id: 'pending', state: 'pending' }] }, true],
    [
      'save_to_inbox',
      {
        results: [{ kind: 'candidate', id: 'pending', state: 'pending' }],
        failure: { inputIndex: 1, code: 'FAILED', message: 'Failed' }
      },
      true
    ],
    ['acquire_pdf', { status: 'pending-review', candidateId: 'pdf-1' }, true],
    ['acquire_pdf', { status: 'not-found' }, true],
    ['save_to_inbox', { results: [{ kind: 'item', id: 'existing', state: 'present' }] }, true],
    ['save_to_inbox', { openScienceLiteraturePresentation: { savedCount: 1 } }, true],
    ['search_library', { items: [] }, true],
    ['read_library_abstract', {}, true],
    ['read_library_pdf', {}, true],
    ['format_references', {}, true],
    ['format_citation_document', {}, true],
    ['prepare_latex_bundle', {}, true],
    ['unrelated_tool', {}, false]
  ])(
    'expands literature tool %s and respects user collapse (%j)',
    async (tool, result, expanded) => {
      const activity: ToolActivity = {
        ...SKILL_LOAD_ACTIVITY,
        id: 'literature-1',
        title: `mcp__open-science-library__${tool}`,
        providerToolName: `mcp__open-science-library__${tool}`,
        rawInput: {},
        toolContent: [],
        rawOutput: { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      const onToggleRow = vi.fn()
      const renderGroup = (overrides: Record<string, boolean>, groupExpanded = true): ReactNode => (
        <WorkspaceActivityGroup
          group={{
            id: 'literature-group',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            title: '',
            activities: [activity]
          }}
          isExpanded={groupExpanded}
          onToggleGroup={vi.fn()}
          expansionOverrides={overrides}
          onToggleRow={onToggleRow}
        />
      )
      await act(async () => {
        root.render(renderGroup({}))
      })
      const chip = container.querySelector<HTMLButtonElement>('[data-testid="tool-chip"]')!
      expect(chip.getAttribute('aria-expanded')).toBe(String(expanded))
      if (expanded) {
        await act(async () => {
          chip.click()
        })
        expect(onToggleRow).toHaveBeenCalledWith('literature-1', false)
        await act(async () => {
          root.render(renderGroup({ 'literature-1': false }))
        })
        expect(chip.getAttribute('aria-expanded')).toBe('false')
        await act(async () => {
          root.render(renderGroup({}, false))
        })
        expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
      }
    }
  )

  it.each([
    ['completed', JSON.stringify({ ...fetchResult(), schema: 'open-science.web.v2' })],
    ['failed', JSON.stringify({ ...fetchResult(), schema: 'open-science.web.v2' })],
    ['failed', 'MCP error -32603: request transport disconnected'],
    ['completed', 'MCP error -32603: request transport disconnected']
  ] as const)(
    'keeps unsupported fetch output visible through legacy details (%s)',
    async (status, text) => {
      const activity = fetchActivity({
        status,
        toolContent: [
          {
            type: 'content',
            content: { type: 'text', text }
          }
        ]
      })
      await renderExpandedActivity('fetches', activity)
      expect(container.querySelector('[data-testid="tool-web-fetch-details"]')).toBeNull()
      expect(container.querySelector('[data-testid="tool-details"]')).not.toBeNull()
      expect(container.textContent).toContain(text)
      expect(container.textContent).not.toContain('Saved page content is unavailable')
    }
  )

  it('preserves a host SDK error when invalid fetch input contains no URL', async () => {
    const activity = fetchActivity({
      status: 'failed',
      rawInput: {},
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: 'MCP error: invalid arguments' }
        }
      ]
    })
    await renderExpandedActivity('fetches', activity)
    expect(container.querySelector('[data-testid="tool-web-fetch-details"]')).toBeNull()
    expect(container.querySelector('[data-testid="tool-details"]')).not.toBeNull()
    expect(container.textContent).toContain('MCP error: invalid arguments')
  })

  it.each(['cancelled', 'declined', 'permission-closed'] as const)(
    'keeps the authoritative %s fetch row without any envelope',
    async (toolDisposition) => {
      const activity = fetchActivity({
        status: 'failed',
        toolDisposition,
        toolContent: [],
        rawOutput: undefined
      })
      await renderExpandedActivity('fetches', activity)
      const details = container.querySelector('[data-testid="tool-web-fetch-details"]')
      expect(details).not.toBeNull()
      expect(details!.textContent).toContain(
        toolDisposition === 'cancelled'
          ? 'Cancelled'
          : toolDisposition === 'declined'
            ? 'Declined'
            : 'request ended'
      )
      expect(container.querySelector('[data-testid="tool-details"]')).toBeNull()
      expect(container.textContent).not.toContain('Saved page text')
      expect(container.textContent).not.toContain('Saved page content is unavailable')
    }
  )

  it.each([
    ['pending', 'in_progress', undefined],
    ['completed', 'completed', undefined],
    ['unknown envelope', 'failed', 'unknown'],
    ['plain SDK error', 'failed', 'MCP error: transport unavailable'],
    ['cancelled', 'failed', 'cancelled']
  ] as const)(
    'routes built-in search %s with safe legacy fallback',
    async (name, status, payload) => {
      const activity = searchActivity({
        status,
        ...(name === 'pending' || payload === 'cancelled' ? { toolContent: [] } : {}),
        ...(payload === 'cancelled' ? { toolDisposition: 'cancelled' as const } : {}),
        ...(payload && payload !== 'cancelled'
          ? {
              toolContent: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text:
                      payload === 'unknown'
                        ? JSON.stringify({ ...searchResult(), schema: 'open-science.web.v2' })
                        : payload
                  }
                }
              ]
            }
          : {})
      })
      await renderExpandedActivity('searches', activity)
      const isFallback = payload === 'unknown' || payload?.startsWith('MCP')
      expect(Boolean(container.querySelector('[data-testid="tool-search-details"]'))).toBe(
        !isFallback
      )
      if (isFallback) {
        expect(container.querySelector('[data-testid="tool-details"]')).not.toBeNull()
        expect(container.textContent).toContain(
          payload === 'unknown' ? 'open-science.web.v2' : payload!
        )
      } else if (payload === 'cancelled') {
        expect(container.textContent).toContain('Cancelled')
        expect(container.querySelectorAll('[data-testid="web-search-source"]')).toHaveLength(0)
      } else {
        expect(container.textContent).toContain('open science reproducibility')
      }
    }
  )

  it('hides review rows and empty groups while retaining approval wait accounting', async () => {
    const run: ToolActivity = {
      id: 'notebook-run',
      kind: 'tool',
      title: 'Notebook run',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      status: 'completed',
      eventIds: [],
      sortIndex: 1,
      promptMessageId: 'prompt',
      createdAt: 100,
      updatedAt: 1400,
      rawInput: { language: 'python', code: 'print(1)' },
      rawOutput: { status: 'completed', runId: 'run-1' }
    }
    const review: ToolActivity = {
      ...run,
      id: 'app-approval:risk',
      appOwned: true,
      title: 'Review risky code',
      providerToolName: 'Open-Science',
      createdAt: 200,
      updatedAt: 1200,
      rawOutput: undefined,
      rawInput: {
        code: 'os.unlink(path)',
        notebookCodeRisk: {
          runId: 'run-1',
          language: 'python',
          risks: [{ operation: 'os.unlink', source: 'os.unlink(path)', line: 1 }]
        }
      }
    }
    const render = async (activities: ToolActivity[]): Promise<void> => {
      await act(async () =>
        root.render(
          <WorkspaceActivityGroup
            group={{ id: 'runs', type: 'activity-group', createdAt: 100, sortIndex: 1, activities }}
            isExpanded
            onToggleGroup={vi.fn()}
            onToggleRow={vi.fn()}
            expansionOverrides={{ [review.id]: true }}
          />
        )
      )
    }
    await render([run, review])
    expect(container.querySelectorAll('[data-testid="tool-chip"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="notebook-code-review-receipt"]')).toBeNull()
    expect(container.textContent).not.toContain('Code risk review')
    expect(container.textContent).toContain('1 step')
    expect(container.textContent).toContain('300ms')
    expect(container.textContent).not.toContain('ran a tool')
    await render([review])
    expect(container.innerHTML).toBe('')
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

    expect(stopAutoScroll).toHaveBeenCalledWith()
    expect(onToggleRow).toHaveBeenCalledWith('activity-skill-load-1', true)
    // The bottom-follow escape must happen before the expansion state changes.
    expect(stopAutoScroll.mock.invocationCallOrder[0]).toBeLessThan(
      onToggleRow.mock.invocationCallOrder[0]
    )
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
