import { homedir, tmpdir } from 'node:os'
import { basename } from 'node:path'

import { findExecutable } from './executable.js'
import {
  absolutePhysicalPath,
  normalizeFilesystemLayout,
  type FilesystemLayoutInput
} from './filesystem-layout.js'
import { proxyEnvironment } from './proxy-environment.js'
import type { GatewayCredentials } from '../gateway/command-gateway.js'

type MacLaunchRequest = Readonly<{
  command: string
  shell: string
  gatewayPort: number
  gatewayCredentials: GatewayCredentials
  env: NodeJS.ProcessEnv
  localRpcSocketPath?: string
  filesystem: FilesystemLayoutInput
}>

const literal = (value: string): string => JSON.stringify(value)
const subtree = (value: string): string => `(subpath ${literal(value)})`

const allFilters = (filters: readonly string[]): string =>
  filters.length === 1 ? filters[0]! : `(require-all ${filters.join(' ')})`

const exceptRoots = (roots: readonly string[]): string | undefined => {
  if (roots.length === 0) return undefined
  return allFilters(roots.map((root) => `(require-not ${subtree(root)})`))
}

const seatbeltProfile = (request: MacLaunchRequest): string => {
  const layout = normalizeFilesystemLayout({
    ...request.filesystem,
    privateRoot: request.filesystem.privateRoot ?? homedir()
  })
  const readable = [...layout.readOnlyRoots, ...layout.readWriteRoots]
  const rules = ['(version 1)', '(allow default)', '(deny network*)']
  rules.push(`(allow network-outbound (remote ip "localhost:${request.gatewayPort}"))`)
  if (request.localRpcSocketPath) {
    rules.push(
      `(allow network-outbound (literal ${literal(absolutePhysicalPath(request.localRpcSocketPath))}))`
    )
  }
  const sensitiveReadRoots = [
    '/Users',
    '/Volumes',
    tmpdir(),
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/tmp',
    ...(layout.privateRoot && layout.privateRoot !== '/Users' ? [layout.privateRoot] : [])
  ].map(absolutePhysicalPath)
  for (const sensitiveRoot of new Set(sensitiveReadRoots)) {
    rules.push(
      `(deny file-read* ${allFilters([
        subtree(sensitiveRoot),
        ...readable.map((root) => `(require-not ${subtree(root)})`)
      ])})`
    )
  }
  for (const root of layout.deniedReadRoots) rules.push(`(deny file-read* ${subtree(root)})`)
  if (sensitiveReadRoots.length > 0 || layout.deniedReadRoots.length > 0) {
    // realpath and NSBundle must stat protected ancestor directories to resolve an allowed child.
    // This exposes directory metadata only; file contents and directory listings remain denied.
    rules.push('(allow file-read-metadata (vnode-type DIRECTORY))')
  }
  const outsideWritable = exceptRoots([...layout.readWriteRoots, '/dev/null'])
  rules.push(outsideWritable ? `(deny file-write* ${outsideWritable})` : '(deny file-write*)')
  for (const root of new Set([...layout.deniedReadRoots, ...layout.deniedWriteRoots])) {
    rules.push(`(deny file-write* ${subtree(root)})`)
  }
  return rules.join('\n')
}

const shellArguments = (shell: string, command: string): readonly string[] => {
  const name = basename(shell).toLowerCase()
  if (name === 'bash' || name === 'bash.exe') {
    return [shell, '--noprofile', '--norc', '-c', command]
  }
  if (name === 'zsh' || name === 'zsh.exe') {
    return [shell, '-d', '-f', '-c', command]
  }
  return [shell, '-c', command]
}

const macosLaunch = (request: MacLaunchRequest): { argv: string[]; env: NodeJS.ProcessEnv } => {
  const shell = findExecutable(request.shell, request.env.PATH)
  if (!shell) throw new Error(`Notebook sandbox shell is not executable: ${request.shell}`)
  return {
    argv: [
      '/usr/bin/sandbox-exec',
      '-p',
      seatbeltProfile(request),
      ...shellArguments(shell, request.command)
    ],
    env: {
      ...request.env,
      ...proxyEnvironment(request.gatewayPort, request.gatewayCredentials)
    }
  }
}

export { macosLaunch, seatbeltProfile }
export type { MacLaunchRequest }
