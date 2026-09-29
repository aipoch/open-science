import { beforeEach, describe, expect, it } from 'vitest'
import type { ResearchWorkspaceSnapshot } from '../../../shared/research-workspace'
import { researchWorkspaceKey, useResearchWorkspaceStore } from './research-workspace-store'

const key = researchWorkspaceKey('project', 'source')
const row: ResearchWorkspaceSnapshot = {
  projectId: 'project',
  sourceSessionId: 'source',
  sourceStatus: 'available',
  discussionStatus: 'available',
  discussionSessionId: 'discussion',
  linkRevision: 1,
  discussionSession: {
    id: 'discussion',
    projectId: 'project',
    title: 'Discussion',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
}
beforeEach(() => useResearchWorkspaceStore.setState({ snapshots: {}, pendingQuestion: undefined }))

describe('research workspace cache', () => {
  it('does not erase a discussion created while a project list was loading', () => {
    const observed = useResearchWorkspaceStore.getState().snapshots
    useResearchWorkspaceStore.getState().put(row)
    useResearchWorkspaceStore.getState().replaceProject('project', [], observed)
    expect(useResearchWorkspaceStore.getState().snapshots[key]).toEqual(row)
  })

  it('preserves loaded content when a fresh metadata listing describes the same discussion', () => {
    useResearchWorkspaceStore.getState().put(row)
    const metadata = { ...row, discussionSession: undefined }
    useResearchWorkspaceStore
      .getState()
      .replaceProject('project', [metadata], useResearchWorkspaceStore.getState().snapshots)
    expect(useResearchWorkspaceStore.getState().snapshots[key].discussionSession).toEqual(
      row.discussionSession
    )
  })

  it('accepts lifecycle changes but drops obsolete content and excludes other projects', () => {
    useResearchWorkspaceStore.getState().put(row)
    useResearchWorkspaceStore.getState().replaceProject(
      'project',
      [
        { ...row, discussionSession: undefined, discussionStatus: 'missing' },
        { ...row, projectId: 'foreign' }
      ],
      useResearchWorkspaceStore.getState().snapshots
    )
    expect(useResearchWorkspaceStore.getState().snapshots[key].discussionSession).toBeUndefined()
    expect(Object.values(useResearchWorkspaceStore.getState().snapshots)).toHaveLength(1)
    expect(useResearchWorkspaceStore.getState().snapshots[key].discussionStatus).toBe('missing')
  })

  it('does not regress a recreated discussion with an older relation revision', () => {
    useResearchWorkspaceStore.getState().put({
      ...row,
      discussionSessionId: 'replacement',
      discussionSession: undefined,
      linkRevision: 2
    })
    useResearchWorkspaceStore.getState().put(row)
    expect(useResearchWorkspaceStore.getState().snapshots[key].discussionSessionId).toBe(
      'replacement'
    )
  })
})
