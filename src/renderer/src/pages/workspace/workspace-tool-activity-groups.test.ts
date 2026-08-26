import { describe, expect, it } from 'vitest'

import type { ChatMessage, ToolActivity } from '@/stores/session-store'
import { renderer as ko } from '../../../../shared/i18n/locales/ko.json'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ConversationItem } from './workspace-conversation-items'
import {
  formatActivityGroupElapsed,
  formatActivityGroupPresentationTitle,
  formatActivityGroupTitle,
  formatStepCount,
  getActivityGroupElapsedMs,
  getRenderableActivityEntries,
  groupConversationItems,
  isSearchActivity
} from './workspace-tool-activity-groups'
import { i18next } from '@/i18n'

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

const planActivityItem = (activity: ToolActivity): ConversationItem => ({
  id: `plan-activity-${activity.id}`,
  type: 'plan-activity',
  createdAt: activity.createdAt,
  sortIndex: activity.sortIndex,
  activity
})

const compactionActivityItem = (activity: ToolActivity): ConversationItem => ({
  id: `compaction-activity-${activity.id}`,
  type: 'compaction-activity',
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

  it('keeps structured input standalone between adjacent tool groups', () => {
    const grouped = groupConversationItems([
      activityItem(createActivity({ id: 'a1', sortIndex: 1 })),
      activityItem(
        createActivity({
          id: 'ask-1',
          sortIndex: 2,
          elicitation: {
            message: 'Choose one',
            fields: [{ id: 'choice', label: 'Choice', kind: 'text' }],
            state: 'pending'
          }
        })
      ),
      activityItem(createActivity({ id: 'a2', sortIndex: 3 }))
    ])

    expect(grouped.map((item) => item.type)).toEqual([
      'activity-group',
      'activity',
      'activity-group'
    ])
  })

  it('splits adjacent activities at declared group boundaries', () => {
    const grouped = groupConversationItems(
      [
        activityItem(createActivity({ id: 'a1', activityGroupId: 'g1' })),
        activityItem(createActivity({ id: 'a2', activityGroupId: 'g2' }))
      ],
      [
        {
          id: 'g1',
          title: 'Inspect files',
          sortIndex: 1,
          activityIds: ['a1'],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'g2',
          title: 'Apply changes',
          sortIndex: 2,
          activityIds: ['a2'],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    )

    expect(grouped).toEqual([
      expect.objectContaining({ id: 'activity-group-g1', title: 'Inspect files' }),
      expect.objectContaining({ id: 'activity-group-g2', title: 'Apply changes' })
    ])
  })

  it('keeps Plan call records standalone and out of adjacent tool counts', () => {
    const grouped = groupConversationItems([
      activityItem(createActivity({ id: 'read-1', toolKind: 'read', sortIndex: 1 })),
      planActivityItem(
        createActivity({ id: 'plan-1', providerToolName: 'generate_plan', sortIndex: 2 })
      ),
      activityItem(createActivity({ id: 'read-2', toolKind: 'read', sortIndex: 3 }))
    ])

    expect(grouped.map((item) => item.type)).toEqual([
      'activity-group',
      'plan-activity',
      'activity-group'
    ])
    expect(
      grouped
        .filter((item) => item.type === 'activity-group')
        .map((item) => formatStepCount(item.activities))
    ).toEqual(['1 step', '1 step'])
  })

  it('keeps context compaction standalone between adjacent tool groups', () => {
    const compaction = createActivity({ id: 'context-compaction:1', sortIndex: 2 })
    const grouped = groupConversationItems([
      activityItem(createActivity({ id: 'read-1', sortIndex: 1 })),
      compactionActivityItem(compaction),
      activityItem(createActivity({ id: 'read-2', sortIndex: 3 }))
    ])

    expect(grouped.map((item) => item.type)).toEqual([
      'activity-group',
      'compaction-activity',
      'activity-group'
    ])
  })
})

describe('formatActivityGroupTitle', () => {
  it('uses the declared group title when one exists', () => {
    expect(
      formatActivityGroupTitle([createActivity({ id: 'a1' })], 'Inspect the implementation')
    ).toBe('Inspect the implementation')
  })
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

  it('joins Korean activity clauses as consistent sentence fragments', async () => {
    const korean = i18next.createInstance()
    await korean.init({
      lng: 'ko',
      fallbackLng: false,
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      resources: { ko: { translation: ko } }
    })
    const activities = [
      createActivity({ id: 'cmd-1', toolKind: 'execute' }),
      createActivity({ id: 'cmd-2', toolKind: 'execute' }),
      createActivity({ id: 'read-1', toolKind: 'read' }),
      createActivity({ id: 'edit-1', toolKind: 'edit' })
    ]

    expect(formatActivityGroupTitle(activities, undefined, korean.t.bind(korean))).toBe(
      '명령 2개 실행, 파일 읽음, 파일 수정'
    )
  })

  it('falls back to a generic title when no activities match', () => {
    expect(formatActivityGroupTitle([])).toBe('Ran a tool')
  })

  it('recognizes OpenCode Skill titles without provider metadata', () => {
    expect(formatActivityGroupTitle([createActivity({ title: 'Loaded skill: mcp-pubmed' })])).toBe(
      'Loaded a skill'
    )
  })

  it('summarizes a group of load_skill calls as loaded skills', () => {
    const loadSkill = (id: string, skill: string): ToolActivity =>
      createActivity({
        id,
        providerToolName: 'mcp__skills__load_skill',
        title: 'mcp__skills__load_skill',
        rawInput: { skill }
      })

    expect(
      formatActivityGroupTitle([
        loadSkill('skill-1', 'mcp-pubmed'),
        loadSkill('skill-2', 'literature-review'),
        loadSkill('skill-3', 'data-cleaning')
      ])
    ).toBe('Loaded 3 skills')
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
      [
        { providerToolName: 'mcp__open-science-notebook__notebook_execute' },
        'Completed a Notebook run'
      ],
      // Codex/gpt bridge underscore-sanitizes the server name; still categorized as a notebook cell.
      [
        { providerToolName: 'mcp__open_science_notebook__notebook_execute' },
        'Completed a Notebook run'
      ],
      // OpenCode flattens the server/tool boundary to a single underscore.
      [{ providerToolName: 'open-science-notebook_notebook_execute' }, 'Completed a Notebook run'],
      [{ providerToolName: 'skill' }, 'Loaded a skill'],
      [{ providerToolName: 'mcp__skills__load_skill' }, 'Loaded a skill'],
      [{ providerToolName: 'mcp.skills.load_skill' }, 'Loaded a skill'],
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

describe('formatActivityGroupPresentationTitle', () => {
  const notebook = (overrides: Partial<ToolActivity> = {}): ToolActivity =>
    createActivity({
      status: 'in_progress',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      promptMessageId: 'prompt-1',
      ...overrides
    })

  it('separates prepared and waiting Notebook headers without inferring execution', () => {
    expect(formatActivityGroupPresentationTitle([notebook()], undefined, undefined)).toBe(
      'Notebook code shown'
    )
    expect(
      formatActivityGroupPresentationTitle([notebook()], undefined, {
        state: 'pending',
        request: {
          requestId: 'permission-1',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          title: 'Run code',
          options: []
        },
        originatingPromptMessageId: 'prompt-1',
        fingerprint: 'fingerprint-1',
        createdAt: 1
      })
    ).toBe('Waiting for your approval')
  })

  it.each([
    ['timeout', 'Execution limit reached for Notebook run'],
    ['cancelled', 'Cancelled Notebook run'],
    ['interrupted', 'Interrupted Notebook run'],
    ['failed', 'Failed Notebook run']
  ] as const)('preserves the correlated Notebook %s group outcome', (status, expected) => {
    const notebookActivity = notebook({ executionInvocationId: 'invocation-1' })
    const notebookRun: NotebookRunRecord = {
      runId: 'run-1',
      executionInvocationId: 'invocation-1',
      cellId: 'cell-1',
      source: 'agent',
      kernelKind: 'python',
      script: 'print(1)',
      status,
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }

    expect(
      formatActivityGroupPresentationTitle(
        [notebookActivity],
        undefined,
        undefined,
        new Map([['run-1', notebookRun]])
      )
    ).toBe(expected)
  })

  it('leaves non-Notebook group titles unchanged', () => {
    expect(
      formatActivityGroupPresentationTitle(
        [createActivity({ toolKind: 'read' })],
        undefined,
        undefined
      )
    ).toBe('Read a file')
  })

  it('does not describe a closed ordinary tool request as executed', () => {
    expect(
      formatActivityGroupPresentationTitle(
        [createActivity({ status: 'in_progress', toolDisposition: 'permission-closed' })],
        undefined,
        undefined
      )
    ).toBe('Tool request ended')
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

  it('does not count a closed Notebook permission as an execution failure', () => {
    expect(
      formatStepCount([
        createActivity({
          status: 'failed',
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          toolDisposition: 'permission-closed'
        })
      ])
    ).toBe('1 step')
  })

  it('counts skills instead of steps when every activity is a Skill load', () => {
    const loadSkill = (id: string): ToolActivity =>
      createActivity({
        id,
        providerToolName: 'mcp__skills__load_skill',
        title: 'mcp__skills__load_skill',
        rawInput: { skill: id }
      })

    expect(formatStepCount([loadSkill('skill-1')])).toBe('1 skill')
    expect(formatStepCount([loadSkill('skill-1'), loadSkill('skill-2')])).toBe('2 skills')
  })

  it('keeps the step count for a mixed group containing Skill loads', () => {
    expect(
      formatStepCount([
        createActivity({ id: 'skill-1', providerToolName: 'mcp__skills__load_skill' }),
        createActivity({ id: 'read-1', toolKind: 'read' })
      ])
    ).toBe('2 steps')
  })
})

describe('activity group elapsed time', () => {
  it('uses milliseconds for short work and compact larger units', () => {
    expect(formatActivityGroupElapsed(412.9)).toBe('412ms')
    expect(formatActivityGroupElapsed(12_900)).toBe('12s')
    expect(formatActivityGroupElapsed(192_000)).toBe('3m 12s')
    expect(formatActivityGroupElapsed(3_723_000)).toBe('1h 2m 3s')
  })

  it('adds completed work and keeps counting the active tool', () => {
    const activities = [
      createActivity({ id: 's1', createdAt: 1_000, updatedAt: 1_400 }),
      createActivity({
        id: 's2',
        status: 'in_progress',
        createdAt: 1_500,
        updatedAt: 1_500
      })
    ]

    expect(getActivityGroupElapsedMs(activities, 2_750)).toBe(1_650)
  })

  it('excludes idle gaps between completed tools', () => {
    const activities = [
      createActivity({ id: 's1', createdAt: 1_000, updatedAt: 1_400 }),
      createActivity({ id: 's2', createdAt: 1_500, updatedAt: 2_600 })
    ]

    expect(getActivityGroupElapsedMs(activities, 9_000)).toBe(1_500)
  })
})
