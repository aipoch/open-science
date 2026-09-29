import { describe, expect, it } from 'vitest'
import type { ResearchWorkspaceSnapshot } from '../../../../shared/research-workspace'
import type { ChatSession } from '@/stores/session-store'
import { projectResearchSidebar } from './research-sidebar-projection'

const source: ChatSession = {
  id: 'import-source',
  projectId: 'project',
  title: 'Original research',
  status: 'idle',
  cwd: '',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}
const discussion: ChatSession = {
  ...source,
  id: 'discussion',
  title: 'Discussion',
  status: 'running',
  updatedAt: 2
}
const workspace: ResearchWorkspaceSnapshot = {
  projectId: source.projectId,
  sourceSessionId: source.id,
  sourceStatus: 'available',
  discussionSessionId: discussion.id,
  discussionStatus: 'available',
  linkRevision: 2
}

describe('research sidebar projection', () => {
  it('groups a visible source and Discussion without mutating the action target', () => {
    const result = projectResearchSidebar([source, discussion], [workspace], discussion.id)
    expect(result.sessions).toEqual([source])
    expect(result.sessions[0]).toBe(source)
    expect(result.sessions[0].status).toBe('idle')
    expect(result.activitySessionsByEntryId.get(source.id)).toBe(discussion)
    expect(result.activeSessionId).toBe(source.id)
  })

  it.each(['missing', 'unreadable', 'archived', 'not-imported'] as const)(
    'keeps Discussion accessible when its source is %s',
    (sourceStatus) => {
      const result = projectResearchSidebar(
        [discussion],
        [{ ...workspace, sourceStatus }],
        discussion.id
      )
      expect(result.sessions).toEqual([discussion])
      expect(result.activeSessionId).toBe(discussion.id)
      expect(result.activitySessionsByEntryId.size).toBe(0)
    }
  )

  it('does not hide history based on a stale or cross-Project source row', () => {
    expect(
      projectResearchSidebar(
        [source, discussion],
        [{ ...workspace, sourceStatus: 'missing' }],
        discussion.id
      ).sessions
    ).toEqual([source, discussion])
    expect(
      projectResearchSidebar(
        [{ ...source, projectId: 'other' }, discussion],
        [workspace],
        discussion.id
      ).sessions
    ).toHaveLength(2)
    expect(
      projectResearchSidebar(
        [source, discussion],
        [{ ...workspace, discussionStatus: 'missing' }],
        source.id
      ).activitySessionsByEntryId.size
    ).toBe(0)
  })

  it('keeps the source entry when the Discussion is absent or archived', () => {
    const result = projectResearchSidebar(
      [source],
      [{ ...workspace, discussionStatus: 'archived' }],
      source.id
    )
    expect(result.sessions).toEqual([source])
    expect(result.activeSessionId).toBe(source.id)
    expect(result.activitySessionsByEntryId.size).toBe(0)
  })
})
