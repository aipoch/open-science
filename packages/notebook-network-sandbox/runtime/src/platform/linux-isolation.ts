import { createServer, connect, type Server, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { findExecutable } from './executable.js'
import {
  contains,
  normalizeFilesystemLayout,
  pathIsDirectory,
  type FilesystemLayoutInput
} from './filesystem-layout.js'
import { proxyEnvironment } from './proxy-environment.js'
import type { GatewayCredentials } from '../gateway/command-gateway.js'

type DependencyCheck = Readonly<{ warnings: string[]; errors: string[] }>

type LinuxLaunchRequest = Readonly<{
  command: string
  shell: string
  cwd: string
  gatewayPort: number
  gatewayCredentials: GatewayCredentials
  env: NodeJS.ProcessEnv
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  filesystem: FilesystemLayoutInput
}>

type LinuxLaunch = Readonly<{
  argv: string[]
  env: NodeJS.ProcessEnv
  release: () => Promise<void>
}>

const checkLinuxTools = (): DependencyCheck => {
  const errors: string[] = []
  if (!findExecutable('bwrap')) {
    errors.push(
      'Notebook isolation requires bubblewrap (bwrap). Install the bubblewrap package with your Linux distribution package manager, then restart Open Science.'
    )
  }
  return { warnings: [], errors }
}

class UnixGatewayBridge {
  readonly #directory: string
  readonly #server: Server
  readonly #peers = new Set<Socket>()
  readonly socketPath: string

  private constructor(directory: string, server: Server) {
    this.#directory = directory
    this.#server = server
    this.socketPath = join(directory, 'gateway.sock')
  }

  static async open(gatewayPort: number): Promise<UnixGatewayBridge> {
    const directory = await mkdtemp(join(tmpdir(), 'os-notebook-'))
    const server = createServer()
    const bridge = new UnixGatewayBridge(directory, server)
    server.on('connection', (client) => {
      const upstream = connect({ host: '127.0.0.1', port: gatewayPort })
      bridge.#peers.add(client)
      bridge.#peers.add(upstream)
      const forget = (): void => {
        bridge.#peers.delete(client)
        bridge.#peers.delete(upstream)
      }
      client.once('close', forget)
      upstream.once('close', forget)
      client.once('error', () => upstream.destroy())
      upstream.once('error', () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(bridge.socketPath, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      await chmod(bridge.socketPath, 0o600)
      server.unref()
      return bridge
    } catch (error) {
      server.close()
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async close(): Promise<void> {
    for (const peer of this.#peers) peer.destroy()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
    await rm(this.#directory, { recursive: true, force: true })
  }
}

const gatewayBridgeProgram = String.raw`
const net = require('node:net')
const { spawn } = require('node:child_process')
const [socketPath, portText, shell, command, descriptorCountText, childElectronRunAsNode] = process.argv.slice(1)
const descriptorCount = Number(descriptorCountText)
const peers = new Set()
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath)
  peers.add(client)
  peers.add(upstream)
  const forget = () => { peers.delete(client); peers.delete(upstream) }
  client.once('close', forget)
  upstream.once('close', forget)
  client.once('error', () => upstream.destroy())
  upstream.once('error', () => client.destroy())
  client.pipe(upstream).pipe(client)
})
server.once('error', (error) => { console.error(error.message); process.exit(125) })
server.listen(Number(portText), '127.0.0.1', () => {
  if (childElectronRunAsNode) process.env.ELECTRON_RUN_AS_NODE = childElectronRunAsNode
  else delete process.env.ELECTRON_RUN_AS_NODE
  const stdio = Array.from({ length: 3 + descriptorCount }, () => 'inherit')
  const child = spawn(shell, ['-c', command], { env: process.env, stdio })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal))
  }
  child.once('error', (error) => { console.error(error.message); process.exitCode = 125; server.close() })
  child.once('exit', (code, signal) => {
    for (const peer of peers) peer.destroy()
    process.exitCode = code ?? (signal ? 128 : 125)
    server.close(() => process.exit())
  })
})
`

const linuxLaunch = async (request: LinuxLaunchRequest): Promise<LinuxLaunch> => {
  const bwrap = findExecutable('bwrap', request.env.PATH)
  const shell = findExecutable(request.shell, request.env.PATH)
  if (!bwrap) throw new Error('Notebook sandbox requires bubblewrap (bwrap).')
  if (!shell) throw new Error(`Notebook sandbox shell is not executable: ${request.shell}`)
  if (
    request.inheritedFileDescriptorCount !== undefined &&
    (!Number.isSafeInteger(request.inheritedFileDescriptorCount) ||
      request.inheritedFileDescriptorCount < 1 ||
      request.inheritedFileDescriptorCount > 16)
  ) {
    throw new Error('Notebook sandbox inherited file descriptor count is invalid.')
  }

  const bridge = await UnixGatewayBridge.open(request.gatewayPort)
  const layout = normalizeFilesystemLayout({
    ...request.filesystem,
    privateRoot: request.filesystem.privateRoot ?? homedir()
  })
  const guestSocket = '/run/open-science-notebook/gateway.sock'
  const guestRpcSocket = request.localRpcSocketPath
    ? '/run/open-science-notebook/notebook-rpc.sock'
    : undefined
  const guestRuntimeRoot = '/run/open-science-notebook/runtime'
  const guestRuntime = join(guestRuntimeRoot, basename(process.execPath))
  const runtimeSource = dirname(process.execPath)
  const guestPort = 3128
  const argumentsList = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--cap-drop',
    'ALL',
    // bubblewrap passes inherited descriptors through to the sandbox command. The descriptor count
    // is consumed by the gateway bridge below so its nested child inherits the same fd range.
    '--ro-bind',
    '/',
    '/',
    '--tmpfs',
    '/run',
    '--dir',
    '/run/open-science-notebook',
    '--bind',
    bridge.socketPath,
    guestSocket,
    ...(guestRpcSocket ? ['--bind', request.localRpcSocketPath!, guestRpcSocket] : []),
    '--dir',
    guestRuntimeRoot,
    '--ro-bind',
    runtimeSource,
    guestRuntimeRoot,
    '--tmpfs',
    '/tmp',
    ...(existsSync('/var/tmp') ? ['--tmpfs', '/var/tmp'] : []),
    '--dev',
    '/dev',
    '--proc',
    '/proc'
  ]

  const sensitiveReadRoots = [
    '/home',
    '/mnt',
    '/media',
    '/run/media',
    ...(layout.privateRoot ? [layout.privateRoot] : [])
  ]
    .filter(
      (root, index, roots) => root !== '/' && roots.indexOf(root) === index && existsSync(root)
    )
    .filter((root, _index, roots) =>
      roots.every((other) => other === root || !contains(other, root))
    )
  for (const sensitiveRoot of sensitiveReadRoots) {
    argumentsList.push('--tmpfs', sensitiveRoot)
    for (const root of [...layout.readOnlyRoots, ...layout.readWriteRoots]) {
      if (contains(sensitiveRoot, root)) argumentsList.push('--ro-bind', root, root)
    }
    argumentsList.push('--remount-ro', sensitiveRoot)
  }
  for (const root of layout.readWriteRoots) argumentsList.push('--bind', root, root)
  for (const root of layout.deniedWriteRoots) argumentsList.push('--ro-bind', root, root)
  for (const root of layout.deniedReadRoots) {
    if (pathIsDirectory(root)) argumentsList.push('--tmpfs', root)
    else argumentsList.push('--ro-bind', '/dev/null', root)
  }
  // Bind explicitly writable children before sealing the anonymous temp mounts. bubblewrap applies
  // operations in order, so remounting /tmp first would make a workspace created under /tmp
  // impossible to bind on Linux CI and on distributions whose project roots live there.
  argumentsList.push('--remount-ro', '/tmp')
  if (existsSync('/var/tmp')) argumentsList.push('--remount-ro', '/var/tmp')

  argumentsList.push(
    '--chdir',
    request.cwd,
    '--',
    guestRuntime,
    '-e',
    gatewayBridgeProgram,
    guestSocket,
    String(guestPort),
    shell,
    request.command,
    String(request.inheritedFileDescriptorCount ?? 0),
    request.env.ELECTRON_RUN_AS_NODE ?? ''
  )

  return {
    argv: [bwrap, ...argumentsList],
    env: {
      ...request.env,
      ...proxyEnvironment(guestPort, request.gatewayCredentials),
      ...(guestRpcSocket ? { OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: guestRpcSocket } : {}),
      ELECTRON_RUN_AS_NODE: '1'
    },
    release: () => bridge.close()
  }
}

export { checkLinuxTools, linuxLaunch }
export type { DependencyCheck, LinuxLaunch, LinuxLaunchRequest }
