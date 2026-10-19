import { describe, expect, it } from 'vitest'
import { ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME } from '../../../../shared/acp'
import type {
  PersistedChatSession,
  PersistedToolActivity
} from '../../../../shared/session-persistence'
import { hydrateSession } from '../../stores/session-store'
import { createWorkspaceConversationTimeline } from '../../pages/workspace/workspace-conversation-timeline'
import { createReplayTranscript } from './transcript'

const activity = (
  id: string,
  createdAt: number,
  extra: Partial<PersistedToolActivity> = {}
): PersistedToolActivity => ({
  id,
  kind: 'tool',
  title: id,
  status: 'completed',
  createdAt,
  updatedAt: createdAt + 1,
  sortIndex: createdAt,
  eventIds: [],
  ...extra
})
const session = (activities: PersistedToolActivity[]): PersistedChatSession => ({
  id: 'session',
  projectId: 'project',
  title: 'Source',
  cwd: '/recorded',
  status: 'idle',
  createdAt: 1,
  updatedAt: 100,
  activities,
  messages: [
    {
      id: 'request',
      role: 'user',
      content: 'Question',
      status: 'complete',
      createdAt: 1,
      updatedAt: 1,
      eventIds: []
    },
    {
      id: 'control',
      role: 'user',
      content: 'Hidden control',
      status: 'complete',
      turnIntent: 'save-as-skill',
      createdAt: 10,
      updatedAt: 10,
      eventIds: []
    },
    {
      id: 'answer',
      role: 'agent',
      content: 'Answer',
      status: 'complete',
      responseToMessageId: 'request',
      completedAt: 101,
      createdAt: 100,
      updatedAt: 101,
      eventIds: []
    }
  ]
})
const summarize = (items: ReturnType<typeof createReplayTranscript>): unknown =>
  items.map((item) =>
    item.type === 'message'
      ? ['message', item.message.id]
      : item.type === 'activity-group'
        ? ['activity-group', item.activities.map((activity) => activity.id), item.title]
        : [item.type, item.activity.id]
  )

describe('pure persisted Replay transcript', () => {
  it.each([
    [activity('a', 2), activity('b', 3)],
    [
      activity('b', 2),
      activity('a', 2),
      activity('plan', 3, { providerToolName: 'mcp__open-science-plan__generate_plan' }),
      activity('c', 4)
    ],
    [
      activity('a', 2),
      activity('status', 3, { providerToolName: 'mcp.open_science_plan.update_step_status' }),
      activity('compact', 4, { providerToolName: ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME }),
      activity('b', 5)
    ],
    [
      activity('a', 2, { activityGroupId: 'g1' }),
      activity('b', 3, { activityGroupId: 'g2' }),
      activity('c', 4, { activityGroupId: 'g1' })
    ]
  ])('preserves the established native transcript evidence order %#', (...activities) => {
    const source = session(activities)
    const native = createWorkspaceConversationTimeline(hydrateSession(source)).filter((item) =>
      ['message', 'activity', 'activity-group', 'plan-activity', 'compaction-activity'].includes(
        item.type
      )
    ) as ReturnType<typeof createReplayTranscript>
    expect(summarize(createReplayTranscript(source))).toEqual(summarize(native))
    expect(JSON.stringify(createReplayTranscript(source))).not.toContain('Hidden control')
  })
})
