import { i18next as i18n } from '@/i18n'
import {
  Archive,
  GitBranch,
  BookOpen,
  Download,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  PackageCheck,
  Package
} from 'lucide-react'

import type {
  ActionMenuBinding,
  ActionMenuDefinition,
  ActionMenuRecipeEntry
} from '@/components/action-menu'
import type { ChatSession, SessionStatus } from '@/stores/session-store'

export type SessionActionId =
  | 'toggle-pin'
  | 'edit'
  | 'download-artifacts'
  | 'check-artifacts'
  | 'view-notebook'
  | 'export'
  | 'export-package'
  | 'fork'
  | 'archive'
  | 'delete'

export type SessionActionInvocation = Readonly<{
  session: ChatSession
  presentedStatus: SessionStatus
}>

export const SESSION_ACTION_CATALOG = {
  'toggle-pin': { labelKey: 'Pin', icon: Pin },
  edit: { labelKey: 'Edit…', icon: Pencil },
  'download-artifacts': { labelKey: 'Download all artifacts', icon: Download },
  'check-artifacts': { labelKey: 'Check session artifacts', icon: PackageCheck },
  'view-notebook': { labelKey: 'View notebook', icon: BookOpen },
  export: { labelKey: 'Export conversation…', icon: Download },
  'export-package': { labelKey: 'Export Session package', icon: Package },
  fork: { labelKey: 'Fork', icon: GitBranch },
  archive: { labelKey: 'Archive', icon: Archive },
  delete: { labelKey: 'Delete', icon: Trash2, danger: true }
} satisfies Record<SessionActionId, ActionMenuDefinition>

export const SESSION_ACTION_RECIPE = [
  { kind: 'action', action: 'toggle-pin' },
  { kind: 'action', action: 'edit' },
  { kind: 'separator' },
  { kind: 'action', action: 'download-artifacts' },
  { kind: 'action', action: 'check-artifacts' },
  { kind: 'action', action: 'view-notebook' },
  { kind: 'submenu', labelKey: 'Export', icon: Download, actions: ['export', 'export-package'] },
  { kind: 'action', action: 'fork' },
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
  onCheckArtifacts?: (session: ChatSession) => void
  onViewNotebook: (session: ChatSession) => void
  onExportSession?: (session: ChatSession) => void
  onForkSession?: (session: ChatSession) => Promise<void>
  onExportPackage?: (session: ChatSession) => Promise<void>
  packageBusy?: boolean
  onArchiveSession?: (session: ChatSession) => void
  onDeleteSession: (session: ChatSession) => void
}

const isExportDisabled = ({ session, presentedStatus }: SessionActionInvocation): boolean =>
  (session.activeMessageCount ?? session.messages.length) === 0 ||
  presentedStatus === 'running' ||
  presentedStatus === 'waiting-for-user' ||
  presentedStatus === 'waiting-permission' ||
  presentedStatus === 'waiting-plan-approval'

const forkDisabledDescription = (
  options: SessionActionOptions,
  { session, presentedStatus }: SessionActionInvocation
): string | undefined => {
  if (!options.canMutateConversations) return i18n.t('Session storage is not ready.')
  if (options.packageBusy)
    return i18n.t('Wait for the current transfer to finish before forking a Session.')
  if (
    session.status !== 'idle' ||
    presentedStatus !== 'idle' ||
    session.runtimeContext?.permission?.state === 'pending' ||
    session.runtimeContext?.plan?.approval === 'pending'
  ) {
    return i18n.t('Wait for all Session activity and pending approvals to finish before forking.')
  }
  return undefined
}

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
  'check-artifacts': {
    execute: ({ session }) => options.onCheckArtifacts?.(session),
    hidden: !options.onCheckArtifacts,
    disabled: !options.canMutateConversations
  },
  'view-notebook': {
    execute: ({ session }) => options.onViewNotebook(session)
  },
  export: {
    execute: ({ session }) => options.onExportSession?.(session),
    hidden: !options.onExportSession,
    disabled: isExportDisabled
  },
  'export-package': {
    execute: ({ session }) => options.onExportPackage?.(session),
    hidden: !options.onExportPackage,
    disabled: ({ session, presentedStatus }) =>
      !options.canMutateConversations ||
      Boolean(options.packageBusy) ||
      session.status !== 'idle' ||
      presentedStatus !== 'idle'
  },
  fork: {
    execute: ({ session }) => options.onForkSession?.(session),
    hidden: !options.onForkSession,
    disabled: (invocation) => Boolean(forkDisabledDescription(options, invocation)),
    disabledDescription: (invocation) => forkDisabledDescription(options, invocation)
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
