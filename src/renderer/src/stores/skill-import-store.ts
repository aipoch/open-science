import { create } from 'zustand'

import type {
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse
} from '../../../shared/settings'

type SkillImportStoreData = {
  pending: ConversationSkillImportApprovalRequest[]
}

type SkillImportStore = SkillImportStoreData & {
  enqueue: (request: ConversationSkillImportApprovalRequest) => void
  dismiss: (id: string) => void
  respond: (response: ConversationSkillImportApprovalResponse) => Promise<void>
}

export const createInitialSkillImportState = (): SkillImportStoreData => ({ pending: [] })

// Owns the renderer side of the app-confirmed import queue. Main remains authoritative and keeps the
// agent tool call parked; a request leaves this queue only after its IPC response is accepted.
export const useSkillImportStore = create<SkillImportStore>((set) => ({
  ...createInitialSkillImportState(),
  enqueue: (request) =>
    set((state) =>
      state.pending.some((candidate) => candidate.id === request.id)
        ? state
        : { pending: [...state.pending, request] }
    ),
  dismiss: (id) =>
    set((state) => ({ pending: state.pending.filter((request) => request.id !== id) })),
  respond: async (response) => {
    await window.api.settings.respondSkillImportApproval(response)
    set((state) => ({ pending: state.pending.filter((request) => request.id !== response.id) }))
  }
}))
