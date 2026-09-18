import { isAbsolute, resolve } from 'node:path'

import type { NotebookProcessSandbox } from '../notebook/process-sandbox'

type CertificationEnvironment = Readonly<Record<string, string | undefined>>

type PackagedRestartCertificationInput = Readonly<{
  appPackaged: boolean
  headless: boolean
  platform: NodeJS.Platform
  arch: string
  previewAvailable: boolean
  storageRoot: string
  environment: CertificationEnvironment
  processSandbox: NotebookProcessSandbox
}>

const CERTIFICATION_SWITCH = 'OPEN_SCIENCE_E2E_WSL2_RESTART_CERTIFICATION'
const SAFE_IDENTITY = /^[A-Za-z0-9._-]{1,128}$/u

const requiredIdentity = (environment: CertificationEnvironment, key: string): string => {
  const value = environment[key]
  if (!value || !SAFE_IDENTITY.test(value)) {
    throw new Error('Packaged WSL2 restart certification is unavailable.')
  }
  return value
}

export const runPackagedWsl2RestartCertification = async (
  input: PackagedRestartCertificationInput
): Promise<boolean> => {
  if (input.environment[CERTIFICATION_SWITCH] !== '1') return false

  const expectedStorageRoot = input.environment.OPEN_SCIENCE_E2E_STORAGE_ROOT
  if (
    !input.appPackaged ||
    !input.headless ||
    input.platform !== 'win32' ||
    input.arch !== 'x64' ||
    !input.previewAvailable ||
    !expectedStorageRoot ||
    !isAbsolute(expectedStorageRoot) ||
    resolve(expectedStorageRoot).toLowerCase() !== resolve(input.storageRoot).toLowerCase()
  ) {
    throw new Error('Packaged WSL2 restart certification is unavailable.')
  }

  const target = {
    kind: 'wsl2' as const,
    profileId: requiredIdentity(input.environment, 'OPEN_SCIENCE_E2E_WSL2_PROFILE_ID'),
    distro: requiredIdentity(input.environment, 'OPEN_SCIENCE_E2E_WSL2_DISTRO'),
    user: requiredIdentity(input.environment, 'OPEN_SCIENCE_E2E_WSL2_USER')
  }
  const prepared = await input.processSandbox.wrap({
    target,
    executable: '/bin/bash',
    args: ['-c', 'true'],
    env: {},
    cwd: input.storageRoot,
    commandText: 'packaged-wsl2-restart-certification',
    executionReference: 'packaged-wsl2-restart-certification',
    sessionId: 'packaged-wsl2-restart-certification',
    projectId: 'packaged-wsl2-restart-certification',
    runtime: 'bash',
    filesystem: {
      readOnlyRoots: [],
      readWriteRoots: [input.storageRoot],
      deniedReadRoots: [],
      deniedWriteRoots: []
    }
  })

  let preparationError: unknown
  try {
    const admission = prepared.beginSpawn?.()
    if (!admission) {
      throw new Error('Packaged WSL2 restart certification is unavailable.')
    }
    admission.notStarted()
  } catch (error) {
    preparationError = error
  }

  const cleanup = await prepared.cleanup('spawn-failed', { processesTerminated: true })
  if (
    !cleanup.processesTerminated ||
    !cleanup.networkClosed ||
    !cleanup.temporaryResourcesRemoved
  ) {
    throw new Error('SHELL_CLEANUP_INCOMPLETE: Packaged WSL2 certification cleanup failed.')
  }
  if (preparationError) throw preparationError
  return true
}
