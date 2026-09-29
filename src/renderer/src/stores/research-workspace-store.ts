import { create } from 'zustand'
import type { ResearchWorkspaceSnapshot } from '../../../shared/research-workspace'
import type { ReplayStepContext } from '@/pages/workspace/replay/replay-context'

export const researchWorkspaceKey = (projectId: string, sourceSessionId: string): string =>
  JSON.stringify([projectId, sourceSessionId])

type ResearchWorkspaceStore = {
  snapshots: Record<string, ResearchWorkspaceSnapshot>
  pendingQuestion?: ReplayStepContext
  ask: (context: ReplayStepContext | undefined) => void
  put: (snapshot: ResearchWorkspaceSnapshot) => void
  replaceProject: (
    projectId: string,
    snapshots: ResearchWorkspaceSnapshot[],
    observed: Record<string, ResearchWorkspaceSnapshot>
  ) => void
}

const mergeSnapshot = (
  previous: ResearchWorkspaceSnapshot | undefined,
  incoming: ResearchWorkspaceSnapshot
): ResearchWorkspaceSnapshot => {
  if (!previous) return incoming
  if (incoming.linkRevision < previous.linkRevision) return previous
  const sameDiscussion =
    incoming.discussionSessionId === previous.discussionSessionId &&
    incoming.discussionStatus === previous.discussionStatus &&
    incoming.linkRevision === previous.linkRevision
  return {
    ...incoming,
    ...(sameDiscussion && !incoming.discussionSession && previous.discussionSession
      ? { discussionSession: previous.discussionSession }
      : {}),
    ...(previous.view && (!incoming.view || previous.view.revision > incoming.view.revision)
      ? { view: previous.view }
      : {})
  }
}

// This cache is a renderer projection, not the durable owner. Source histories remain in the
// ordinary Session repository; relationships and viewing checkpoints are owned by main.
export const useResearchWorkspaceStore = create<ResearchWorkspaceStore>((set) => ({
  snapshots: {},
  ask: (pendingQuestion) => set({ pendingQuestion }),
  put: (snapshot) =>
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [researchWorkspaceKey(snapshot.projectId, snapshot.sourceSessionId)]: mergeSnapshot(
          state.snapshots[researchWorkspaceKey(snapshot.projectId, snapshot.sourceSessionId)],
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
          .map((row) => [researchWorkspaceKey(projectId, row.sourceSessionId), row])
      )
      for (const [key, current] of Object.entries(next)) {
        if (current.projectId !== projectId || current !== observed[key]) continue
        if (!incoming.has(key)) delete next[key]
      }
      for (const [key, row] of incoming) {
        // A detail load or ensureDiscussion completed after this list started. Its result wins.
        if (state.snapshots[key] !== observed[key]) continue
        next[key] = mergeSnapshot(state.snapshots[key], row)
      }
      return { snapshots: next }
    })
}))
