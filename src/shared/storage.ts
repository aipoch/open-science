// Cross-process storage contracts shared by main, preload, and renderer.

export const STORAGE_USAGE_CATEGORY_KEYS = [
  'artifacts',
  'compute',
  'delegation',
  'uploads',
  'runtime',
  'notebooks',
  'execution-file-evidence',
  'workspaces'
] as const
export type UsageCategoryKey = (typeof STORAGE_USAGE_CATEGORY_KEYS)[number]
export type UsageChild = {
  name: string
  bytes: number
  workspaceId?: string
  projectId?: string
  sessionId?: string
  createdAt?: number
  lastUsedAt?: number
  retainedAfterDelete?: boolean
}
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
export type StorageUsage = { categories: UsageCategory[]; totalBytes: number }

export type StorageStatus = {
  dataRoot: string
  isDefault: boolean
  // The default data root and the parent that reproduces it. `defaultParent` is fed to the same
  // inspect/migrate flow a browsed folder would be; `defaultDataRoot` is the derived destination
  // shown to the user in Settings' one-click "return to default" affordance (accurate there because
  // the affordance only appears when the current root is custom, i.e. the default is <home>/OpenScience).
  defaultDataRoot: string
  defaultParent: string
  // True only when settings.dataRoot is explicitly configured but the resolved directory is gone
  // (deleted, or an unmounted external/network drive). False for a fresh install whose default
  // `~/OpenScience` simply hasn't been created yet.
  dataRootMissing: boolean
  // True when this is a pre-§20 legacy install whose data still lives in the hidden config root and
  // the user hasn't yet answered the one-time "move it into the visible OpenScience folder" prompt.
  // Drives the first-run LegacyDataMoveDialog; once answered (moved/relocated/declined) it stays false.
  legacyDataMovePrompt: boolean
  // True while a committed move still has verified old-root files to remove. Main retries the
  // durable cleanup intent at startup; renderer uses this only to notify the user.
  cleanupPending: boolean
}

export type StorageInfo = StorageStatus & {
  // Main-owned onboarding eligibility. True only when the default data root is unconfigured and
  // contains no data or managed runtime, so selecting another drive can use a pointer switch without
  // hiding an existing install or stranding an environment. Derived on every read; never persisted.
  canAutoSelectDataDrive: boolean
  usage: StorageUsage
  availableBytes: number
}

export type RevealAppStorageResult = {
  revealed: boolean
  error?: string
}

export type ActiveSessionInfo = {
  // The owning project's id (the artifact/notebook storage key). main doesn't hold the human
  // project name or session title — the renderer maps this id + sessionId to display strings.
  projectId: string
  sessionId: string
  // delegated is distinct because disruptive operations must be blocked until the user returns to
  // the task and explicitly stops its subagents; it is not force-interruptible from a global dialog.
  kind: 'agent' | 'delegated' | 'notebook'
  title?: string
}

export const hasDelegatedActiveSession = (sessions: readonly ActiveSessionInfo[]): boolean =>
  sessions.some((session) => session.kind === 'delegated')

export type MigrationPhase = 'scan' | 'copy' | 'verify' | 'delete'
export type MigrationProgress = {
  phase: MigrationPhase
  copiedBytes: number
  totalBytes: number
  currentPath?: string
}
export type MigrationResult = { ok: true } | { ok: false; error: string; cancelled?: boolean }
export type MigrationOutcome =
  | { ok: true; cleanupPending: boolean }
  | { ok: false; error: string; cancelled?: boolean }
  | { ok: false; error: string; switchoverFailed: true }

export type DiscardMigratedCopyResult =
  { ok: true; cleanupWarning?: string } | { ok: false; error: string }

export type DataRootValidationResult = { ok: true } | { ok: false; error: string }

// Classification of a candidate data root. 'move' = empty writable target (copy-in migration).
// 'adopt' = already contains our data (pointer switch only, no move). 'recover' = a durable marker
// from an interrupted copy that Settings can explicitly finish or discard. 'invalid' carries a reason.
// `dataRoot` is the derived `<parent>/OpenScience` path, always present so the caller can display
// the final location regardless of kind. Main also reports whether a move target was proven absent;
// callers that require a brand-new target must fail closed unless `targetWasAbsent` is true.
export type DataRootKind = 'move' | 'adopt' | 'recover' | 'invalid'
export type DataRootRecoveryStatus = 'copying' | 'verified'
export type DataRootInspection =
  | {
      kind: 'recover'
      dataRoot: string
      recoveryStatus: DataRootRecoveryStatus
      // Free bytes on the filesystem that contains the candidate data root. This is advisory: the
      // migration's scan performs the authoritative preflight immediately before copying.
      targetAvailableBytes?: number
      error?: string
    }
  | {
      kind: 'move'
      dataRoot: string
      targetWasAbsent?: boolean
      // Free bytes on the filesystem that contains the candidate data root. This is advisory: the
      // migration's scan performs the authoritative preflight immediately before copying.
      targetAvailableBytes?: number
      recoveryStatus?: never
      error?: string
    }
  | {
      kind: Exclude<DataRootKind, 'recover' | 'move'>
      dataRoot: string
      // Free bytes on the filesystem that contains the candidate data root. This is advisory: the
      // migration's scan performs the authoritative preflight immediately before copying.
      targetAvailableBytes?: number
      recoveryStatus?: never
      error?: string
    }
