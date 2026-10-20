import type { NotebookExecutionContext } from './execution-context'
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
  execute(input: {
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
  }>
  shutdown(): Promise<{ reaped: boolean }>
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
  attemptRoot: string
  signal?: AbortSignal
  onEnvironmentProgress?: (event: NotebookReproductionEnvironmentProgress) => void
  onEnvironmentOutput?: (event: NotebookReproductionEnvironmentOutput) => void
}) => Promise<NotebookReproductionRuntime>
export type ReproductionRecipeOptions = {
  inputPath(filename: string, checksum: string): string
  fileIO: Pick<ReproductionFileIO, 'digestFile'>
}
