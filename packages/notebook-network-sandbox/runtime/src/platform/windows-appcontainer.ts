import { spawn, type SpawnOptions } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'

import { proxyEnvironment } from './proxy-environment.js'
import { normalizeFilesystemLayout, type FilesystemLayoutInput } from './filesystem-layout.js'
import type { DependencyCheck } from './linux-isolation.js'
import {
  LOCAL_RPC_BROKER_HOST,
  sharedGatewayPortActive,
  type GatewayCredentials
} from '../gateway/command-gateway.js'

type WindowsShell = Readonly<{ kind: 'powershell' | 'cmd'; path: string }>

type WindowsRuntimeVerification = Readonly<{
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}>

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

type WindowsSupervisedLaunchRequest = Readonly<
  WindowsStandardLaunchRequest & Pick<WindowsLaunchRequest, 'cwd' | 'hostPath'>
>

type ProcessTreeTerminationProof = Readonly<{
  path: string
  token: string
  confirm: () => Promise<boolean>
}>

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
  args: readonly string[],
  options: Pick<SpawnOptions, 'env' | 'signal' | 'timeout'> & { maxBuffer?: number } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const { maxBuffer = Infinity, ...spawnOptions } = options
    const child = spawn(program, [...args], {
      ...spawnOptions,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let remaining = maxBuffer
    let overflow = false
    const capture = (chunk: string): string => {
      if (overflow) return ''
      remaining -= Buffer.byteLength(chunk)
      if (remaining < 0) {
        overflow = true
        return ''
      }
      return chunk
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += capture(chunk)))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += capture(chunk)))
    child.once('error', reject)
    // Keep draining until the native host closes so it can finish its process-tree cleanup proof.
    child.once('close', (code) => {
      if (overflow) reject(new Error('Windows AppContainer output exceeded its buffer limit.'))
      else resolve({ code, stdout, stderr })
    })
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
      errors.push('Notebook AppContainer resources have no valid Open-Science ownership receipt')
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

// ProcessStartInfo.Arguments uses Windows argv quoting, without a cmd.exe parsing layer.
const windowsProcessArgument = (value: string): string =>
  `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`

