import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import { rLibraryDir } from './runtime-paths'

const COMMON_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'] as const

const POSIX_ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'SHELL'] as const

const WINDOWS_ENV_ALLOWLIST = [
  'ComSpec',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SystemDrive',
  'SystemRoot',
  'WINDIR'
] as const

const projectEnvironment = (
  sourceEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  const keys = [
    ...COMMON_ENV_ALLOWLIST,
    ...(platform === 'win32' ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST)
  ]
  for (const key of keys) {
    const value = sourceEnv[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

const addControlledPowerShellModulePath = (
  env: NodeJS.ProcessEnv,
  sourceEnv: NodeJS.ProcessEnv
): void => {
  const modulePaths: string[] = []
  const programFiles = sourceEnv.ProgramFiles
  if (programFiles) {
    modulePaths.push(win32.join(programFiles, 'WindowsPowerShell', 'Modules'))
  }
  const windowsRoot = sourceEnv.SystemRoot ?? sourceEnv.WINDIR
  if (windowsRoot) {
    modulePaths.push(win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'))
  }
  if (modulePaths.length === 0) return
  const controlledModulePath = modulePaths.join(win32.delimiter)
  env.PSModulePath = controlledModulePath
  env.OPEN_SCIENCE_PSMODULEPATH = controlledModulePath
}

export const buildNotebookShellEnvironment = (
  handoffDir: string,
  platform: NodeJS.Platform = process.platform,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env = projectEnvironment(sourceEnv, platform)
  if (platform === 'win32') addControlledPowerShellModulePath(env, sourceEnv)
  env.OPEN_SCIENCE_HANDOFF_DIR = handoffDir
  return env
}

export const buildNotebookKernelEnvironment = (
  platform: NodeJS.Platform = process.platform,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => projectEnvironment(sourceEnv, platform)

type ManagedRuntimeProcessEnvironmentOptions = {
  language?: NotebookLanguage
  prefix?: string
  platform?: NodeJS.Platform
  sourceEnv?: NodeJS.ProcessEnv
}

const MANAGED_USER_STATE_KEYS = [
  'HOME',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME'
] as const

const R_USER_STATE_KEYS = [
  'R_USER',
  'R_HOME',
  'R_LIBS',
  'R_LIBS_USER',
  'R_LIBS_SITE',
  'R_ENVIRON',
  'R_ENVIRON_USER',
  'R_PROFILE',
  'R_PROFILE_USER'
] as const

type ManagedRuntimeHostStateScope = NotebookLanguage | 'all'

export const sanitizeManagedRuntimeHostState = (
  sourceEnv: NodeJS.ProcessEnv,
  scope?: ManagedRuntimeHostStateScope
): NodeJS.ProcessEnv => {
  const removed = new Set<string>([
    ...MANAGED_USER_STATE_KEYS,
    ...(scope === 'r' || scope === 'all' ? R_USER_STATE_KEYS : [])
  ])
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => {
      const normalized = key.toUpperCase()
      if (removed.has(normalized)) return false
      return !(
        (scope === 'python' || scope === 'all') &&
        (normalized.startsWith('PYTHON') || normalized.startsWith('PIP_'))
      )
    })
  )
}

export const buildManagedRuntimeProcessEnvironment = (
  root: string,
  options: ManagedRuntimeProcessEnvironmentOptions = {}
): NodeJS.ProcessEnv => {
  const platform = options.platform ?? process.platform
  const platformPath = platform === 'win32' ? win32 : posix
  const home = platformPath.join(root, 'home')
  const env = sanitizeManagedRuntimeHostState(options.sourceEnv ?? process.env, options.language)
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: platformPath.join(home, '.cache'),
    XDG_CONFIG_HOME: platformPath.join(home, '.config'),
    XDG_DATA_HOME: platformPath.join(home, '.local', 'share'),
    XDG_STATE_HOME: platformPath.join(home, '.local', 'state'),
    ...(options.language === 'python' ? { PYTHONNOUSERSITE: '1' } : {}),
    ...(options.language === 'r'
      ? {
          R_USER: home,
          ...(options.prefix ? { R_LIBS_USER: rLibraryDir(options.prefix, platform) } : {})
        }
      : {})
  }
}

export const notebookTrustBundleEnvironment = (path?: string): NodeJS.ProcessEnv =>
  path
    ? {
        CONDA_SSL_VERIFY: path,
        SSL_CERT_FILE: path,
        REQUESTS_CA_BUNDLE: path,
        PIP_CERT: path,
        CURL_CA_BUNDLE: path,
        NODE_EXTRA_CA_CERTS: path
      }
    : {}

export const environmentPathRoots = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isDirectory: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
): string[] => {
  const separator = platform === 'win32' ? win32.delimiter : posix.delimiter
  return (env.PATH ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => (platform === 'win32' ? win32.isAbsolute(entry) : posix.isAbsolute(entry)))
    .filter(isDirectory)
}
