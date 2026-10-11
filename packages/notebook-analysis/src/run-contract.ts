/** Immutable evidence consumed by analysis; execution, storage and permission remain caller-owned. */
export type NotebookAnalysisRun = {
  runId: string
  agentFrameId?: string
  cellId: string
  kernelKind: 'python' | 'r' | 'repl' | 'bash'
  script: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'interrupted' | 'cancelled'
  kernelEpochId?: string
  kernelDispatched?: boolean
  replPersistentBindings?: true
  runtimeId?: string
  environment?: string
  cwdBefore?: string
  cwdAfter?: string
  frozenShellContext?: { cwd: string }
  helperModules?: {
    helperId: string
    sourceDigest: string
    exports: string[]
    interfaceRevision: string
    registeredGeneration: string
    source: string
  }[]
  helperEvidenceStatus?: { state: 'complete' } | { state: 'incomplete'; reasons: string[] }
  environmentManifest?: {
    executionContext?: {
      rPackages?: unknown
      before: { pythonRandomState?: { state: 'available' | 'unavailable' } }
    }
  }
  fileEvidence?: {
    state: 'available' | 'partial' | 'unavailable'
    activityId?: string
    activityKind: 'notebook-run' | 'compute-job'
    evidenceId?: string
    checksum?: string
    storageKey?: string
    relationCount?: number
    fileReads: 'complete' | 'partial' | 'unavailable'
    writerAttribution: 'complete' | 'partial' | 'unavailable'
  }
  workingFiles: NotebookWorkingFile[]
}
export type NotebookWorkingFile = {
  path: string
  relativePath: string
  createdByRunId?: string
  generationId?: string
  checksum?: string
  change?: 'created' | 'modified'
}
export type NotebookRunStaleness =
  | { state: 'clear' }
  | { state: 'stale'; causedByRunId: string; names: string[]; path: string[] }
  | { state: 'unknown'; reasons: string[] }
export type NotebookInvalidatedRun = {
  runId: string
  cellId: string
  names: string[]
} & ({ state: 'stale' } | { state: 'unknown'; reasons: string[] })
export type NotebookLanguage = 'python' | 'r'
// Internal compatibility name while preserving the existing algorithms verbatim.
export type NotebookRunRecord = NotebookAnalysisRun
