import { realpathSync } from 'node:fs'
import { join } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRuntimeBinding, RuntimeTargetReceipt } from '../../shared/notebook-runtime'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envDirectoryName,
  envPrefix,
  pythonBin,
  rBin
} from './runtime-paths'

type RuntimeTargetBinding = Pick<NotebookRuntimeBinding, 'source' | 'runtimeId' | 'label'> & {
  envName?: string
}

// One canonical executable-level identity for app-owned environments. A not-yet-materialized default
// keeps its future executable path; callers never fall back to the ambiguous environment short name.
const managedRuntimeIdentity = (
  runtimeRoot: string,
  language: NotebookLanguage,
  environmentName: string,
  platform: NodeJS.Platform = process.platform
): { prefix: string; runtimeId: string } => {
  const prefix = envPrefix(runtimeRoot, environmentName, platform)
  return managedRuntimeIdentityAtPrefix(prefix, language, platform)
}

const managedRuntimeIdentityAtPrefix = (
  prefix: string,
  language: NotebookLanguage,
  platform: NodeJS.Platform
): { prefix: string; runtimeId: string } => {
  const interpreter = language === 'r' ? rBin(prefix, platform) : pythonBin(prefix, platform)
  try {
    return { prefix, runtimeId: realpathSync(interpreter) }
  } catch {
    return { prefix, runtimeId: interpreter }
  }
}

// Windows preserves a healthy legacy default prefix across upgrades, but uninstall removes its marker.
// After removal, envPrefix() intentionally resolves to the short directory used for the next install.
// Persist policy against BOTH executable identities so the physical-layout transition cannot re-enable
// an explicitly uninstalled Runtime. Other platforms have one stable default identity.
const managedDefaultRuntimeIdentities = (
  runtimeRoot: string,
  language: NotebookLanguage,
  platform: NodeJS.Platform = process.platform
): readonly { prefix: string; runtimeId: string }[] => {
  const environmentName = language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  const current = managedRuntimeIdentity(runtimeRoot, language, environmentName, platform)
  const shortDirectory = envDirectoryName(environmentName, platform)
  if (shortDirectory === environmentName) return [current]
  const shortPrefix = join(runtimeRoot, 'envs', shortDirectory)
  const future = managedRuntimeIdentityAtPrefix(shortPrefix, language, platform)
  return current.runtimeId === future.runtimeId ? [current] : [current, future]
}

const runtimeTargetReceipt = (options: {
  runtimeRoot: string
  language: NotebookLanguage
  selection: 'implicit-default' | 'explicit-binding'
  binding?: RuntimeTargetBinding
  environmentName?: string
}): RuntimeTargetReceipt => {
  const { binding, language, runtimeRoot, selection } = options
  if (binding?.source === 'external') {
    return {
      language,
      selection,
      runtimeSource: 'external',
      runtimeId: binding.runtimeId,
      label: binding.label
    }
  }

  const environmentName =
    options.environmentName ??
    binding?.envName ??
    (language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV)
  const identity = managedRuntimeIdentity(runtimeRoot, language, environmentName)
  return {
    language,
    selection,
    runtimeSource: 'managed',
    environmentName,
    runtimeId: binding?.runtimeId || identity.runtimeId,
    label: binding?.label ?? environmentName,
    prefix: identity.prefix
  }
}

export { managedDefaultRuntimeIdentities, managedRuntimeIdentity, runtimeTargetReceipt }
