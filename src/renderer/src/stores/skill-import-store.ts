import { create } from 'zustand'

import type {
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse
} from '../../../shared/settings'

type SkillImportStoreData = {
  pending: ConversationSkillImportApprovalRequest[]
  closedIds: string[]
  respondingIds: string[]
}

type SkillImportStore = SkillImportStoreData & {
  enqueue: (request: ConversationSkillImportApprovalRequest) => void
  dismiss: (id: string) => void
  close: (id: string) => void
  respond: (response: ConversationSkillImportApprovalResponse) => Promise<void>
}

export const createInitialSkillImportState = (): SkillImportStoreData => ({
  pending: [],
  closedIds: [],
  respondingIds: []
})

// Owns the renderer side of the app-confirmed import queue. Main remains authoritative and keeps the
// agent tool call parked; a request leaves this queue only after its IPC response is accepted.
export const useSkillImportStore = create<SkillImportStore>((set, get) => ({
  ...createInitialSkillImportState(),
  enqueue: (request) =>
    set((state) =>
      state.pending.some((candidate) => candidate.id === request.id)
        ? state
        : { pending: [...state.pending, request] }
    ),
  close: (id) => {
    const state = get()
    if (!state.pending.some((request) => request.id === id) || state.closedIds.includes(id)) return
    set({ closedIds: [...state.closedIds, id] })
    // Keep the close marker on transport failure, without a visible reminder or retry loop.
    if (!state.respondingIds.includes(id)) {
      void get()
        .respond({ id, cancelled: true })
        .catch(() => undefined)
    }
  },
  dismiss: (id) =>
    set((state) => ({
      pending: state.pending.filter((request) => request.id !== id),
      closedIds: state.closedIds.filter((candidate) => candidate !== id),
      respondingIds: state.respondingIds.filter((candidate) => candidate !== id)
    })),
  respond: async (response) => {
    if (get().respondingIds.includes(response.id)) return
    set((state) => ({ respondingIds: [...state.respondingIds, response.id] }))
    try {
      await window.api.settings.respondSkillImportApproval(response)
      get().dismiss(response.id)
    } finally {
      set((state) => ({ respondingIds: state.respondingIds.filter((id) => id !== response.id) }))
    }
  }
}))
