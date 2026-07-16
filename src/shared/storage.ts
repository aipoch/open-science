// Renderer-safe copies of storage types whose canonical definitions live in main-only modules
// (src/main/storage/*), mirroring how ArtifactFile/NotebookRunSummary are shared with preload.

export type UsageCategoryKey = 'artifacts' | 'uploads' | 'runtime' | 'notebooks'
export type UsageChild = { name: string; bytes: number }
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
export type StorageUsage = { categories: UsageCategory[]; totalBytes: number }

export type StorageInfo = {
  dataRoot: string
  isDefault: boolean
  // The default data root and the parent that reproduces it. Lets Settings offer a one-click
  // "return to default" (relocate back to <home>/OpenScience) when the current root is custom:
  // defaultParent is fed to the same inspect/migrate flow a browsed folder would be.
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
  usage: StorageUsage
  availableBytes: number
}

export type ActiveSessionInfo = {
  projectName: string
  sessionId: string
  kind: 'agent' | 'notebook'
  title?: string
}

export type MigrationPhase = 'scan' | 'copy' | 'verify' | 'delete'
export type MigrationProgress = {
  phase: MigrationPhase
  copiedBytes: number
  totalBytes: number
  currentPath?: string
}
export type MigrationResult = { ok: true } | { ok: false; error: string; cancelled?: boolean }
export type MigrationOutcome =
  MigrationResult | { ok: false; error: string; switchoverFailed: true }

// Result of validating (or applying) a candidate data root, mirroring main's ValidateResult
// (src/main/storage/migration-service.ts) without importing main-only code into the renderer.
export type DataRootValidationResult = { ok: true } | { ok: false; error: string }

// Classification of a candidate data root, mirroring main's ClassifyResult
// (src/main/storage/migration-service.ts). 'move' = empty writable target (copy-in migration).
// 'adopt' = already contains our data (pointer switch only, no move). 'invalid' carries a reason.
// `dataRoot` is the derived `<parent>/OpenScience` path, always present so the caller can display
// the final location regardless of kind.
export type DataRootKind = 'move' | 'adopt' | 'invalid'
export type DataRootInspection = {
  kind: DataRootKind
  dataRoot: string
  error?: string
  // Non-blocking caution (e.g. a spaced path on macOS/Linux): the action still proceeds, but the
  // UI surfaces this so the user isn't surprised by a later broken Python/R environment.
  warning?: string
}
