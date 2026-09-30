import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path'

import { notebookWorkloadCacheRoot } from './notebook-workload-cache-paths'

// POSIX npm launchers point outside PATH's bin directory in nvm and official Node installs.
// Read only the selected npm package, never its surrounding Node installation or user directory.
export const shellNpmReadRoots = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] => {
  if (platform === 'win32') return []
  for (const directory of (environment.PATH ?? '').split(posix.delimiter)) {
    if (!isAbsolute(directory)) continue
    const executable = join(directory, 'npm')
    try {
      accessSync(executable, constants.X_OK)
    } catch {
      continue
    }
    try {
      const cli = realpathSync.native(executable)
      const root = dirname(dirname(cli))
      return basename(cli) === 'npm-cli.js' &&
        basename(dirname(cli)) === 'bin' &&
        basename(root) === 'npm' &&
        basename(dirname(root)) === 'node_modules'
        ? [root]
        : []
    } catch {
      return []
    }
  }
  return []
}

// Host filesystem paths; WSL maps these only after checking the sandbox's authorized roots.
export const shellNpmPaths = (
  runtimeRoot: string,
  platform: NodeJS.Platform,
  arch: string = process.arch
): { prefix: string; cache: string; bin: string } => {
  const target = `${platform}-${arch}`
  const prefix = join(runtimeRoot, 'npm', target)
  return {
    prefix,
    cache: join(notebookWorkloadCacheRoot(runtimeRoot), 'npm', target),
    bin: platform === 'win32' ? prefix : join(prefix, 'bin')
  }
}

// Never follow a workload-created link while preparing a writable sandbox grant. The runtime root
// belongs to the data-root owner; only its physical children may become npm storage.
const prepareChild = (parent: string, name: string): string => {
  const child = join(parent, name)
  try {
    mkdirSync(child, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const state = lstatSync(child)
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    realpathSync.native(child) !== join(realpathSync.native(parent), name)
  ) {
    throw new Error('Shell npm storage is not a trusted directory.')
  }
  return child
}

export const prepareShellNpmEnvironment = (
  runtimeRoot: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  if (!isAbsolute(runtimeRoot))
    throw new Error('Shell npm storage requires an absolute runtime root.')
  const target = `${platform}-${process.arch}`
  const prefix = prepareChild(prepareChild(runtimeRoot, 'npm'), target)
  const cache = prepareChild(prepareChild(notebookWorkloadCacheRoot(runtimeRoot), 'npm'), target)
  const bin = platform === 'win32' ? prefix : prepareChild(prefix, 'bin')
  const separator = platform === 'win32' ? win32.delimiter : posix.delimiter
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !/^npm_config_(prefix|cache)$/i.test(key))
  )
  return {
    ...env,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_CACHE: cache,
    PATH: [bin, env.PATH].filter(Boolean).join(separator)
  }
}
