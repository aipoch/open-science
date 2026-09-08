import { statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type {
  ArtifactReproducibilityRecipe,
  PersistedArtifactExecutionSnapshot
} from '../../shared/artifact-provenance'

export class ReproductionPreflightError extends Error {
  constructor(readonly reason: 'environment-transition' | 'insufficient-disk-space') {
    super(
      reason === 'environment-transition'
        ? 'The selected runs changed environment locks within one kernel epoch. Run them together in a fixed environment to capture a new version.'
        : 'The isolated workspace does not have enough free space for the captured inputs.'
    )
  }
}

export const validateReproductionContext = (
  execution: PersistedArtifactExecutionSnapshot,
  frontierId: string
): void => {
  const recipe = execution.reproducibilityRecipe
  const frontier = recipe?.frontiers.find((f) => f.frontierId === frontierId)
  if (!recipe || !frontier) return // The authoritative recipe validator supplies this error.
  const runs = new Map(execution.runs.map((run) => [run.runId, run]))
  const locks = new Map(
    recipe.environmentRequirements.map((requirement) => [
      requirement.requirementId,
      requirement.lockChecksum
    ])
  )
  const epochs = new Map<string, string>()
  for (const step of recipe.steps) {
    if (!frontier.stepIds.includes(step.stepId) || step.kind !== 'notebook-run') continue
    const run = runs.get(step.runId)
    const lock = step.environmentRequirementId
      ? locks.get(step.environmentRequirementId)
      : undefined
    if (!run || !lock) continue
    const epoch = JSON.stringify([step.kernelKind, run.kernelEpochId ?? run.runId])
    const previous = epochs.get(epoch)
    if (previous && previous !== lock)
      throw new ReproductionPreflightError('environment-transition')
    epochs.set(epoch, lock)
  }
}

// All file copying/hashing remains streaming. Disk preflight estimates the required physical
// copies, including duplicate bytes materialized at different paths, on the actual temp volume.
export const validateReproductionDiskSpace = async (
  recipe: ArtifactReproducibilityRecipe,
  frontierId: string,
  freeBytes: () => Promise<number | undefined> = async () => {
    try {
      const stat = await statfs(tmpdir())
      return stat.bavail * stat.bsize
    } catch {
      return undefined
    }
  }
): Promise<void> => {
  const frontier = recipe.frontiers.find((f) => f.frontierId === frontierId)
  if (!frontier) return
  const required = frontier.crossingFiles.reduce((bytes, file) => bytes + file.sizeBytes, 0)
  const available = await freeBytes()
  if (
    available !== undefined &&
    Number.isFinite(available) &&
    available < required + 64 * 1024 * 1024
  )
    throw new ReproductionPreflightError('insufficient-disk-space')
}
