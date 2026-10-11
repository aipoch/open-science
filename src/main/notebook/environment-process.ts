import type { InstallRequest, InstallResult } from '../../shared/notebook-env'
import {
  createInstallSpawn,
  installPackages,
  type InstallDeps,
  createMicromambaExecutor,
  createExecutableVerifier,
  killAndConfirmExit as confirmEnvironmentChildExit
} from '@aipoch/environment'
import {
  createPosixProcessTreeOwnership,
  trackOwnedPosixProcessTree,
  terminateProcessTree
} from '../process-tree'
import { nodeRuntimeEnvironment } from '../node-process-host'
import type { ChildProcess } from 'node:child_process'

// Reuse the application's authoritative process-tree owner across sandbox and installer paths.
const processHost = {
  createOwnership: createPosixProcessTreeOwnership,
  trackOwnership: trackOwnedPosixProcessTree,
  terminateTree: terminateProcessTree,
  nodeEnvironment: nodeRuntimeEnvironment
}
export const defaultSpawn = createInstallSpawn(processHost)
export const runMicromamba = createMicromambaExecutor(processHost)
export const killAndConfirmExit = (child: ChildProcess): Promise<boolean> =>
  confirmEnvironmentChildExit(child, terminateProcessTree)

export const verifyExecutable = createExecutableVerifier(runMicromamba)

// Host RPC identity and workspace resolution do not cross the environment package boundary.
// Preserve the authoritative process supervisor even when a caller needs no sandbox adapter.
export const installEnvironmentPackages = (
  request: InstallRequest,
  deps: Partial<InstallDeps> = {}
): Promise<InstallResult> => {
  const { language, packages, usePip, installer, channels, environment, operation, workspaceCwd } =
    request
  return installPackages(
    { language, packages, usePip, installer, channels, environment, operation, cwd: workspaceCwd },
    { ...deps, spawn: deps.spawn ?? defaultSpawn }
  )
}