const windowsElevationScript = (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  command: 'setup' | 'remove' | 'authorize-runtime-access',
  args: readonly string[] = []
): string =>
  [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'try {',
    '$start = [System.Diagnostics.ProcessStartInfo]::new()',
    `$start.FileName = ${powershellString(hostPath)}`,
    `$start.Arguments = ${powershellString([command, installationId, ownershipRoot, ...args].map(windowsProcessArgument).join(' '))}`,
    '$start.UseShellExecute = $true',
    "$start.Verb = 'runas'",
    '$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
    // Windows PowerShell Start-Process discards Win32Exception.NativeErrorCode on launch failure.
    '$process = [System.Diagnostics.Process]::Start($start)',
    '$process.WaitForExit()',
    'exit $process.ExitCode',
    '} catch {',
    '$failure = $_.Exception',
    'while ($null -ne $failure) { if ($failure -is [System.ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 1223) { exit 1223 }; $failure = $failure.InnerException }',
    '[Console]::Error.WriteLine($_.Exception.Message)',
    'exit 1',
    '}'
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
  command: 'setup' | 'remove' | 'authorize-runtime-access',
  args: readonly string[] = []
): Promise<{ cancelled: boolean }> => {
  const script = windowsElevationScript(hostPath, installationId, ownershipRoot, command, args)
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
  if (result.code === 1223) {
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

const getWindowsRuntimeAccess = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  executable: string
): Promise<{ authorized: boolean; registered: boolean }> => {
  const status = await runCapture(hostPath, [
    'runtime-access-status',
    installationId,
    ownershipRoot,
    executable
  ])
  if (status.code !== 0)
    throw new Error(status.stderr.trim() || 'Could not inspect R runtime access.')
  const current: unknown = JSON.parse(status.stdout)
  if (
    !current ||
    typeof current !== 'object' ||
    typeof (current as { authorized?: unknown }).authorized !== 'boolean' ||
    typeof (current as { registered?: unknown }).registered !== 'boolean'
  ) {
    throw new Error('AppContainer host returned invalid runtime access status.')
  }
  return current as { authorized: boolean; registered: boolean }
}

const runVerifiedRuntimeAccess = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  verification: WindowsRuntimeVerification
): Promise<{ cancelled: boolean }> => {
  const ticket = randomBytes(32).toString('hex')
  const child = spawn(
    hostPath,
    [
      'verify-runtime-access',
      installationId,
      ownershipRoot,
      ticket,
      String(process.pid),
      verification.argv[4]!
    ],
    { env: verification.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  let exited = false
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.stdout.resume()
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-1024 * 1024)
    })
    child.once('error', (error) => {
      exited = true
      resolve({ code: null, error })
    })
    child.once('close', (code) => {
      exited = true
      resolve({ code })
    })
  })
  const stop = (): void => {
    if (!exited) child.kill()
  }
  verification.signal?.addEventListener('abort', stop, { once: true })
  try {
    if (!child.pid) {
      const failure = await completion
      throw failure.error ?? new Error('Could not start the R verification process.')
    }
    if (verification.signal?.aborted) return { cancelled: true }
    let result: { cancelled: boolean }
    try {
      result = await runElevatedHostCommand(
        hostPath,
        installationId,
        ownershipRoot,
        'authorize-runtime-access',
        [ticket, String(child.pid), String(process.pid)]
      )
    } catch (error) {
      stop()
      await completion
      throw new Error(
        [stderr.trim(), error instanceof Error ? error.message : String(error)]
          .filter(Boolean)
          .join('\n')
      )
    }
    if (result.cancelled) return result
    const verified = await completion
    if (verified.error || verified.code !== 0)
      throw verified.error ?? new Error(stderr.trim() || 'The contained R verification failed.')
    return result
  } finally {
    verification.signal?.removeEventListener('abort', stop)
    stop()
    await completion
  }
}

