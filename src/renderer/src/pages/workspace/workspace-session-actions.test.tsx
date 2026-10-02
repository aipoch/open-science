// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createSessionReplayItem } from './workspace-session-actions'

describe('explicit research preview identity', () => {
  it('reuses one preview identity when the same source is opened again', () => {
    const first = createSessionReplayItem('project', 'source', 'Study')
    expect(createSessionReplayItem('project', 'source', 'Renamed study').id).toBe(first.id)
    expect(first).toMatchObject({
      toolKind: 'replay',
      sessionId: 'source',
      replaySourceSessionId: 'source'
    })
  })
  it('keeps source identity separate from a cross-project preview owner', () => {
    expect(
      createSessionReplayItem('archive-project', 'source', 'Study', 'target-project')
    ).toMatchObject({
      projectId: 'target-project',
      replaySourceProjectId: 'archive-project',
      replaySourceSessionId: 'source'
    })
  })
})
