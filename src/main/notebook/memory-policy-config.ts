import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const NOTEBOOK_MEMORY_POLICY_CONFIG_FILE = 'notebook-memory-policy.json'

type NotebookMemoryPolicy = Readonly<{
  windowsEnterRatio: number
  windowsExitRatio: number
  linuxEnterRatio: number
  linuxExitRatio: number
  macNormalRecoveryMs: number
}>

type NotebookMemoryPolicyConfigResult = Readonly<{
  policy: NotebookMemoryPolicy
  source: 'default' | 'file' | 'fallback'
  diagnostic?: 'invalid-json' | 'invalid-values' | 'read-failed'
}>

const DEFAULT_NOTEBOOK_MEMORY_POLICY: NotebookMemoryPolicy = Object.freeze({
  windowsEnterRatio: 0.1,
  windowsExitRatio: 0.2,
  linuxEnterRatio: 0.1,
  linuxExitRatio: 0.2,
  macNormalRecoveryMs: 20_000
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRatio = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0.01 && value <= 0.9

const isRecoveryDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 5_000 && value <= 300_000

const readOptionalNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return value === undefined ? undefined : typeof value === 'number' ? value : Number.NaN
}

const parsePolicy = (value: unknown): NotebookMemoryPolicy | undefined => {
  if (!isRecord(value)) return undefined

  const windowsEnterRatio = readOptionalNumber(value, 'windowsEnterRatio')
  const windowsExitRatio = readOptionalNumber(value, 'windowsExitRatio')
  const linuxEnterRatio = readOptionalNumber(value, 'linuxEnterRatio')
  const linuxExitRatio = readOptionalNumber(value, 'linuxExitRatio')
  const macNormalRecoveryMs = readOptionalNumber(value, 'macNormalRecoveryMs')
  const policy = {
    windowsEnterRatio: windowsEnterRatio ?? DEFAULT_NOTEBOOK_MEMORY_POLICY.windowsEnterRatio,
    windowsExitRatio: windowsExitRatio ?? DEFAULT_NOTEBOOK_MEMORY_POLICY.windowsExitRatio,
    linuxEnterRatio: linuxEnterRatio ?? DEFAULT_NOTEBOOK_MEMORY_POLICY.linuxEnterRatio,
    linuxExitRatio: linuxExitRatio ?? DEFAULT_NOTEBOOK_MEMORY_POLICY.linuxExitRatio,
    macNormalRecoveryMs: macNormalRecoveryMs ?? DEFAULT_NOTEBOOK_MEMORY_POLICY.macNormalRecoveryMs
  }

  if (
    !isRatio(policy.windowsEnterRatio) ||
    !isRatio(policy.windowsExitRatio) ||
    policy.windowsExitRatio <= policy.windowsEnterRatio ||
    !isRatio(policy.linuxEnterRatio) ||
    !isRatio(policy.linuxExitRatio) ||
    policy.linuxExitRatio <= policy.linuxEnterRatio ||
    !isRecoveryDuration(policy.macNormalRecoveryMs)
  ) {
    return undefined
  }

  return Object.freeze(policy)
}

const loadNotebookMemoryPolicyConfig = async (
  configRoot: string
): Promise<NotebookMemoryPolicyConfigResult> => {
  let contents: string
  try {
    contents = await readFile(join(configRoot, NOTEBOOK_MEMORY_POLICY_CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { policy: DEFAULT_NOTEBOOK_MEMORY_POLICY, source: 'default' }
    }
    return { policy: DEFAULT_NOTEBOOK_MEMORY_POLICY, source: 'fallback', diagnostic: 'read-failed' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return {
      policy: DEFAULT_NOTEBOOK_MEMORY_POLICY,
      source: 'fallback',
      diagnostic: 'invalid-json'
    }
  }

  const policy = parsePolicy(parsed)
  return policy
    ? { policy, source: 'file' }
    : { policy: DEFAULT_NOTEBOOK_MEMORY_POLICY, source: 'fallback', diagnostic: 'invalid-values' }
}

export {
  DEFAULT_NOTEBOOK_MEMORY_POLICY,
  NOTEBOOK_MEMORY_POLICY_CONFIG_FILE,
  loadNotebookMemoryPolicyConfig,
  type NotebookMemoryPolicy,
  type NotebookMemoryPolicyConfigResult
}