const setWindowsRuntimeAccess = async (
  hostPath: string,
  installationId: string,
  ownershipRoot: string,
  executable: string,
  authorized: boolean,
  verification?: WindowsRuntimeVerification
): Promise<{ cancelled: boolean }> => {
  const access = await getWindowsRuntimeAccess(hostPath, installationId, ownershipRoot, executable)
  if (
    verification &&
    (!authorized ||
      verification.argv.length !== 5 ||
      verification.argv[0] !== hostPath ||
      verification.argv[1] !== 'launch' ||
      verification.argv[2] !== installationId ||
      verification.argv[3] !== ownershipRoot)
  )
    throw new Error('R verification must use this installation’s contained launch.')
  if (verification?.signal?.aborted) return { cancelled: true }
  if ((authorized && access.authorized) || (!authorized && !access.registered)) {
    if (verification) {
      const result = await runCapture(hostPath, verification.argv.slice(1), {
        env: verification.env,
        signal: verification.signal,
        timeout: 20_000,
        maxBuffer: 1024 * 1024
      })
      if (result.code !== 0 || !result.stdout.includes('OPEN_SCIENCE_R_ACCESS_OK'))
        throw new Error(result.stderr.trim() || 'The contained R verification failed.')
    }
    return { cancelled: false }
  }
  const prepared = await runCapture(hostPath, [
    authorized
      ? verification
        ? 'prepare-verified-runtime-access'
        : 'prepare-runtime-access'
      : 'prepare-remove-runtime-access',
    installationId,
    ownershipRoot,
    executable
  ])
  if (prepared.code !== 0)
    throw new Error(prepared.stderr.trim() || 'Could not prepare R runtime access.')
  if (verification) {
    try {
      const result = await runVerifiedRuntimeAccess(
        hostPath,
        installationId,
        ownershipRoot,
        verification
      )
      if (result.cancelled)
        await runHostCommand(hostPath, installationId, ownershipRoot, 'cancel-setup')
      return result
    } catch (error) {
      // Safe only after the helper/verifier have exited. Native cancellation refuses to discard
      // a partially applied journal; failed rollback therefore remains repairable and visible.
      try {
        await runHostCommand(hostPath, installationId, ownershipRoot, 'cancel-setup')
      } catch (cleanup) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nR access repair is required: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`
        )
      }
      throw error
    }
  }
  const result = await runElevatedHostCommand(hostPath, installationId, ownershipRoot, 'setup')
  if (result.cancelled) {
    await runHostCommand(hostPath, installationId, ownershipRoot, 'cancel-setup')
  } else {
    await runHostCommand(hostPath, installationId, ownershipRoot, 'finish-setup')
  }
  return result
}

const createProcessTreeTerminationProof = (
  env: NodeJS.ProcessEnv,
  cwd: string
): ProcessTreeTerminationProof => {
  const token = randomUUID()
  const path = join(
    env.TEMP ?? env.TMP ?? cwd,
    `.open-science-process-tree-terminated-${token}.proof`
  )
  return {
    path,
    token,
    confirm: async () => {
      try {
        return (await readFile(path, 'utf8')) === token
      } catch {
        return false
      } finally {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  }
}

const windowsLaunch = (
  request: WindowsLaunchRequest
): {
  argv: string[]
  env: NodeJS.ProcessEnv
  confirmProcessTreeTermination: () => Promise<boolean>
} => {
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
  const proof = createProcessTreeTerminationProof(request.env, request.cwd)
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
      deniedWriteRoots: layout.deniedWriteRoots,
      terminationProofPath: proof.path,
      terminationProofToken: proof.token
    }),
    'utf8'
  ).toString('base64url')
  const env: NodeJS.ProcessEnv = {
    ...request.env,
    // CreateProcessW requires this base while applying AppContainer security capabilities. Windows
    // maps it to the profile's isolated Packages/.../AC directory for the sandboxed child.
    ...(request.env.LOCALAPPDATA === undefined && process.env.LOCALAPPDATA
      ? { LOCALAPPDATA: process.env.LOCALAPPDATA }
      : {}),
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
    env,
    confirmProcessTreeTermination: proof.confirm
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

const windowsSupervisedLaunch = (
  request: WindowsSupervisedLaunchRequest
): {
  argv: string[]
  env: NodeJS.ProcessEnv
  confirmProcessTreeTermination: () => Promise<boolean>
} => {
  // This path does not apply AppContainer capabilities or ACLs. It only asks the bundled host to
  // contain an opted-in standard-mode worker and its helpers in a kill-on-close Job Object.
  const direct = windowsStandardLaunch(request)
  const [executable, ...args] = direct.argv
  if (!executable) throw new Error('Windows supervisor received an empty command.')
  const proof = createProcessTreeTerminationProof(direct.env, request.cwd)
  const specification = Buffer.from(
    JSON.stringify({
      executable,
      arguments: args,
      cwd: request.cwd,
      readOnlyRoots: [],
      readWriteRoots: [],
      deniedReadRoots: [],
      deniedWriteRoots: [],
      terminationProofPath: proof.path,
      terminationProofToken: proof.token
    }),
    'utf8'
  ).toString('base64url')
  return {
    argv: [request.hostPath, 'supervise', specification],
    env: direct.env,
    confirmProcessTreeTermination: proof.confirm
  }
}

export {
  checkWindowsAppContainer,
  connectionProbeSpecification,
  installWindowsAppContainer,
  setWindowsRuntimeAccess,
  getWindowsRuntimeAccess,
  removeWindowsAppContainer,
  readAppContainerStatus,
  loopbackPortAvailable,
  windowsElevationScript,
  windowsLaunch,
  windowsSupervisedLaunch,
  windowsStandardLaunch
}
export type {
  AppContainerStatus,
  WindowsLaunchRequest,
  WindowsShell,
  WindowsStandardLaunchRequest,
  WindowsRuntimeVerification
}
