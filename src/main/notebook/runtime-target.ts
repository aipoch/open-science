import { realpathSync } from 'node:fs'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookRuntimeBinding, RuntimeTargetReceipt } from '../../shared/notebook-runtime'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix, pythonBin, rBin } from './runtime-paths'

type RuntimeTargetBinding = Pick<NotebookRuntimeBinding, 'source' | 'runtimeId' | 'label'> & {
  envName?: string
}

// One canonical executable-level identity for app-owned environments. A not-yet-materialized default
// keeps its future executable path; callers never fall back to the ambiguous environment short name.
const managedRuntimeIdentity = (
  runtimeRoot: string,
  language: NotebookLanguage,
  environmentName: string
): { prefix: string; runtimeId: string } => {
  const prefix = envPrefix(runtimeRoot, environmentName)
  const interpreter = language === 'r' ? rBin(prefix) : pythonBin(prefix)
  try {
    return { prefix, runtimeId: realpathSync(interpreter) }
  } catch {
    return { prefix, runtimeId: interpreter }
  }
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

export { managedRuntimeIdentity, runtimeTargetReceipt }
