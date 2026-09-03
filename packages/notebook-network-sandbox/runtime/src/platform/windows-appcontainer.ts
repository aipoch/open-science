import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, type Server } from 'node:net'

import { proxyEnvironment } from './proxy-environment.js'
import { normalizeFilesystemLayout, type FilesystemLayoutInput } from './filesystem-layout.js'
import type { DependencyCheck } from './linux-isolation.js'
import {
  LOCAL_RPC_BROKER_HOST,
  sharedGatewayPortActive,
  type GatewayCredentials
} from '../gateway/command-gateway.js'

type WindowsShell = Readonly<{ kind: 'powershell' | 'cmd'; path: string }>

type WindowsLaunchRequest = Readonly<{
  command: string
  executable?: string
  args?: readonly string[]
  shell?: string | WindowsShell
  cwd: string
  gatewayPort: number
  gatewayCredentials: GatewayCredentials
  env: NodeJS.ProcessEnv
  localRpcSocketPath?: string
  filesystem: FilesystemLayoutInput
  hostPath: string
  installationId: string
  ownershipRoot: string
}>

const WINDOWS_BATCH_FILE = /\.(?:cmd|bat)$/i
const CMD_META_CHARACTER = /([()\][%!^"`<>&|;, *?])/g

// Ported from cross-spawn's Windows non-shell parser. Batch files require cmd.exe, while escaping
// each token and asking the native host to preserve the resulting command line prevents cmd syntax
// in an interpreter path or argument from becoming a second command.
const escapeCmdCommand = (value: string): string => value.replace(CMD_META_CHARACTER, '^$1')

const escapeCmdArgument = (value: string, doubleEscapeMetaCharacters: boolean): string => {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')
  escaped = `"${escaped}"`.replace(CMD_META_CHARACTER, '^$1')
  return doubleEscapeMetaCharacters ? escaped.replace(CMD_META_CHARACTER, '^$1') : escaped
}

const windowsBatchInvocation = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Readonly<{ executable: string; args: string[]; verbatimArguments: true }> => {
  const command = [
    escapeCmdCommand(executable),
    // cmd.exe parses the invocation once and a batch file parses its expanded arguments again.
    ...args.map((argument) => escapeCmdArgument(argument, true))
  ].join(' ')
  return {
    executable: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    verbatimArguments: true
  }
}

type WindowsStandardLaunchRequest = Readonly<
  Pick<
    WindowsLaunchRequest,
    | 'command'
    | 'executable'
    | 'args'
    | 'shell'
    | 'gatewayPort'
    | 'gatewayCredentials'
    | 'env'
    | 'localRpcSocketPath'
  >
>

type AppContainerStatus = Readonly<{
  profileExists: boolean
  loopbackAllowed: boolean
  networkFenceReady: boolean
  owned: boolean
  ownershipState: 'unowned' | 'creating' | 'owned'
  gatewayPort: number | null
}>

const loopbackPortAvailable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })

const listen = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })

const closeServer = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })

const runCapture = (
  program: string,
  args: readonly string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })

const readAppContainerStatus = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string
): Promise<AppContainerStatus> => {
  const result = await runCapture(hostPath, ['status', installationId, ownershipRoot])
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `AppContainer host exited with code ${result.code}.`)
  }
  const parsed: unknown = JSON.parse(result.stdout)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as AppContainerStatus).profileExists !== 'boolean' ||
    typeof (parsed as AppContainerStatus).loopbackAllowed !== 'boolean' ||
    typeof (parsed as AppContainerStatus).networkFenceReady !== 'boolean' ||
    typeof (parsed as AppContainerStatus).owned !== 'boolean' ||
    ((parsed as AppContainerStatus).gatewayPort !== null &&
      (!Number.isInteger((parsed as AppContainerStatus).gatewayPort) ||
        (parsed as AppContainerStatus).gatewayPort! < 1 ||
        (parsed as AppContainerStatus).gatewayPort! > 65535)) ||
    !['unowned', 'creating', 'owned'].includes((parsed as AppContainerStatus).ownershipState)
  ) {
    throw new Error('AppContainer host returned an invalid status payload.')
  }
  return parsed as AppContainerStatus
}

const connectionProbeSpecification = (port: number): string => {
  const command = [
    '$client = [Net.Sockets.TcpClient]::new()',
    `try { $connect = $client.ConnectAsync('127.0.0.1', ${port}); if (-not $connect.Wait(5000)) { exit 34 }; $connect.GetAwaiter().GetResult(); exit 0 }`,
    'catch { exit 33 }',
    'finally { $client.Dispose() }'
  ].join('\n')
  return Buffer.from(
    JSON.stringify({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      cwd: process.env.SystemRoot ?? 'C:\\Windows',
      readOnlyRoots: [],
      readWriteRoots: [],
      deniedReadRoots: [],
      deniedWriteRoots: []
    }),
    'utf8'
  ).toString('base64url')
}

