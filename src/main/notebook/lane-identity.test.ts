import { describe, expect, it } from 'vitest'

import {
  createFrameNotebookLane,
  createRootNotebookLane,
  notebookLaneKey,
  notebookLaneScope
} from './lane-identity'

describe('Notebook lane identity', () => {
  it('keeps Project, Session, and Agent Frame identity opaque to routing callers', () => {
    const root = createRootNotebookLane('project-a', 'session-1', 'root-frame-session-1')
    const child = createFrameNotebookLane('project-a', 'session-1', 'frame-child')
    const otherProject = createFrameNotebookLane('project-b', 'session-1', 'frame-child')

    expect(notebookLaneScope(root)).toEqual({
      projectId: 'project-a',
      sessionId: 'session-1',
      agentFrameId: 'root-frame-session-1',
      kind: 'root'
    })
    expect(
      new Set([notebookLaneKey(root), notebookLaneKey(child), notebookLaneKey(otherProject)])
    ).toHaveLength(3)
    expect(Object.keys(root)).toEqual([])
  })

  it('uses the persisted root Frame identity instead of deriving one from the Session', () => {
    const root = createRootNotebookLane('project-a', 'session-1', 'persisted-root-frame')

    expect(notebookLaneScope(root)).toEqual({
      projectId: 'project-a',
      sessionId: 'session-1',
      agentFrameId: 'persisted-root-frame',
      kind: 'root'
    })
  })

  it('rejects unsafe identity segments before they can reach maps or paths', () => {
    expect(() => createFrameNotebookLane('project-a', 'session-1', '../frame')).toThrow(
      'Invalid Notebook lane agentFrameId.'
    )
  })
})
