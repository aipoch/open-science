import { sha256 } from './canonical'
import type { ProvenanceNotebookRun, RStageCheckpoint, RStageEnvironmentProof } from './evidence'

export const MAX_R_STAGE_CHECKPOINT_BYTES = 128 * 1024 * 1024

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const names = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 4096 &&
  value.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 1024) &&
  new Set(value).size === value.length

// Proofs are all-or-nothing evidence. Never drop malformed or duplicate package records.
export const validRStageEnvironmentProof = (value: unknown): value is RStageEnvironmentProof =>
  record(value) &&
  Object.keys(value).length === 2 &&
  value.schemaVersion === 1 &&
  Array.isArray(value.packages) &&
  value.packages.length > 0 &&
  value.packages.length <= 4096 &&
  value.packages.every(
    (pkg) =>
      record(pkg) &&
      Object.keys(pkg).length === 2 &&
      typeof pkg.name === 'string' &&
      pkg.name.length <= 128 &&
      /^[A-Za-z][A-Za-z0-9.]*$/u.test(pkg.name) &&
      typeof pkg.version === 'string' &&
      pkg.version.length > 0 &&
      pkg.version.length <= 128 &&
      /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u.test(pkg.version)
  ) &&
  new Set(value.packages.map((pkg) => pkg.name)).size === value.packages.length

export const validRStageCheckpoint = (value: unknown): value is RStageCheckpoint => {
  if (
    !record(value) ||
    value.state !== 'available' ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some(
      (key) =>
        ![
          'state',
          'schemaVersion',
          'runId',
          'kernelEpochId',
          'sourceChecksum',
          'environmentLockChecksum',
          'environmentProof',
          'input',
          'output',
          'inputNames',
          'outputNames'
        ].includes(key)
    ) ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    typeof value.kernelEpochId !== 'string' ||
    !value.kernelEpochId ||
    !hash(value.sourceChecksum) ||
    !hash(value.environmentLockChecksum) ||
    (value.environmentProof !== undefined &&
      !validRStageEnvironmentProof(value.environmentProof)) ||
    !names(value.inputNames) ||
    !names(value.outputNames)
  )
    return false
  return [value.input, value.output].every(
    (file) =>
      record(file) &&
      Object.keys(file).length === 3 &&
      hash(file.checksum) &&
      Number.isSafeInteger(file.sizeBytes) &&
      Number(file.sizeBytes) > 0 &&
      Number(file.sizeBytes) <= MAX_R_STAGE_CHECKPOINT_BYTES &&
      file.storageKey === `runtime/provenance/r-stage-checkpoints/${file.checksum}.rds`
  )
}

export const validRStageCheckpointForRun = (
  run:
    | Pick<
        ProvenanceNotebookRun,
        | 'stageCheckpoint'
        | 'runId'
        | 'kernelEpochId'
        | 'script'
        | 'kernelKind'
        | 'status'
        | 'environmentLock'
      >
    | undefined
): boolean => {
  if (!run) return false
  const checkpoint = run.stageCheckpoint
  return (
    validRStageCheckpoint(checkpoint) &&
    run.kernelKind === 'r' &&
    run.status === 'completed' &&
    checkpoint.runId === run.runId &&
    checkpoint.kernelEpochId === run.kernelEpochId &&
    checkpoint.sourceChecksum === sha256(run.script) &&
    run.environmentLock?.state === 'available' &&
    checkpoint.environmentLockChecksum === run.environmentLock.lockChecksum
  )
}
