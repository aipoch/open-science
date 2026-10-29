import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { McpStdioLaunch } from '@aipoch/connector-mcp-client'
import { augmentedPathEnv } from '../settings/shell-path'

const isFile = (path: string, executable = false): boolean => {
  try {
    accessSync(path, executable && process.platform !== 'win32' ? constants.X_OK : constants.F_OK)
    return statSync(path).isFile()
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false
    throw error
  }
}

export const prepareMcpStdioLaunch = (launch: McpStdioLaunch): McpStdioLaunch => {
  const environment = { ...launch.env }
  const windows = process.platform === 'win32'
  if (windows) {
    // A configured `Path` must override the inherited `PATH`, not create two Windows keys.
    for (const name of ['PATH', 'PATHEXT']) {
      const keys = Object.keys(environment).filter((key) => key.toUpperCase() === name)
      const value = environment[keys.at(-1) ?? name]
      for (const key of keys) delete environment[key]
      if (value !== undefined) environment[name] = value
    }
  }
  const env = augmentedPathEnv(environment) as Record<string, string>
  const result = { ...launch, env }
  const command = windows ? launch.command.toLowerCase() : launch.command
  // Explicit paths and other tools retain their existing behavior, including launch errors.
  if (!['npm', 'npx', ...(windows ? ['npm.cmd', 'npx.cmd'] : [])].includes(command)) return result

  const extensions = windows
    ? ['', ...(env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
    : ['']
  const directories = env.PATH.split(delimiter)
  if (windows) directories.unshift(process.cwd())
  for (const directory of directories) {
    for (const extension of extensions) {
      if (isFile(join(directory.replace(/^"|"$/g, ''), launch.command + extension), true))
        return result
    }
  }

  // The desktop backend (and bundled CLI archive) runs under this ordinary Node executable.
  // npm is staged beside it; an ordinary system Node installation has no app bundle here.
  const runtime = dirname(process.execPath)
  const cli = join(runtime, 'node_modules', 'npm', 'bin', `${command.replace(/\.cmd$/, '')}-cli.js`)
  if (!isFile(join(runtime, 'version.json')) || !isFile(cli)) return result
  return {
    command: process.execPath,
    args: [cli, ...launch.args],
    // npm and package bin scripts must use the same Node, even if another Node is on PATH.
    env: { ...env, PATH: [runtime, env.PATH].join(delimiter) }
  }
}
