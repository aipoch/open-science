import { isAbsolute, join, normalize } from 'node:path'

export const PROD_SESSION_DIR_NAME = '.open-science'
export const DEV_SESSION_DIR_NAME = '.open-science-project'

// Shared by synchronous bootstrap and later Electron-backed callers. Only the first nonblank
// override participates; packaged apps deliberately ignore the development-only STORAGE_ROOT.
export const resolveConfigRootOverride = (
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const keys = [
    'OPEN_SCIENCE_E2E_STORAGE_ROOT',
    'OPEN_SCIENCE_CONFIG_ROOT',
    ...(!packaged ? ['OPEN_SCIENCE_STORAGE_ROOT'] : [])
  ]
  for (const key of keys) {
    const value = env[key]?.trim()
    if (!value) continue
    if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path.`)
    return normalize(value)
  }
  return undefined
}

export const resolveBootstrapConfigRoot = (
  home: string | (() => string),
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string =>
  resolveConfigRootOverride(packaged, env) ??
  join(
    typeof home === 'function' ? home() : home,
    packaged ? PROD_SESSION_DIR_NAME : DEV_SESSION_DIR_NAME
  )
