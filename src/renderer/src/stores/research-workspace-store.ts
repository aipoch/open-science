import { create } from 'zustand'
import type { ResearchMembership } from '../../../shared/session-persistence'
import { researchIdentity } from '@/pages/workspace/research-draft-identity'

type ResearchWorkspaceStore = {
  draftResearchByProject: Record<string, ResearchMembership | undefined>
  lastDiscussionByResearch: Record<string, string | undefined>
  openDraft: (source: ResearchMembership) => void
  leaveDraft: (projectId: string) => void
  rememberDiscussion: (source: ResearchMembership, sessionId: string) => void
}

// Navigation intent only. Session membership and composer drafts retain their existing durable
// owners; this store never creates a Session or infers ownership from reading references.
export const useResearchWorkspaceStore = create<ResearchWorkspaceStore>((set) => ({
  draftResearchByProject: {},
  lastDiscussionByResearch: {},
  openDraft: (source) =>
    set((state) => ({
      draftResearchByProject: {
        ...state.draftResearchByProject,
        [source.sourceProjectId]: { ...source }
      }
    })),
  leaveDraft: (projectId) =>
    set((state) => ({
      draftResearchByProject: { ...state.draftResearchByProject, [projectId]: undefined }
    })),
  rememberDiscussion: (source, sessionId) =>
    set((state) => ({
      lastDiscussionByResearch: {
        ...state.lastDiscussionByResearch,
        [researchIdentity(source)]: sessionId
      }
    }))
}))
