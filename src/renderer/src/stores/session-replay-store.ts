import { create } from 'zustand'
import type { SessionReplaySnapshot } from '../../../shared/session-replay'
import type { SessionDiscussionCapture } from '@/pages/workspace/replay/replay-context'

export const sessionReplayKey = (projectId: string, sourceSessionId: string): string =>
  JSON.stringify([projectId, sourceSessionId])

export type SessionDiscussionDestination = {
  projectId: string
  sessionId?: string
  draftKey?: string
  onlyIfUnlinked?: boolean
  frameId?: string
  branchId?: string
  navigationRevision: number
}

type SessionReplayStore = {
  // Projection of the currently editable draft, cleared when its composer leaves or unlinks.
  draftDiscussion?: { projectId: string; sourceSessionId: string; draftKey: string }
  playhead?: {
    projectId: string
    sourceSessionId: string
    capture: () => SessionDiscussionCapture
  }
  snapshots: Record<string, SessionReplaySnapshot>
  pendingDiscussion?: SessionDiscussionCapture
  discussionDestination?: SessionDiscussionDestination
  ask: (
    context: SessionDiscussionCapture | undefined,
    destination?: SessionDiscussionDestination
  ) => void
  put: (snapshot: SessionReplaySnapshot) => void
  replaceProject: (
    projectId: string,
    snapshots: SessionReplaySnapshot[],
    observed: Record<string, SessionReplaySnapshot>
  ) => void
}

const mergeSnapshot = (
  previous: SessionReplaySnapshot | undefined,
  incoming: SessionReplaySnapshot
): SessionReplaySnapshot => {
  if (!previous) return incoming
  return {
    ...incoming,
    ...(previous.view && (!incoming.view || previous.view.revision > incoming.view.revision)
      ? { view: previous.view }
      : {})
  }
}

// This cache is a renderer projection, not the durable owner. Source histories remain in the
// ordinary Session repository; immutable references and viewing checkpoints are owned by main.
export const useSessionReplayStore = create<SessionReplayStore>((set) => ({
  snapshots: {},
  ask: (pendingDiscussion, discussionDestination) =>
    set({ pendingDiscussion, discussionDestination }),
  put: (snapshot) =>
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [sessionReplayKey(snapshot.projectId, snapshot.sourceSessionId)]: mergeSnapshot(
          state.snapshots[sessionReplayKey(snapshot.projectId, snapshot.sourceSessionId)],
          snapshot
        )
      }
    })),
  replaceProject: (projectId, snapshots, observed) =>
    set((state) => {
      const next = { ...state.snapshots }
      const incoming = new Map(
        snapshots
          .filter((row) => row.projectId === projectId)
          .map((row) => [sessionReplayKey(projectId, row.sourceSessionId), row])
      )
      for (const [key, current] of Object.entries(next)) {
        if (current.projectId !== projectId || current !== observed[key]) continue
        if (!incoming.has(key)) delete next[key]
      }
      for (const [key, row] of incoming) {
        // A detail load completed after this list started. Its result wins.
        if (state.snapshots[key] !== observed[key]) continue
        next[key] = mergeSnapshot(state.snapshots[key], row)
      }
      return { snapshots: next }
    })
}))