const verifyWindowsNetworkFence = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  gatewayPort: number
): Promise<boolean> => {
  let outside: Server | undefined
  let gateway: Server | undefined
  try {
    outside = await listen(0)
    const outsideAddress = outside.address()
    if (!outsideAddress || typeof outsideAddress === 'string') return false
    if (!sharedGatewayPortActive(gatewayPort)) gateway = await listen(gatewayPort)
    const outsideProbe = await runCapture(hostPath, [
      'launch',
      installationId,
      ownershipRoot,
      connectionProbeSpecification(outsideAddress.port)
    ])
    if (outsideProbe.code === 0) return false
    const gatewayProbe = await runCapture(hostPath, [
      'launch',
      installationId,
      ownershipRoot,
      connectionProbeSpecification(gatewayPort)
    ])
    return gatewayProbe.code === 0
  } catch {
    return false
  } finally {
    await Promise.all([closeServer(outside), closeServer(gateway)])
  }
}

const checkWindowsAppContainer = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string
): Promise<DependencyCheck> => {
  try {
    await access(hostPath, constants.X_OK)
  } catch {
    return { warnings: [], errors: [`Notebook AppContainer host not executable at ${hostPath}`] }
  }
  try {
    const status = await readAppContainerStatus(hostPath, installationId, ownershipRoot)
    const errors: string[] = []
    if (!status.profileExists) errors.push('Notebook AppContainer profile is not installed')
    if (!status.loopbackAllowed)
      errors.push('Notebook AppContainer loopback access is not installed')
    if (!status.networkFenceReady)
      errors.push('Notebook AppContainer loopback network fence is not installed')
    if (!status.owned || status.ownershipState !== 'owned')
      errors.push('Notebook AppContainer resources have no valid Open Science ownership receipt')
    if (status.gatewayPort === null) {
      errors.push('Notebook AppContainer gateway port is not configured')
    } else if (!sharedGatewayPortActive(status.gatewayPort)) {
      if (!(await loopbackPortAvailable(status.gatewayPort))) {
        errors.push(`Notebook AppContainer gateway port ${status.gatewayPort} is unavailable`)
      } else if (
        errors.length === 0 &&
        !(await verifyWindowsNetworkFence(
          hostPath,
          installationId,
          ownershipRoot,
          status.gatewayPort
        ))
      ) {
        errors.push('Notebook AppContainer loopback network fence is not installed')
      }
    } else if (
      errors.length === 0 &&
      !(await verifyWindowsNetworkFence(
        hostPath,
        installationId,
        ownershipRoot,
        status.gatewayPort
      ))
    ) {
      errors.push('Notebook AppContainer loopback network fence is not installed')
    }
    return { warnings: [], errors }
  } catch (error) {
    return { warnings: [], errors: [error instanceof Error ? error.message : String(error)] }
  }
}

const powershellString = (value: string): string => `'${value.replaceAll("'", "''")}'`

const windowsElevationScript = (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  command: 'setup' | 'remove'
): string =>
  [
    'try {',
    `$process = Start-Process -FilePath ${powershellString(hostPath)} -ArgumentList @('${command}', ${powershellString(installationId)}, ${powershellString(ownershipRoot)}) -Verb RunAs -Wait -PassThru`,
    'exit $process.ExitCode',
    '} catch { exit 1223 }'
  ].join('; ')

const runHostCommand = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  command: 'prepare-setup' | 'cancel-setup' | 'finish-setup' | 'prepare-remove' | 'finish-remove'
): Promise<void> => {
  const result = await runCapture(hostPath, [command, installationId, ownershipRoot])
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `AppContainer host exited with code ${result.code}.`)
  }
}

const runElevatedHostCommand = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  command: 'setup' | 'remove'
): Promise<{ cancelled: boolean }> => {
  const script = windowsElevationScript(hostPath, installationId, ownershipRoot, command)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = await runCapture('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded
  ]).catch((error) => ({
    code: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error)
  }))
  if (result.code === 0) return { cancelled: false }
  if (
    result.code === 1223 ||
    /cancell?ed by the user|operation was canceled|1223/i.test(result.stderr)
  ) {
    return { cancelled: true }
  }
  throw new Error(
    result.stderr.trim() || `Windows AppContainer ${command} exited with code ${result.code}.`
  )
}

