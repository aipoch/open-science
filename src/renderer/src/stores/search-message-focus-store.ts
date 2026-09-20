import { create } from 'zustand'

export type SearchMessageFocus = {
  projectId: string
  sessionId: string
  messageId: string
  navigationRevision: number
}

export const useSearchMessageFocusStore = create<{
  pending?: SearchMessageFocus
  request: (target: SearchMessageFocus) => void
  consume: (target: SearchMessageFocus) => void
}>((set) => ({
  request: (target) => set({ pending: target }),
  consume: (target) => set((state) => (state.pending === target ? { pending: undefined } : state))
}))
