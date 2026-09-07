import { Archive, BookOpen, Download, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'

import type {
  ActionMenuBinding,
  ActionMenuDefinition,
  ActionMenuRecipeEntry
} from '@/components/action-menu'
import type { ChatSession, SessionStatus } from '@/stores/session-store'

export type SessionActionId =
  'toggle-pin' | 'edit' | 'download-artifacts' | 'view-notebook' | 'export' | 'archive' | 'delete'

export type SessionActionInvocation = Readonly<{
  session: ChatSession
  presentedStatus: SessionStatus
}>

export const SESSION_ACTION_CATALOG = {
  'toggle-pin': { labelKey: 'Pin', icon: Pin },
  edit: { labelKey: 'Edit…', icon: Pencil },
  'download-artifacts': { labelKey: 'Download all artifacts', icon: Download },
  'view-notebook': { labelKey: 'View notebook', icon: BookOpen },
  export: { labelKey: 'Export conversation…', icon: Download },
  archive: { labelKey: 'Archive', icon: Archive },
  delete: { labelKey: 'Delete', icon: Trash2, danger: true }
} satisfies Record<SessionActionId, ActionMenuDefinition>

export const SESSION_ACTION_RECIPE = [
  { kind: 'action', action: 'toggle-pin' },
  { kind: 'action', action: 'edit' },
  { kind: 'separator' },
  { kind: 'action', action: 'download-artifacts' },
  { kind: 'action', action: 'view-notebook' },
  { kind: 'action', action: 'export' },
  { kind: 'action', action: 'archive' },
  { kind: 'separator' },
  { kind: 'action', action: 'delete' }
] as const satisfies readonly ActionMenuRecipeEntry<SessionActionId>[]

type SessionActionOptions = {
  canMutateConversations: boolean
  canDeleteConversations: boolean
  canDownloadArtifacts: boolean
  canArchiveSession?: (session: ChatSession) => boolean
  onTogglePin: (session: ChatSession) => void
  onRenameSession: (session: ChatSession) => void
  onDownloadArtifacts: (session: ChatSession) => void
  onViewNotebook: (session: ChatSession) => void
  onExportSession?: (session: ChatSession) => void
  onArchiveSession?: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
}

const isExportDisabled = ({ session, presentedStatus }: SessionActionInvocation): boolean =>
  (session.activeMessageCount ?? session.messages.length) === 0 ||
  presentedStatus === 'running' ||
  presentedStatus === 'waiting-for-user' ||
  presentedStatus === 'waiting-permission' ||
  presentedStatus === 'waiting-plan-approval'

export const createSessionActionBindings = (
  options: SessionActionOptions
): Record<SessionActionId, ActionMenuBinding<SessionActionInvocation>> => ({
  'toggle-pin': {
    execute: ({ session }) => options.onTogglePin(session),
    labelKey: ({ session }: SessionActionInvocation) => (session.pinned ? 'Unpin' : 'Pin'),
    icon: ({ session }: SessionActionInvocation) => (session.pinned ? PinOff : Pin),
    disabled: !options.canMutateConversations
  },
  edit: {
    execute: ({ session }) => options.onRenameSession(session),
    disabled: !options.canMutateConversations
  },
  'download-artifacts': {
    execute: ({ session }) => options.onDownloadArtifacts(session),
    hidden: !options.canDownloadArtifacts
  },
  'view-notebook': {
    execute: ({ session }) => options.onViewNotebook(session)
  },
  export: {
    execute: ({ session }) => options.onExportSession?.(session),
    hidden: !options.onExportSession,
    disabled: isExportDisabled
  },
  archive: {
    execute: ({ session }) => options.onArchiveSession?.(session),
    disabled: ({ session }) => !options.canArchiveSession?.(session)
  },
  delete: {
    execute: ({ session }) => options.onDeleteSession(session),
    disabled: !options.canDeleteConversations
  }
})