const installWindowsAppContainer = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string
): Promise<{ cancelled: boolean }> => {
  await runHostCommand(hostPath, installationId, ownershipRoot, 'prepare-setup')
  const elevated = await runElevatedHostCommand(hostPath, installationId, ownershipRoot, 'setup')
  if (elevated.cancelled) {
    await runHostCommand(hostPath, installationId, ownershipRoot, 'cancel-setup')
    return elevated
  }
  await runHostCommand(hostPath, installationId, ownershipRoot, 'finish-setup')
  return elevated
}

const removeWindowsAppContainer = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string
): Promise<{ cancelled: boolean }> => {
  await runHostCommand(hostPath, installationId, ownershipRoot, 'prepare-remove')
  const elevated = await runElevatedHostCommand(hostPath, installationId, ownershipRoot, 'remove')
  if (elevated.cancelled) return elevated
  await runHostCommand(hostPath, installationId, ownershipRoot, 'finish-remove')
  return elevated
}

const windowsLaunch = (
  request: WindowsLaunchRequest
): { argv: string[]; env: NodeJS.ProcessEnv } => {
  const shell: WindowsShell =
    typeof request.shell === 'object'
      ? request.shell
      : request.shell
        ? { kind: 'cmd', path: request.shell }
        : { kind: 'powershell', path: 'powershell.exe' }
  const childArgs =
    shell.kind === 'powershell'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', request.command]
      : ['/d', '/s', '/c', request.command]
  const directInvocation = request.executable
    ? WINDOWS_BATCH_FILE.test(request.executable)
      ? windowsBatchInvocation(request.executable, request.args ?? [], request.env)
      : { executable: request.executable, args: [...(request.args ?? [])] }
    : { executable: shell.path, args: childArgs }
  const layout = normalizeFilesystemLayout(request.filesystem)
  const specification = Buffer.from(
    JSON.stringify({
      executable: directInvocation.executable,
      arguments: directInvocation.args,
      ...('verbatimArguments' in directInvocation
        ? { verbatimArguments: directInvocation.verbatimArguments }
        : {}),
      cwd: request.cwd,
      readOnlyRoots: layout.readOnlyRoots,
      readWriteRoots: layout.readWriteRoots,
      deniedReadRoots: layout.deniedReadRoots,
      deniedWriteRoots: layout.deniedWriteRoots
    }),
    'utf8'
  ).toString('base64url')
  const env = {
    ...request.env,
    ...proxyEnvironment(request.gatewayPort, request.gatewayCredentials)
  }
  if (request.localRpcSocketPath) {
    env.OPEN_SCIENCE_MCP_RPC_ENDPOINT = `http://${LOCAL_RPC_BROKER_HOST}/`
    delete env.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH
  }
  return {
    argv: [
      request.hostPath,
      'launch',
      request.installationId,
      request.ownershipRoot,
      specification
    ],
    env
  }
}

const windowsStandardLaunch = (
  request: WindowsStandardLaunchRequest
): { argv: string[]; env: NodeJS.ProcessEnv } => {
  const shell: WindowsShell =
    typeof request.shell === 'object'
      ? request.shell
      : request.shell
        ? { kind: 'cmd', path: request.shell }
        : { kind: 'powershell', path: 'powershell.exe' }
  // PowerShell does not transparently relay a redirected stdin stream to a long-lived native child:
  // a Notebook loop can observe EOF and exit before the executor writes its first protocol frame.
  // Preserve structured native invocations in standard mode just as protected mode does. Batch
  // shims still need a command shell, so retain the existing serialized-command path for them.
  const argv =
    request.executable && !WINDOWS_BATCH_FILE.test(request.executable)
      ? [request.executable, ...(request.args ?? [])]
      : shell.kind === 'powershell'
        ? [shell.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', request.command]
        : [shell.path, '/d', '/s', '/c', request.command]
  const env = {
    ...request.env,
    ...proxyEnvironment(request.gatewayPort, request.gatewayCredentials)
  }
  if (request.localRpcSocketPath) {
    env.OPEN_SCIENCE_MCP_RPC_ENDPOINT = `http://${LOCAL_RPC_BROKER_HOST}/`
    delete env.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH
  }
  return { argv, env }
}

export {
  checkWindowsAppContainer,
  connectionProbeSpecification,
  installWindowsAppContainer,
  removeWindowsAppContainer,
  readAppContainerStatus,
  loopbackPortAvailable,
  windowsElevationScript,
  windowsLaunch,
  windowsStandardLaunch
}
export type { AppContainerStatus, WindowsLaunchRequest, WindowsShell, WindowsStandardLaunchRequest }
