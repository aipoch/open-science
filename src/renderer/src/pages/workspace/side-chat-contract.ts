import type { Annotation } from '../../../../shared/annotation-contract'
import type { SideChatModelSelection, SideChatSnapshot } from '../../../../shared/side-chat'
import type { SideChatEntry } from '../../../../shared/side-chat-entry-contract'

export type SideChatView = Readonly<{
  modelSelection?: SideChatModelSelection
  id?: string
  draftOnly?: boolean
  generation: number
  revision?: number
  parentSessionId: string
  projectId: string
  sideSessionId?: string
  entries: readonly SideChatEntry[]
  liveTurnUserEntryId?: string
  draft: string
  annotations?: readonly Annotation[]
  running: boolean
  error?: string
  persistenceError?: string
  notice?: SideChatSnapshot['notice']
}>
