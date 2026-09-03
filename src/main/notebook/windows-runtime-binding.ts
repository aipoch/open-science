import { win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRuntimeBinding } from '../../shared/notebook-runtime'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envDirectoryName,
  logicalEnvNameFromDirectory,
  resolveEnvName
} from './runtime-paths'

export type WindowsManagedRuntimeLocation = {
  environment: string
  interpreterKey: string
  runtimeRoot: string
}

export const windowsRuntimePathKey = (path: string): string => win32.normalize(path).toLowerCase()

export const managedRuntimeEnvironmentNamesMatch = ({
  platform,
  candidate,
  expected
}: {
  platform: NodeJS.Platform
  candidate: string | undefined
  expected: string
}): boolean =>
  platform === 'win32'
    ? candidate?.toLowerCase() === expected.toLowerCase()
    : candidate === expected

export const managedRuntimeIdsDiffer = ({
  platform,
  candidate,
  previous
}: {
  platform: NodeJS.Platform
  candidate: string
  previous: string
}): boolean =>
  platform === 'win32' ? windowsRuntimePathKey(candidate) !== previous : candidate !== previous

const logicalWindowsEnvironmentName = (directory: string): string => {
  const logicalName = logicalEnvNameFromDirectory(directory)
  const defaultName = [DEFAULT_PY_ENV, DEFAULT_R_ENV].find(
    (name) => name.toLowerCase() === logicalName.toLowerCase()
  )
  return defaultName ?? logicalName
}

export const windowsManagedRuntimeLocation = ({
  language,
  platform,
  runtimeId
}: {
  language: NotebookLanguage
  platform: NodeJS.Platform
  runtimeId: string
}): WindowsManagedRuntimeLocation | undefined => {
  if (platform !== 'win32' || !win32.isAbsolute(runtimeId)) return undefined

  const normalizedRuntimeId = win32.normalize(runtimeId)
  const interpreterKey = windowsRuntimePathKey(runtimeId)
  let environmentDirectory: string
  if (language === 'python') {
    if (win32.basename(interpreterKey) !== 'python.exe') return undefined
    environmentDirectory = win32.dirname(normalizedRuntimeId)
  } else {
    if (win32.basename(interpreterKey) !== 'r.exe') return undefined
    const binDirectory = win32.dirname(normalizedRuntimeId)
    const rDirectory = win32.dirname(binDirectory)
    const libDirectory = win32.dirname(rDirectory)
    if (
      win32.basename(binDirectory).toLowerCase() !== 'bin' ||
      win32.basename(rDirectory).toLowerCase() !== 'r' ||
      win32.basename(libDirectory).toLowerCase() !== 'lib'
    ) {
      return undefined
    }
    environmentDirectory = win32.dirname(libDirectory)
  }

  const envsDirectory = win32.dirname(environmentDirectory)
  const runtimeRoot = win32.dirname(envsDirectory)
  if (
    win32.basename(envsDirectory).toLowerCase() !== 'envs' ||
    win32.basename(runtimeRoot).toLowerCase() !== 'runtime'
  ) {
    return undefined
  }

  return {
    environment: logicalWindowsEnvironmentName(win32.basename(environmentDirectory)),
    interpreterKey,
    runtimeRoot
  }
}

export const historicalWindowsManagedEnvironment = ({
  language,
  platform,
  wire
}: {
  language: NotebookLanguage
  platform: NodeJS.Platform
  wire: NotebookRuntimeBinding
}): WindowsManagedRuntimeLocation | undefined => {
  if (
    wire.language !== language ||
    wire.source !== 'managed' ||
    (wire.provenance !== 'app-managed' && wire.provenance !== 'agent-created')
  ) {
    return undefined
  }

  const interpreterKey = windowsRuntimePathKey(wire.interpreterPath)
  if (windowsRuntimePathKey(wire.runtimeId) !== interpreterKey) {
    return undefined
  }
  return windowsManagedRuntimeLocation({ language, platform, runtimeId: interpreterKey })
}

export const relocatedWindowsManagedRuntimeId = ({
  fromDataRoot,
  toDataRoot,
  language,
  platform,
  runtimeId
}: {
  fromDataRoot: string
  toDataRoot: string
  language: NotebookLanguage
  platform: NodeJS.Platform
  runtimeId: string
}): string | undefined => {
  const location = windowsManagedRuntimeLocation({ language, platform, runtimeId })
  if (!location) return undefined
  if (
    windowsRuntimePathKey(location.runtimeRoot) !==
    windowsRuntimePathKey(win32.join(fromDataRoot, 'runtime'))
  ) {
    return undefined
  }
  try {
    if (resolveEnvName(language, location.environment) !== location.environment) return undefined
  } catch {
    return undefined
  }
  const prefix = win32.join(
    toDataRoot,
    'runtime',
    'envs',
    envDirectoryName(location.environment, platform)
  )
  return language === 'python'
    ? win32.join(prefix, 'python.exe')
    : win32.join(prefix, 'Lib', 'R', 'bin', 'R.exe')
}
