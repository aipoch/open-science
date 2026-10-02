import { beforeEach, describe, expect, it } from 'vitest'
import { sessionReplayKey, useSessionReplayStore } from './session-replay-store'
import type { SessionReplaySnapshot } from '../../../shared/session-replay'
const key = sessionReplayKey('project', 'source')
const row: SessionReplaySnapshot = {
  projectId: 'project',
  sourceSessionId: 'source',
  sourceStatus: 'available'
}
beforeEach(() =>
  useSessionReplayStore.setState({
    snapshots: {},
    pendingDiscussion: undefined,
    discussionDestination: undefined
  })
)
describe('replay checkpoint cache', () => {
  it('does not erase a detail loaded while a project listing was pending', () => {
    const observed = useSessionReplayStore.getState().snapshots
    useSessionReplayStore.getState().put(row)
    useSessionReplayStore.getState().replaceProject('project', [], observed)
    expect(useSessionReplayStore.getState().snapshots[key]).toEqual(row)
  })
  it('preserves the latest checkpoint when source availability changes', () => {
    const view = {
      revision: 2,
      state: {
        fingerprint: 'hash',
        generatorVersion: 1,
        branchId: 'main',
        timeMs: 500,
        rate: 1 as const
      }
    }
    useSessionReplayStore.getState().put({ ...row, view })
    useSessionReplayStore
      .getState()
      .put({ ...row, sourceStatus: 'missing', view: { ...view, revision: 1 } })
    expect(useSessionReplayStore.getState().snapshots[key]).toEqual({
      ...row,
      sourceStatus: 'missing',
      view
    })
  })
})
