import { mkdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export type SkillRuntimeEnvironmentContributor = Readonly<{
  directoryEnvironment: Readonly<Record<string, string>>
}>

export type PreparedSkillRuntimeEnvironment = Readonly<{
  directories: readonly string[]
  env: Readonly<Record<string, string>>
}>

const commonRuntimeEnvironment: SkillRuntimeEnvironmentContributor = {
  directoryEnvironment: {
    TMPDIR: 'tmp',
    TMP: 'tmp',
    TEMP: 'tmp',
    XDG_CACHE_HOME: 'cache'
  }
}

const pythonRuntimeEnvironment: SkillRuntimeEnvironmentContributor = {
  directoryEnvironment: {
    PYTHONPYCACHEPREFIX: 'python/pycache',
    PIP_CACHE_DIR: 'python/pip-cache',
    PYTHONUSERBASE: 'python/user-base'
  }
}

const nodeRuntimeEnvironment: SkillRuntimeEnvironmentContributor = {
  directoryEnvironment: {
    NODE_COMPILE_CACHE: 'node/compile-cache',
    npm_config_cache: 'node/npm-cache'
  }
}

const rRuntimeEnvironment: SkillRuntimeEnvironmentContributor = {
  directoryEnvironment: {
    R_USER_CACHE_DIR: 'r/cache',
    R_USER_CONFIG_DIR: 'r/config',
    R_USER_DATA_DIR: 'r/data',
    R_LIBS_USER: 'r/library'
  }
}

const defaultRuntimeEnvironmentContributors = [
  commonRuntimeEnvironment,
  pythonRuntimeEnvironment,
  nodeRuntimeEnvironment,
  rRuntimeEnvironment
] as const

const resolveRuntimeDirectory = (runtimeRoot: string, candidate: string): string => {
  const root = resolve(runtimeRoot)
  const directory = resolve(root, candidate)
  const pathFromRoot = relative(root, directory)
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`Skill runtime environment path is outside the runtime root: ${candidate}`)
  }
  return directory
}

const prepareSkillRuntimeEnvironment = async (
  runtimeRoot: string,
  contributors: readonly SkillRuntimeEnvironmentContributor[] = []
): Promise<PreparedSkillRuntimeEnvironment> => {
  const env: Record<string, string> = {}
  const directories = new Set<string>()

  for (const contributor of [...defaultRuntimeEnvironmentContributors, ...contributors]) {
    for (const [name, candidate] of Object.entries(contributor.directoryEnvironment)) {
      const directory = resolveRuntimeDirectory(runtimeRoot, candidate)
      env[name] = directory
      directories.add(directory)
    }
  }

  await Promise.all([...directories].map((directory) => mkdir(directory, { recursive: true })))
  return Object.freeze({
    directories: Object.freeze([...directories]),
    env: Object.freeze(env)
  })
}

export {
  commonRuntimeEnvironment,
  nodeRuntimeEnvironment,
  prepareSkillRuntimeEnvironment,
  pythonRuntimeEnvironment,
  rRuntimeEnvironment
}
