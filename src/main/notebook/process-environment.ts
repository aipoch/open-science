import { statSync } from 'node:fs'
import { delimiter, isAbsolute, win32 } from 'node:path'

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
  const separator = platform === 'win32' ? win32.delimiter : delimiter
  return (env.PATH ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => (platform === 'win32' ? win32.isAbsolute(entry) : isAbsolute(entry)))
    .filter(isDirectory)
}
