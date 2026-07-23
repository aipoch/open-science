import { describe, expect, it } from 'vitest'

import type { ChatMessage, ToolActivity } from '@/stores/session-store'
import type { ConversationItem } from './workspace-conversation-items'
import {
  formatActivityGroupTitle,
  formatStepCount,
  getRenderableActivityEntries,
  groupConversationItems,
  isSearchActivity
} from './workspace-tool-activity-groups'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Hello',
  status: 'complete',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const messageItem = (message: ChatMessage): ConversationItem => ({
  id: message.id,
  type: 'message',
  createdAt: message.createdAt,
  sortIndex: message.sortIndex ?? 0,
  message
})

const activityItem = (activity: ToolActivity): ConversationItem => ({
  id: `activity-${activity.id}`,
  type: 'activity',
  createdAt: activity.createdAt,
  sortIndex: activity.sortIndex,
  activity
})

// The ToolSearch wrapper row that can precede concrete search entries.
const toolSearchWrapper = (overrides: Partial<ToolActivity> = {}): ToolActivity =>
  createActivity({ id: 'tool-search-wrapper', title: 'ToolSearch', ...overrides })

// A quoted, provider-less fetch row that ToolSearch emits as a concrete search query.
const inferredSearchRow = (overrides: Partial<ToolActivity> = {}): ToolActivity =>
  createActivity({
    id: 'tool-search-query',
    title: '"open science repositories"',
    toolKind: 'fetch',
    status: 'in_progress',
    ...overrides
  })

describe('groupConversationItems', () => {
  it('collapses consecutive activities into a single group', () => {
    const grouped = groupConversationItems([
      activityItem(createActivity({ id: 'a1', sortIndex: 1 })),
      activityItem(createActivity({ id: 'a2', sortIndex: 2 })),
      activityItem(createActivity({ id: 'a3', sortIndex: 3 }))
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].type).toBe('activity-group')
    if (grouped[0].type === 'activity-group') {
      expect(grouped[0].id).toBe('activity-group-a1')
      expect(grouped[0].activities.map((activity) => activity.id)).toEqual(['a1', 'a2', 'a3'])
    }
  })

  it('splits activity groups at message boundaries', () => {
    const grouped = groupConversationItems([
      activityItem(createActivity({ id: 'a1', sortIndex: 1 })),
      messageItem(createMessage({ id: 'm1', sortIndex: 2 })),
      activityItem(createActivity({ id: 'a2', sortIndex: 3 })),
      activityItem(createActivity({ id: 'a3', sortIndex: 4 }))
    ])

    expect(grouped.map((item) => item.type)).toEqual([
      'activity-group',
      'message',
      'activity-group'
    ])
    const [firstGroup, , secondGroup] = grouped
    if (firstGroup.type === 'activity-group') {
      expect(firstGroup.activities.map((activity) => activity.id)).toEqual(['a1'])
    }
    if (secondGroup.type === 'activity-group') {
      expect(secondGroup.activities.map((activity) => activity.id)).toEqual(['a2', 'a3'])
    }
  })
})

