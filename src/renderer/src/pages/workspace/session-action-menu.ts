import { i18next as i18n } from '@/i18n'
import {
  Archive,
  GitBranch,
  BookOpen,
  MessageSquare,
  Play,
  Download,
  Stethoscope,
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
import { projectPresentedSessionActionability } from './session-wait-reason'

export type SessionActionId =
  | 'toggle-pin'
  | 'edit'
  | 'download-artifacts'
  | 'check-artifacts'
  | 'view-notebook'
  | 'view-replay'
  | 'discuss'
  | 'export'
  | 'export-package'
  | 'export-diagnostics'
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
  'view-replay': { labelKey: 'View replay', icon: Play },
  discuss: { labelKey: 'Discuss', icon: MessageSquare },
  export: { labelKey: 'Export conversation…', icon: Download },
  'export-package': { labelKey: 'Export Session package', icon: Package },
  'export-diagnostics': { labelKey: 'Export diagnostics…', icon: Stethoscope },
  fork: { labelKey: 'Fork', icon: GitBranch },
  archive: { labelKey: 'Archive', icon: Archive },
  delete: { labelKey: 'Delete', icon: Trash2, danger: true }
} satisfies Record<SessionActionId, ActionMenuDefinition>

export const SESSION_ACTION_RECIPE = [
  { kind: 'action', action: 'toggle-pin' },
  { kind: 'action', action: 'edit' },
  { kind: 'separator' },
  { kind: 'action', action: 'discuss' },
  { kind: 'action', action: 'view-replay' },
  { kind: 'action', action: 'download-artifacts' },
  { kind: 'action', action: 'check-artifacts' },
  { kind: 'action', action: 'view-notebook' },
  {
    kind: 'submenu',
    labelKey: 'Export',
    icon: Download,
    actions: ['export', 'export-package', 'export-diagnostics']
  },
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
  onDownloadArtifacts?: (session: ChatSession) => void
  onCheckArtifacts?: (session: ChatSession) => void
  onViewNotebook?: (session: ChatSession) => void
  onViewReplay?: (session: ChatSession) => void
  onDiscussSession?: (session: ChatSession) => Promise<void>
  onExportSession?: (session: ChatSession) => void
  onForkSession?: (session: ChatSession) => Promise<void>
  onExportPackage?: (session: ChatSession) => Promise<void>
  onExportDiagnostics?: (session: ChatSession) => void
  packageBusy?: boolean
  onArchiveSession?: (session: ChatSession) => void
  onDeleteSession?: (session: ChatSession) => void
}

const hasTransferActivity = ({ session, presentedStatus }: SessionActionInvocation): boolean =>
  presentedStatus === 'running' ||
  presentedStatus.startsWith('waiting-') ||
  Boolean(session.activeRun || session.compacting || session.agentPromptInFlight) ||
  projectPresentedSessionActionability(session).activity !== 'inactive' ||
  session.runtimeContext?.permission?.state === 'pending' ||
  session.runtimeContext?.plan?.approval === 'pending'

// Imported runtime fields are evidence; transient renderer work still blocks a transfer.
// Fork keeps the stricter admission below because its destination is writable.
const hasExportActivity = (invocation: SessionActionInvocation): boolean =>
  invocation.session.packageOrigin
    ? Boolean(invocation.session.compacting || invocation.session.agentPromptInFlight)
    : hasTransferActivity(invocation)

const isExportDisabled = (invocation: SessionActionInvocation): boolean =>
  (invocation.session.activeMessageCount ?? invocation.session.messages.length) === 0 ||
  hasExportActivity(invocation)

const forkDisabledDescription = (
  options: SessionActionOptions,
  { session, presentedStatus }: SessionActionInvocation
): string | undefined => {
  if (!options.canMutateConversations) return i18n.t('Session storage is not ready.')
  if (options.packageBusy)
    return i18n.t('Wait for the current transfer to finish before forking a Session.')
  if (hasTransferActivity({ session, presentedStatus })) {
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
    execute: ({ session }) => options.onDownloadArtifacts?.(session),
    hidden: !options.canDownloadArtifacts || !options.onDownloadArtifacts
  },
  'check-artifacts': {
    execute: ({ session }) => options.onCheckArtifacts?.(session),
    hidden: !options.onCheckArtifacts,
    disabled: !options.canMutateConversations
  },
  'view-notebook': {
    execute: ({ session }) => options.onViewNotebook?.(session),
    hidden: !options.onViewNotebook
  },
  'view-replay': {
    execute: ({ session }) => options.onViewReplay?.(session),
    hidden: !options.onViewReplay,
    disabled: ({ session }) => Boolean(session.isPending)
  },
  discuss: {
    execute: ({ session }) => options.onDiscussSession?.(session),
    hidden: !options.onDiscussSession,
    disabled: ({ session }) => Boolean(session.isPending)
  },
  export: {
    execute: ({ session }) => options.onExportSession?.(session),
    hidden: !options.onExportSession,
    disabled: isExportDisabled
  },
  'export-package': {
    execute: ({ session }) => options.onExportPackage?.(session),
    hidden: !options.onExportPackage,
    disabled: (invocation) =>
      !options.canMutateConversations ||
      Boolean(options.packageBusy) ||
      hasExportActivity(invocation)
  },
  'export-diagnostics': {
    execute: ({ session }) => options.onExportDiagnostics?.(session),
    hidden: !options.onExportDiagnostics
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
    execute: ({ session }) => options.onDeleteSession?.(session),
    hidden: !options.onDeleteSession,
    disabled: !options.canDeleteConversations
  }
})
