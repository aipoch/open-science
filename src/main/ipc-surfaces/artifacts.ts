import {
  createArtifactReproducibilityDependencies,
  type ArtifactReproducibilityAssembly
} from '../composition/artifact-reproducibility'
import type { ArtifactReproducibilityCommands } from '../artifacts/artifact-reproducibility-commands'
import { registerArtifactReproducibilityIpcHandlers } from '../artifacts/artifact-reproducibility-ipc'
import { registerArtifactIpcHandlers } from '../artifacts/ipc'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { createElectronSurfaceAdapter } from './adapter'

export const createArtifactElectronSurface = (
  owners: ArtifactReproducibilityAssembly & {
    reproducibilityCommands?: ArtifactReproducibilityCommands
  }
): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('artifacts', () => {
    const owner = owners.artifactReproducibilityAttemptOwnerRef.current
    if (!owner) throw new Error('Artifact reproducibility lifecycle is not configured.')
    registerArtifactIpcHandlers(
      owners.artifactRepository,
      owners.artifactRunRegistry,
      owners.artifactProvenanceRepository,
      (projectId, sessionId, mutation) =>
        owners.sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation),
      owners.artifactHandlers
    )
    return registerArtifactReproducibilityIpcHandlers(
      owner,
      createArtifactReproducibilityDependencies(owners),
      owners.reproducibilityCommands
    )
  })
