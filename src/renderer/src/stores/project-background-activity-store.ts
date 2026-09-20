import { create } from 'zustand'

import type { ProjectBackgroundActivity } from '../../../shared/background-result-delivery'

type ProjectBackgroundActivityState = {
  projectId?: string
  snapshot: ProjectBackgroundActivity
  hydrate: (projectId: string, snapshot: ProjectBackgroundActivity) => void
  clear: () => void
}

const EMPTY_ACTIVITY: ProjectBackgroundActivity = { items: [], truncated: false }

const useProjectBackgroundActivityStore = create<ProjectBackgroundActivityState>((set) => ({
  snapshot: EMPTY_ACTIVITY,
  hydrate: (projectId, incoming) => set({ projectId, snapshot: incoming }),
  clear: () => set({ projectId: undefined, snapshot: EMPTY_ACTIVITY })
}))

export { EMPTY_ACTIVITY, useProjectBackgroundActivityStore }
