import type { NotebookExecutionContext } from './execution-context'
import type { CondaRuntimeSubsetPlan } from '@aipoch/environment/contracts'
import type {
  ArtifactReproducibilityEnvironmentRequirement,
  ArtifactReproducibilityRecipeStep,
  NotebookHelperModuleEvidence
} from './evidence'
export type ReproductionEvidence = {
  resolveFile(key: string): string
  readEnvironmentLock(checksum: string, signal?: AbortSignal): Promise<string | undefined>
}
export type ReproductionFileIO = {
  digestFile(
    path: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<{ sizeBytes: number; checksum: string }>
  copyFile(
    source: string,
    destination: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<{ sizeBytes: number; checksum: string }>
}
export type NotebookReproductionStep = Extract<
  ArtifactReproducibilityRecipeStep,
  { kind: 'notebook-run' }
>
export type NotebookReproductionRuntime = {
  environmentLocks?: NotebookReproductionRestoredEnvironment[]
  // Observed use proposes a candidate; only the execution owner can compare all
  // frozen outputs and accept it after the reference process has been reaped.
  proposeRuntimeSubset?: () => Promise<CondaRuntimeSubsetPlan | undefined>
  execute(input: {
    stageRestore?: {
      inputPath: string
      expectedOutputPath: string
      packageContext?: {
        schemaVersion: 1
        sourcePackages: string[]
        targetPackages: string[]
      }
      observeRuntimeFootprint?: true
    }
    stageSupplement?: { inputPath: string; expectedOutputPath: string; names: string[] }
    stageExpectedOutputPath?: string
    step: NotebookReproductionStep
    source: string
    executionContext?: NotebookExecutionContext
    sessionRoot: string
    kernelEpochId?: string
    helperModules?: NotebookHelperModuleEvidence[]
    signal?: AbortSignal
  }): Promise<{
    status: 'completed' | 'failed' | 'timeout' | 'cancelled'
    stdout: string
    stderr: string
    traceback: string
    truncated?: boolean
    stageComparison?: {
      outcome: 'equal' | 'different' | 'unavailable'
      reason?: string
      scientificOutcome?: 'equal' | 'different'
      packageContext?: {
        schemaVersion: 1
        sourcePackages: string[]
        targetPackages: string[]
      }
      runtimeFootprint?: {
        processId: number
        packages: Array<{ name: string; version: string }>
        libraryPaths: string[]
      }
    }
  }>
  shutdown(): Promise<{ reaped: boolean }>
}
export type NotebookReproductionRestoredEnvironment = {
  requirementId: string
  kernelKind: 'python' | 'r'
  environmentName?: string
  lockChecksum: string
  sourceLockChecksum?: string
  runtimeSubset?: {
    schemaVersion: 1
    scopeChecksum: string
    planChecksum: string
    archiveNames: string[]
    missingDependencies: Array<{ packageName: string; dependency: string }>
  }
}
export type NotebookReproductionEnvironmentProgress = {
  requirementId: string
  kernelKind: 'python' | 'r'
  index: number
  total: number
  stage: 'validating-lock' | 'restoring-packages' | 'verifying-runtime' | 'completed'
}
export type NotebookReproductionEnvironmentOutput = {
  requirementId: string
  kernelKind: 'python' | 'r'
  index: number
  total: number
  stream: 'stdout' | 'stderr'
  text: string
}
export type CreateReproductionRuntime = (input: {
  requirements: ArtifactReproducibilityEnvironmentRequirement[]
  runtimeSubset?: { scopeChecksum: string; plan?: CondaRuntimeSubsetPlan }
  selectedRuns?: Array<{
    stageCheckpoint?: import('./evidence').RStageCheckpointCapture
    step: NotebookReproductionStep
    source: string
    executionContext?: NotebookExecutionContext
  }>
  attemptRoot: string
  signal?: AbortSignal
  onEnvironmentProgress?: (event: NotebookReproductionEnvironmentProgress) => void
  onEnvironmentOutput?: (event: NotebookReproductionEnvironmentOutput) => void
}) => Promise<NotebookReproductionRuntime>
export type ReproductionRecipeOptions = {
  inputPath(filename: string, checksum: string): string
  fileIO: Pick<ReproductionFileIO, 'digestFile'>
}
