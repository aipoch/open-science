// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

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
})