describe('formatActivityGroupTitle', () => {
  it('emits ordered, pluralized clauses for a mixed group', () => {
    const activities = [
      createActivity({ id: 'edit-1', toolKind: 'edit' }),
      createActivity({ id: 'cmd-1', toolKind: 'execute' }),
      createActivity({ id: 'cmd-2', toolKind: 'execute' }),
      createActivity({ id: 'read-1', toolKind: 'read' })
    ]

    // command precedes read precedes edit in ACTIVITY_CATEGORY_ORDER regardless of input order.
    expect(formatActivityGroupTitle(activities)).toBe('Ran 2 commands, read a file, edited a file')
  })

  it('falls back to a generic title when no activities match', () => {
    expect(formatActivityGroupTitle([])).toBe('Ran a tool')
  })

  it('drops the synthetic ToolSearch wrapper once concrete searches exist', () => {
    const title = formatActivityGroupTitle([toolSearchWrapper(), inferredSearchRow()])

    expect(title).toBe('Ran a search')
  })

  it('keeps the tool-search wrapper category when no concrete searches exist', () => {
    expect(formatActivityGroupTitle([toolSearchWrapper()])).toBe('Ran a tool search')
  })

  // categorizeActivity is not exported; exercise its branches through the single-clause title.
  it('categorizes representative tools through the header clause', () => {
    const cases: Array<[Partial<ToolActivity>, string]> = [
      [{ providerToolName: 'websearch' }, 'Ran a search'],
      [{ providerToolName: 'mcp__open-science-notebook__notebook_execute' }, 'Ran a notebook cell'],
      // Codex/gpt bridge underscore-sanitizes the server name; still categorized as a notebook cell.
      [{ providerToolName: 'mcp__open_science_notebook__notebook_execute' }, 'Ran a notebook cell'],
      [{ providerToolName: 'skill' }, 'Loaded a skill'],
      [{ providerToolName: 'save_artifacts' }, 'Saved a file'],
      [{ providerToolName: 'manage_packages' }, 'Managed an environment'],
      [{ providerToolName: 'request_network_access' }, 'Made a call'],
      [{ providerToolName: 'bash' }, 'Ran a command'],
      [{ toolKind: 'execute' }, 'Ran a command'],
      [{ toolKind: 'edit' }, 'Edited a file'],
      [{ toolKind: 'read' }, 'Read a file'],
      [{ toolKind: 'fetch' }, 'Fetched a page'],
      [{}, 'Ran a tool']
    ]

    for (const [overrides, expected] of cases) {
      expect(formatActivityGroupTitle([createActivity(overrides)])).toBe(expected)
    }
  })
})

describe('isSearchActivity and search counting', () => {
  it('detects the concrete WebSearch provider tool', () => {
    const activity = createActivity({ providerToolName: 'websearch' })

    expect(isSearchActivity(activity, [activity], 0)).toBe(true)
  })

  it('does not treat a quoted row as a search without an earlier wrapper', () => {
    const activity = inferredSearchRow()

    expect(isSearchActivity(activity, [activity], 0)).toBe(false)
  })

  it('infers a quoted search row that follows a ToolSearch wrapper', () => {
    const activities = [toolSearchWrapper(), inferredSearchRow()]

    expect(isSearchActivity(activities[1], activities, 1)).toBe(true)
  })
})

describe('getRenderableActivityEntries', () => {
  it('drops the ToolSearch wrapper once concrete searches exist', () => {
    const activities = [toolSearchWrapper(), inferredSearchRow()]

    const rendered = getRenderableActivityEntries(activities)

    expect(rendered.map((entry) => entry.activity.id)).toEqual(['tool-search-query'])
    expect(rendered[0].activityIndex).toBe(1)
  })

  it('keeps every entry when there are no concrete searches', () => {
    const activities = [toolSearchWrapper(), createActivity({ id: 'read-1', toolKind: 'read' })]

    const rendered = getRenderableActivityEntries(activities)

    expect(rendered.map((entry) => entry.activity.id)).toEqual(['tool-search-wrapper', 'read-1'])
  })
})

describe('formatStepCount', () => {
  it('summarizes step totals and flags failures', () => {
    expect(
      formatStepCount([
        createActivity({ id: 's1' }),
        createActivity({ id: 's2', status: 'failed' }),
        createActivity({ id: 's3' })
      ])
    ).toBe('3 steps · 1 failed')
  })

  it('uses the singular label for a single step', () => {
    expect(formatStepCount([createActivity({ id: 's1' })])).toBe('1 step')
  })

  it('omits the failed clause when nothing failed', () => {
    expect(formatStepCount([createActivity({ id: 's1' }), createActivity({ id: 's2' })])).toBe(
      '2 steps'
    )
  })
})
