const SAFE_LANE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

declare const notebookLaneBrand: unique symbol

export type NotebookLaneIdentity = Readonly<{
  readonly [notebookLaneBrand]: true
}>

export type NotebookLaneScope = Readonly<{
  projectId: string
  sessionId: string
  agentFrameId: string
  kind: 'root' | 'frame'
  attemptId?: string
}>

const scopes = new WeakMap<object, NotebookLaneScope>()

const safeSegment = (name: keyof Omit<NotebookLaneScope, 'kind'>, value: string): string => {
  if (!SAFE_LANE_SEGMENT.test(value)) throw new Error(`Invalid Notebook lane ${name}.`)
  return value
}

const createLane = (scope: NotebookLaneScope): NotebookLaneIdentity => {
  const lane = Object.freeze({}) as NotebookLaneIdentity
  scopes.set(lane, Object.freeze({ ...scope }))
  return lane
}

export const createRootNotebookLane = (
  projectId: string,
  sessionId: string,
  agentFrameId: string
): NotebookLaneIdentity =>
  createLane({
    projectId: safeSegment('projectId', projectId),
    sessionId: safeSegment('sessionId', sessionId),
    agentFrameId: safeSegment('agentFrameId', agentFrameId),
    kind: 'root'
  })

export const createFrameNotebookLane = (
  projectId: string,
  sessionId: string,
  agentFrameId: string,
  attemptId?: string
): NotebookLaneIdentity => {
  const safeSessionId = safeSegment('sessionId', sessionId)
  const safeAgentFrameId = safeSegment('agentFrameId', agentFrameId)
  return createLane({
    projectId: safeSegment('projectId', projectId),
    sessionId: safeSessionId,
    agentFrameId: safeAgentFrameId,
    kind: safeAgentFrameId === `root-frame-${safeSessionId}` ? 'root' : 'frame',
    ...(attemptId ? { attemptId: safeSegment('attemptId', attemptId) } : {})
  })
}

export const notebookLaneScope = (lane: NotebookLaneIdentity): NotebookLaneScope => {
  const scope = scopes.get(lane)
  if (!scope) throw new Error('Invalid Notebook lane identity.')
  return scope
}

export const notebookLaneKey = (lane: NotebookLaneIdentity): string => {
  const { projectId, sessionId, agentFrameId, kind, attemptId } = notebookLaneScope(lane)
  // A root Notebook is durable per Session even when the Agent runtime adopted a provisional root
  // Frame id before the final Session id existed. Keep that provenance on Run records, but do not
  // let its alternate presentation create a second in-memory owner for the same root run.json.
  return JSON.stringify([
    projectId,
    sessionId,
    kind,
    kind === 'root' ? null : agentFrameId,
    kind === 'root' ? null : (attemptId ?? null)
  ])
}
