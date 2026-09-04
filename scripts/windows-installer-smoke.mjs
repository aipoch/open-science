/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  parsePackagedSqliteVersion,
  readDatabaseMigrationLedger,
  seedLegacyDatabase,
  verifyDatabaseMigrationLedger,
  verifyLegacyProjectPreserved,
  writeDatabaseMigrationCertification
} from './database-migration-ledger-smoke.mjs'
import { authenticatePackagedAppEndpoint } from './packaged-web-service-auth.mjs'

const APP_EXECUTABLE = 'open-science.exe'
const ARTIFACT_MCP_SERVER_ARG = '--open-science-artifact-mcp'
const NOTEBOOK_MCP_SERVER_ARG = '--open-science-notebook-mcp'
const CONFIG_DIRECTORY = '.open-science'
const PROCESS_TIMEOUT_MS = 120_000
const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 60_000
const HTTP_REQUEST_TIMEOUT_MS = 15_000
const TERMINATION_TIMEOUT_MS = 10_000
const MCP_REQUEST_TIMEOUT_MS = 30_000
const SMOKE_ROOT_PREFIX = 'open-science-installer-smoke-'
const RPC_SMOKE_ROOT_PREFIX = 'open-science-rpc-smoke-'
const UPGRADE_SENTINEL_PREFIX = 'installer-smoke-upgrade-sentinel-'
const UPGRADE_SENTINEL_CONTENT = 'previous-version-profile-preserved\n'
const RPC_SMOKE_CONTENT = 'windows-rpc-smoke\n'
const ORPHANED_UNINSTALLER_LOCK_SCENARIO = 'orphaned-uninstaller-lock'
const RPC_SMOKE_RESERVATION_ID = 'installer-smoke-reservation'
const RPC_SMOKE_ARTIFACT_SCOPE = {
  projectId: 'installer-smoke-project',
  appSessionId: 'installer-smoke-session',
  artifactStorageSessionId: 'installer-smoke-session',
  artifactRunId: 'installer-smoke-artifact-run'
}

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const pathExists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const findSetupInstaller = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && /-win-x64-setup\.exe$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one Windows setup executable in ${directory}; found ${candidates.length}.`
    )
  }
  return candidates[0]
}

const installerVersion = (installer) => {
  const match = basename(installer).match(/^aipoch-open-science-(.+)-win-x64-setup\.exe$/i)
  if (!match) throw new Error(`Cannot derive the app version from installer: ${installer}`)
  return match[1]
}

const buildSmokePlan = ({ currentInstaller, previousInstaller }) => [
  ...(previousInstaller
    ? [
        { installer: previousInstaller, phase: 'previous' },
        { installer: currentInstaller, phase: 'current', runningInstaller: previousInstaller },
        {
          installer: previousInstaller,
          phase: 'rollback',
          runningInstaller: currentInstaller,
          launchInstalledApp: false
        },
        { installer: currentInstaller, phase: 'restart' }
      ]
    : [{ installer: currentInstaller, phase: 'current' }])
]

const executeSmokePlan = async (plan, runCycle) => {
  for (const cycle of plan) await runCycle(cycle)
}

const fetchWithTimeout = (
  input,
  init = {},
  timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch
) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })

const requestPackagedAppShutdown = async (endpoint, auth, fetchImpl = fetchWithTimeout) => {
  const response = await fetchImpl(`${endpoint}/api/shutdown?${auth}`, { method: 'POST' })
  // Drain the response before waiting for Electron to exit. Leaving an Undici response body unread
  // keeps its HTTP connection active, while the app's quit path waits for the web server to close.
  // Waiting for exit first would therefore deadlock the smoke harness against the app under test.
  const body = await response.text()
  if (response.status !== 202) {
    throw new Error(
      `Installed app shutdown returned HTTP ${response.status}.${body ? ` ${body}` : ''}`
    )
  }
}

const parsePackagedAppEndpoint = (output) => {
  const match = output.match(
    /Open Science Web:\s+(http:\/\/127\.0\.0\.1:\d+\/(?:\?token=[A-Za-z0-9_-]+)?)/
  )
  if (!match) return undefined

  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  return {
    endpoint: url.origin,
    ...(token ? { auth: `token=${encodeURIComponent(token)}` } : {})
  }
}

const readPackagedAppConfigRoot = async (
  bootstrap,
  expectedVersion,
  { auth, legacyConfigRoots = [], readToken = readFile } = {}
) => {
  if (
    bootstrap.appName !== 'Open Science' ||
    bootstrap.appVersion !== expectedVersion ||
    bootstrap.platform !== 'win32'
  ) {
    throw new Error(`Unexpected installed app bootstrap: ${JSON.stringify(bootstrap)}`)
  }
  if (bootstrap.configRoot !== undefined) {
    if (typeof bootstrap.configRoot !== 'string' || !win32.isAbsolute(bootstrap.configRoot)) {
      throw new Error('Installed app did not report an absolute Windows config root.')
    }
    return bootstrap.configRoot
  }

  const candidates = [
    ...new Map(
      legacyConfigRoots
        .filter((candidate) => typeof candidate === 'string' && win32.isAbsolute(candidate))
        .map((candidate) => [win32.resolve(candidate).toLowerCase(), candidate])
    ).values()
  ]
  if (candidates.length === 0) {
    throw new Error('Installed app did not report an absolute Windows config root.')
  }
  const endpointToken = auth ? new URLSearchParams(auth).get('token') : undefined
  if (!endpointToken) {
    throw new Error('Cannot authenticate the legacy installed app config root without its token.')
  }
  // Older packaged builds do not report configRoot. Electron has ignored the child USERPROFILE in
  // hosted runs, but retain the isolated profile as a compatibility candidate. The endpoint token
  // authenticates whichever directory the previous app actually used instead of trusting either.
  for (const candidate of candidates) {
    try {
      const storedToken = (await readToken(win32.join(candidate, 'web-token'), 'utf8')).trim()
      if (storedToken === endpointToken) return candidate
    } catch {
      // Try the next authenticated candidate.
    }
  }
  throw new Error('Cannot authenticate the legacy installed app config root from its token file.')
}

const terminateProcessTree = async (
  child,
  timeoutMs = TERMINATION_TIMEOUT_MS,
  spawnProcess = spawn
) => {
  if (!child.pid) return
  const killDirectly = () => {
    try {
      child.kill()
    } catch {
      // Best effort: the process may already have exited between the timeout and fallback.
    }
  }
  let terminator
  try {
    terminator = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    killDirectly()
    return
  }
  await new Promise((resolveTermination) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveTermination()
    }
    const timer = setTimeout(() => {
      try {
        terminator.kill()
      } catch {
        // The taskkill process may have exited without delivering its event yet.
      }
      terminator.unref?.()
      killDirectly()
      finish()
    }, timeoutMs)
    terminator.once('error', () => {
      killDirectly()
      finish()
    })
    terminator.once('exit', (code) => {
      if (code !== 0 && code !== null) killDirectly()
      finish()
    })
  })
}

const runProcess = (executable, args, options = {}, terminate = terminateProcessTree) =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let stopping = false
    let abortProcess

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (abortProcess) options.signal?.removeEventListener('abort', abortProcess)
      if (error) rejectProcess(error)
      else resolveProcess({ code, stdout, stderr })
    }

    const stopProcess = (error) => {
      if (settled || stopping) return
      stopping = true
      clearTimeout(timer)
      void Promise.resolve()
        .then(() => terminate(child))
        .then(
          () => finish(error),
          () => finish(error)
        )
    }

    const timer = setTimeout(() => {
      stopProcess(
        new Error(
          `${basename(executable)} timed out after ${options.timeoutMs ?? PROCESS_TIMEOUT_MS}ms.`
        )
      )
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS)

    abortProcess = () => {
      stopProcess(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error(`${basename(executable)} was aborted.`)
      )
    }
    options.signal?.addEventListener('abort', abortProcess, { once: true })
    if (options.signal?.aborted) abortProcess()

    child.once('error', (error) => {
      if (!stopping) finish(error)
    })
    child.once('exit', (code) => {
      if (stopping) return
      if (code !== 0 && !options.allowNonZero) {
        finish(
          new Error(
            `${basename(executable)} exited with ${code}.\n${stdout}${stderr ? `\n${stderr}` : ''}`
          )
        )
        return
      }
      finish(undefined, code)
    })
  })

const waitFor = async (description, check, timeoutMs = STARTUP_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== undefined && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(
    `Timed out waiting for ${description}.${lastError instanceof Error ? ` ${lastError.message}` : ''}`
  )
}

const observeChildExit = (child) =>
  new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })

const observeChildClose = (child) =>
  new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', resolveClose)
  })

const waitForShutdownExit = (
  exit,
  child,
  output,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  terminate = terminateProcessTree
) =>
  new Promise((resolveExit, rejectExit) => {
    let settled = false
    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectExit(error)
      else resolveExit(code)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void terminate(child).finally(() => {
        rejectExit(new Error(`Installed app did not exit after shutdown.\n${output()}`))
      })
    }, timeoutMs)
    exit.then(
      (code) => finish(undefined, code),
      (error) => finish(error)
    )
  })

const packagedResourcePaths = (installDirectory) => [
  join(installDirectory, APP_EXECUTABLE),
  join(installDirectory, 'resources', 'app.asar'),
  join(installDirectory, 'resources', 'micromamba.exe'),
  join(
    installDirectory,
    'resources',
    'node_modules',
    '.prisma',
    'client',
    'query_engine-windows.dll.node'
  )
]

const packagedMainEntryPath = (installDirectory) =>
  join(installDirectory, 'resources', 'app.asar', 'out', 'main', 'index.js')

const stringEnvironment = (environment) =>
  Object.fromEntries(Object.entries(environment).filter((entry) => typeof entry[1] === 'string'))

const listenOnPipe = (server, socketPath) =>
  new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.off('error', onError)
      resolveListen()
    })
  })

const closeServer = (server) =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })

const readJsonBody = async (request) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  return JSON.parse(body)
}

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

const assertPackagedArtifactScope = (params, requireWriteOperationId) => {
  if (
    Object.entries(RPC_SMOKE_ARTIFACT_SCOPE).some(
      ([key, expectedValue]) => params[key] !== expectedValue
    ) ||
    (requireWriteOperationId &&
      !/^artifact-write-[0-9a-f]{64}$/.test(params.writeOperationId ?? ''))
  ) {
    throw new Error('Unexpected packaged Artifact write scope.')
  }
}

const packagedArtifactSmokeRpcResult = (body, workspace, artifactRpcContract = 'reservation') => {
  const params = body.params ?? {}
  const fileBytes = Buffer.byteLength(RPC_SMOKE_CONTENT)
  if (body.method === 'artifactReserveWrite') {
    if (artifactRpcContract !== 'reservation') {
      throw new Error('Legacy packaged Artifact RPC must not reserve a write.')
    }
    assertPackagedArtifactScope(params, true)
    if (params.filename !== 'windows-rpc-smoke.txt' || params.fileBytes !== fileBytes) {
      throw new Error('Unexpected packaged Artifact write reservation request.')
    }
    return {
      id: RPC_SMOKE_RESERVATION_ID,
      fileBytes,
      expiresAt: Date.now() + PROCESS_TIMEOUT_MS
    }
  }
  if (body.method === 'artifactCreateVersion') {
    assertPackagedArtifactScope(params, true)
    const checksum = createHash('sha256').update(RPC_SMOKE_CONTENT).digest('hex')
    if (artifactRpcContract === 'legacy') {
      if (
        params.resourceReservationId !== undefined ||
        params.resourceSizeBytes !== undefined ||
        params.resourceChecksum !== undefined
      ) {
        throw new Error('Legacy packaged Artifact Version must omit reservation metadata.')
      }
    } else if (
      params.resourceReservationId !== RPC_SMOKE_RESERVATION_ID ||
      params.resourceSizeBytes !== fileBytes ||
      params.resourceChecksum !== checksum
    ) {
      throw new Error('Unexpected packaged Artifact Version reservation metadata.')
    }
    return {
      id: 'installer-smoke-version',
      artifactId: 'installer-smoke-artifact',
      versionId: 'installer-smoke-version',
      versionNumber: 1,
      checksum,
      createdAt: new Date(0).toISOString(),
      projectId: 'installer-smoke-project',
      sessionId: 'installer-smoke-session',
      runId: 'installer-smoke-artifact-run',
      name: 'windows-rpc-smoke.txt',
      path: join(workspace, 'windows-rpc-smoke.txt'),
      fileUrl: 'file:///windows-rpc-smoke.txt',
      mimeType: 'text/plain',
      size: fileBytes,
      mtimeMs: 0,
      producerRunId: 'installer-smoke-shell-run'
    }
  }
  if (body.method === 'artifactReleaseWrite') {
    if (artifactRpcContract !== 'reservation') {
      throw new Error('Legacy packaged Artifact RPC must not release a write reservation.')
    }
    assertPackagedArtifactScope(params, false)
    if (params.reservationId !== RPC_SMOKE_RESERVATION_ID) {
      throw new Error('Unexpected packaged Artifact reservation release request.')
    }
    return { released: true }
  }
  return undefined
}

const releasedMigrationCountForPhase = (phase, expectedMigrationCount) =>
  phase === 'current' || phase === 'restart' ? expectedMigrationCount : undefined

const toolResultText = (result) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')

const assertToolResult = (toolName, result, expectedText) => {
  const text = toolResultText(result)
  if (result.isError || !text.includes(expectedText)) {
    throw new Error(
      `${toolName} did not return the expected packaged MCP result.${text ? `\n${text}` : ''}`
    )
  }
}

const appendMcpStderr = (error, stderr) => {
  const detail = stderr().trim()
  if (error instanceof Error && detail && !error.message.includes(detail))
    error.message += `\n${detail}`
  return error
}

const connectPackagedMcp = async ({ executable, entryPath, serverArg, env, cwd }) => {
  const transport = new StdioClientTransport({
    command: executable,
    args: [entryPath, serverArg],
    env: stringEnvironment(env),
    cwd,
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.setEncoding?.('utf8')
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const client = new Client({ name: 'windows-installer-smoke', version: '1.0.0' })
  try {
    await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS })
  } catch (error) {
    await transport.close().catch(() => undefined)
    throw appendMcpStderr(error, () => stderr)
  }
  return { client, stderr: () => stderr }
}

const runPackagedLocalRpcSmoke = async ({
  installDirectory,
  env,
  artifactRpcContract = 'reservation'
}) => {
  const root = await mkdtemp(join(env.TEMP, RPC_SMOKE_ROOT_PREFIX))
  const workspace = join(root, 'workspace')
  const artifactStorage = join(root, 'artifacts')
  const currentRunFile = join(root, 'current-run.json')
  const socketPath = `\\\\.\\pipe\\open-science-installer-smoke-${process.pid}-${randomUUID()}`
  const token = randomUUID()
  const methods = []
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 401, { error: 'Unauthorized installer smoke RPC request.' })
        return
      }
      const body = await readJsonBody(request)
      methods.push(body.method)
      if (body.method === 'state') {
        sendJson(response, 200, {
          result: {
            sessionId: 'installer-smoke-session',
            cwd: workspace,
            dataRoot: workspace,
            kernelStatus: 'idle',
            cells: [],
            runs: [],
            environments: []
          }
        })
        return
      }
      if (body.method === 'executeShell') {
        sendJson(response, 200, {
          result: {
            runId: 'installer-smoke-shell-run',
            kernelKind: 'bash',
            status: 'completed',
            exitCode: 0,
            stdout: RPC_SMOKE_CONTENT,
            stderr: '',
            traceback: '',
            outputs: [],
            workingFiles: []
          }
        })
        return
      }
      const artifactResult = packagedArtifactSmokeRpcResult(body, workspace, artifactRpcContract)
      if (artifactResult !== undefined) {
        sendJson(response, 200, { result: artifactResult })
        return
      }
      sendJson(response, 400, { error: `Unexpected installer smoke RPC method: ${body.method}` })
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
  let notebookMcp
  let artifactMcp
  let primaryError
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(artifactStorage, { recursive: true })
    ])
    await writeFile(
      currentRunFile,
      JSON.stringify({
        artifactRunId: 'installer-smoke-artifact-run',
        appSessionId: 'installer-smoke-session',
        rootFrameId: 'installer-smoke-root-frame',
        agentFrameId: 'installer-smoke-agent-frame',
        messageBranchId: 'installer-smoke-branch',
        runtimeSegmentId: 'installer-smoke-runtime',
        promptMessageId: 'installer-smoke-prompt',
        notebookSessionId: 'installer-smoke-session',
        rpcCapabilityToken: token
      })
    )
    await listenOnPipe(server, socketPath)

    const executable = join(installDirectory, APP_EXECUTABLE)
    const entryPath = packagedMainEntryPath(installDirectory)
    const sharedEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    notebookMcp = await connectPackagedMcp({
      executable,
      entryPath,
      serverArg: NOTEBOOK_MCP_SERVER_ARG,
      cwd: workspace,
      env: {
        ...sharedEnv,
        OPEN_SCIENCE_NOTEBOOK_RPC_ENDPOINT: 'http://localhost',
        OPEN_SCIENCE_NOTEBOOK_RPC_SOCKET_PATH: socketPath,
        OPEN_SCIENCE_NOTEBOOK_RPC_TOKEN: token,
        OPEN_SCIENCE_NOTEBOOK_PROJECT_ID: 'installer-smoke-project',
        OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'installer-smoke-session',
        OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD: workspace
      }
    })
    const state = await notebookMcp.client.callTool(
      { name: 'notebook_state', arguments: {} },
      undefined,
      { timeout: MCP_REQUEST_TIMEOUT_MS }
    )
    assertToolResult('notebook_state', state, 'installer-smoke-session')
    const shell = await notebookMcp.client.callTool(
      { name: 'bash_execute', arguments: { command: 'Write-Output windows-rpc-smoke' } },
      undefined,
      { timeout: MCP_REQUEST_TIMEOUT_MS }
    )
    assertToolResult('bash_execute', shell, RPC_SMOKE_CONTENT.trim())

    artifactMcp = await connectPackagedMcp({
      executable,
      entryPath,
      serverArg: ARTIFACT_MCP_SERVER_ARG,
      cwd: workspace,
      env: {
        ...sharedEnv,
        OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT: artifactStorage,
        OPEN_SCIENCE_ARTIFACT_PROJECT_ID: 'installer-smoke-project',
        OPEN_SCIENCE_ARTIFACT_SESSION_ID: 'installer-smoke-session',
        OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE: currentRunFile,
        OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS: JSON.stringify([workspace]),
        OPEN_SCIENCE_ARTIFACT_RPC_ENDPOINT: 'http://localhost',
        OPEN_SCIENCE_ARTIFACT_RPC_SOCKET_PATH: socketPath
      }
    })
    const artifact = await artifactMcp.client.callTool(
      {
        name: 'write_artifact_file',
        arguments: {
          filename: 'windows-rpc-smoke.txt',
          mimeType: 'text/plain',
          content: RPC_SMOKE_CONTENT,
          encoding: 'utf8',
          producerRunId: 'installer-smoke-shell-run'
        }
      },
      undefined,
      { timeout: MCP_REQUEST_TIMEOUT_MS }
    )
    assertToolResult('write_artifact_file', artifact, 'installer-smoke-version')

    const expectedMethods =
      artifactRpcContract === 'legacy'
        ? ['state', 'executeShell', 'artifactCreateVersion']
        : ['state', 'executeShell', 'artifactReserveWrite', 'artifactCreateVersion']
    if (JSON.stringify(methods) !== JSON.stringify(expectedMethods)) {
      throw new Error(`Unexpected packaged local RPC sequence: ${methods.join(' -> ')}`)
    }
  } catch (error) {
    const stderr = [notebookMcp?.stderr(), artifactMcp?.stderr()].filter(Boolean).join('\n').trim()
    primaryError = appendMcpStderr(error, () => stderr)
  }
  const cleanupResults = await Promise.allSettled([
    notebookMcp?.client.close(),
    artifactMcp?.client.close(),
    server.listening ? closeServer(server) : undefined,
    rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 500 })
  ])
  const cleanupFailure = cleanupResults.find((result) => result.status === 'rejected')
  if (primaryError) throw primaryError
  if (cleanupFailure?.status === 'rejected') throw cleanupFailure.reason
  console.log('Packaged Windows MCP local RPC smoke completed successfully.')
}

const windowsProfileEnvironment = (profileDirectory, baseEnvironment = process.env) => {
  const temporaryDirectory = join(profileDirectory, 'Temp')
  return {
    ...baseEnvironment,
    HOME: profileDirectory,
    USERPROFILE: profileDirectory,
    APPDATA: join(profileDirectory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(profileDirectory, 'AppData', 'Local'),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory
  }
}

const assertPackagedResources = async (installDirectory) => {
  for (const path of packagedResourcePaths(installDirectory)) {
    if (!(await pathExists(path))) throw new Error(`Packaged Windows resource is missing: ${path}`)
  }
  const prismaRoot = join(installDirectory, 'resources', 'node_modules', '.prisma', 'client')
  const engines = await readdir(prismaRoot)
  const nativeEngines = engines.filter(
    (name) => name.includes('query_engine-') && name.endsWith('.node')
  )
  if (nativeEngines.length !== 1 || nativeEngines[0] !== 'query_engine-windows.dll.node') {
    throw new Error(`Packaged Windows must contain exactly one Prisma engine in ${prismaRoot}.`)
  }
}

const upgradeSentinelPath = (configRoot, sentinelName) => join(configRoot, sentinelName)

const writeUpgradeSentinel = async (configRoot, sentinelName) => {
  await mkdir(configRoot, { recursive: true })
  await writeFile(upgradeSentinelPath(configRoot, sentinelName), UPGRADE_SENTINEL_CONTENT, {
    encoding: 'utf8',
    flag: 'wx'
  })
}

const assertUpgradeProfilePreserved = async (configRoot, sentinelName) => {
  let content
  try {
    content = await readFile(upgradeSentinelPath(configRoot, sentinelName), 'utf8')
  } catch {
    throw new Error('The Windows upgrade did not preserve the previous application profile.')
  }
  if (content !== UPGRADE_SENTINEL_CONTENT) {
    throw new Error('The Windows upgrade did not preserve the previous application profile.')
  }
}

const createUpgradeProfileGuard = (
  enabled,
  sentinelName = `${UPGRADE_SENTINEL_PREFIX}${randomUUID()}`,
  readLedger = readDatabaseMigrationLedger
) => {
  let previousConfigRoot
  let previousMigrationIds
  let expectDowngradeBlock = false
  let sentinelCreated = false

  const verifyCycle = async (phase, configRoot) => {
    if (!enabled) return
    if (phase === 'previous') {
      previousConfigRoot = configRoot
      await writeUpgradeSentinel(configRoot, sentinelName)
      sentinelCreated = true
      previousMigrationIds = (await readLedger(configRoot))?.map(({ id }) => id)
      return
    }
    if (!previousConfigRoot) {
      throw new Error('The Windows upgrade did not report the previous application config root.')
    }
    if (resolve(previousConfigRoot).toLowerCase() !== resolve(configRoot).toLowerCase()) {
      throw new Error(
        `The Windows upgrade config root changed from ${previousConfigRoot} to ${configRoot}.`
      )
    }
    await assertUpgradeProfilePreserved(configRoot, sentinelName)
    if (phase === 'current' && previousMigrationIds) {
      const currentMigrationIds = (await readLedger(configRoot))?.map(({ id }) => id) ?? []
      expectDowngradeBlock = currentMigrationIds.some((id) => !previousMigrationIds.includes(id))
    }
  }

  const cleanup = async (primaryError) => {
    if (!sentinelCreated || !previousConfigRoot) return
    try {
      await rm(upgradeSentinelPath(previousConfigRoot, sentinelName), { force: true })
      sentinelCreated = false
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      console.warn(`Windows upgrade sentinel cleanup also failed: ${message}`)
    }
  }

  return { cleanup, shouldExpectDowngradeBlock: () => expectDowngradeBlock, verifyCycle }
}

const launchAndProbe = async ({
  installDirectory,
  expectedVersion,
  env,
  legacyConfigRoots,
  verifyLedger = false,
  expectedMigrationCount,
  onSqliteVersion
}) => {
  const executable = join(installDirectory, APP_EXECUTABLE)

  const child = spawn(executable, ['--open-science-headless', '--serve=0'], {
    env,
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const output = () => `${stdout}${stderr ? `\n${stderr}` : ''}`
  const exit = observeChildExit(child)

  try {
    const { endpoint, auth } = await Promise.race([
      waitFor('the installed app web service', async () => {
        return authenticatePackagedAppEndpoint(output(), [
          env.OPEN_SCIENCE_E2E_STORAGE_ROOT,
          ...(legacyConfigRoots ?? [])
        ])
      }),
      exit.then((code) => {
        throw new Error(`Installed app exited before becoming healthy (${code}).\n${output()}`)
      })
    ])
    const response = await fetchWithTimeout(`${endpoint}/api/bootstrap?${auth}`)
    if (!response.ok)
      throw new Error(`Installed app health probe returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    const configRoot = await readPackagedAppConfigRoot(bootstrap, expectedVersion, {
      auth,
      legacyConfigRoots
    })

    await requestPackagedAppShutdown(endpoint, auth)
    const exitCode = await waitForShutdownExit(exit, child, output)
    if (exitCode !== 0) throw new Error(`Installed app exited with ${exitCode}.\n${output()}`)
    if (verifyLedger) await verifyDatabaseMigrationLedger(configRoot, expectedMigrationCount)
    if (onSqliteVersion) onSqliteVersion(parsePackagedSqliteVersion(output()))
    return configRoot
  } catch (error) {
    await terminateProcessTree(child)
    const processOutput = output().trim()
    if (error instanceof Error && processOutput && !error.message.includes(processOutput)) {
      error.message += `\n${processOutput}`
    }
    throw error
  }
}

const assertDatabaseDowngradeBlocked = ({ becameHealthy, output }) => {
  if (becameHealthy) {
    throw new Error(`Ledger-aware downgrade unexpectedly became healthy.\n${output}`)
  }
  if (!/database_newer_than_app|newer version of Open Science/i.test(output)) {
    throw new Error(
      `Ledger-aware downgrade did not report the expected compatibility error.\n${output}`
    )
  }
}

const launchAndExpectDatabaseBlocked = async ({ installDirectory, env }) => {
  const child = spawn(
    join(installDirectory, APP_EXECUTABLE),
    ['--open-science-headless', '--serve=0'],
    { env, windowsHide: true }
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => (stdout += chunk))
  child.stderr?.on('data', (chunk) => (stderr += chunk))
  const output = () => `${stdout}${stderr ? `\n${stderr}` : ''}`
  const close = observeChildClose(child)
  let closed = false
  let closeError
  void close.then(
    () => {
      closed = true
    },
    (error) => {
      closeError = error
      closed = true
    }
  )

  try {
    await waitFor('the ledger-aware downgrade to block', async () => (closed ? true : undefined))
    if (closeError) throw closeError
    assertDatabaseDowngradeBlocked({
      becameHealthy: parsePackagedAppEndpoint(output()) !== undefined,
      output: output()
    })
  } catch (error) {
    await terminateProcessTree(child)
    throw error
  }
}

// Leaves a healthy packaged process running so the next silent installer must handle the real
// executable/process lock. The caller owns termination if installation fails.
const launchForProcessLock = async ({
  installDirectory,
  expectedVersion,
  env,
  legacyConfigRoots
}) => {
  const executable = join(installDirectory, APP_EXECUTABLE)
  const child = spawn(executable, ['--open-science-headless', '--serve=0'], {
    env,
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => (stdout += chunk))
  child.stderr?.on('data', (chunk) => (stderr += chunk))
  const output = () => `${stdout}${stderr ? `\n${stderr}` : ''}`
  const exit = observeChildExit(child)
  try {
    const { endpoint, auth } = await Promise.race([
      waitFor('the process-lock app web service', async () =>
        authenticatePackagedAppEndpoint(output(), [
          env.OPEN_SCIENCE_E2E_STORAGE_ROOT,
          ...(legacyConfigRoots ?? [])
        ])
      ),
      exit.then((code) => {
        throw new Error(`Process-lock app exited before becoming healthy (${code}).\n${output()}`)
      })
    ])
    const response = await fetchWithTimeout(`${endpoint}/api/bootstrap?${auth}`)
    if (!response.ok)
      throw new Error(`Process-lock app bootstrap returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    if (bootstrap.appVersion !== expectedVersion || bootstrap.platform !== 'win32') {
      throw new Error(`Unexpected process-lock app bootstrap: ${JSON.stringify(bootstrap)}`)
    }
    return { child, exit, output }
  } catch (error) {
    await terminateProcessTree(child)
    throw error
  }
}

const installAndProbe = async ({
  installer,
  installDirectory,
  phase,
  env,
  legacyConfigRoots,
  artifactRpcContract,
  expectedMigrationCount,
  onSqliteVersion
}) => {
  console.log(`Smoke testing ${phase} installer: ${basename(installer)}`)
  await runProcess(installer, ['/S', `/D=${installDirectory}`], { env })
  await assertPackagedResources(installDirectory)
  await runProcess(join(installDirectory, 'resources', 'micromamba.exe'), ['--version'], { env })
  if (phase === 'current')
    await runPackagedLocalRpcSmoke({ installDirectory, env, artifactRpcContract })
  return launchAndProbe({
    installDirectory,
    expectedVersion: installerVersion(installer),
    env,
    legacyConfigRoots,
    verifyLedger: phase !== 'previous',
    expectedMigrationCount,
    onSqliteVersion
  })
}

const installOverRunningApp = async ({
  installer,
  runningInstaller,
  installDirectory,
  phase,
  env,
  legacyConfigRoots,
  artifactRpcContract,
  launchInstalledApp = true,
  expectedMigrationCount,
  onSqliteVersion
}) => {
  const running = await launchForProcessLock({
    installDirectory,
    expectedVersion: installerVersion(runningInstaller),
    env,
    legacyConfigRoots
  })
  try {
    await runProcess(installer, ['/S', `/D=${installDirectory}`], { env })
    await waitForShutdownExit(running.exit, running.child, running.output)
  } catch (error) {
    await terminateProcessTree(running.child)
    throw error
  }

  await assertPackagedResources(installDirectory)
  await runProcess(join(installDirectory, 'resources', 'micromamba.exe'), ['--version'], { env })
  if (phase === 'current')
    await runPackagedLocalRpcSmoke({ installDirectory, env, artifactRpcContract })
  if (!launchInstalledApp) return undefined
  return launchAndProbe({
    installDirectory,
    expectedVersion: installerVersion(installer),
    env,
    legacyConfigRoots,
    verifyLedger: true,
    expectedMigrationCount,
    onSqliteVersion
  })
}

const findUninstaller = async (installDirectory) => {
  const names = await readdir(installDirectory)
  const uninstallers = names.filter((name) => /^Uninstall .+\.exe$/i.test(name))
  if (uninstallers.length !== 1) {
    throw new Error(`Expected one Windows uninstaller; found ${uninstallers.length}.`)
  }
  return join(installDirectory, uninstallers[0])
}

const launchUninstallerLockHolder = async (
  installDirectory,
  env,
  spawnProcess = spawn,
  waitForReady = waitFor,
  terminate = terminateProcessTree,
  shareMode = 'None'
) => {
  const uninstaller = await findUninstaller(installDirectory)
  const ready = join(env.TEMP, `installer-smoke-lock-holder-${randomUUID()}.ready`)
  const child = spawnProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$stream = [System.IO.File]::Open($env:OPEN_SCIENCE_LOCK_PATH, 'Open', 'Read', $env:OPEN_SCIENCE_LOCK_SHARE); [System.IO.File]::WriteAllText($env:OPEN_SCIENCE_LOCK_READY, 'ready'); [System.Threading.Thread]::Sleep([System.Threading.Timeout]::Infinite)"
    ],
    {
      env: {
        ...env,
        OPEN_SCIENCE_LOCK_PATH: uninstaller,
        OPEN_SCIENCE_LOCK_READY: ready,
        OPEN_SCIENCE_LOCK_SHARE: shareMode
      },
      windowsHide: true
    }
  )
  const exit = observeChildExit(child)
  try {
    await Promise.race([
      waitForReady('the old uninstaller to be write-locked', async () =>
        (await pathExists(ready)) ? true : undefined
      ),
      exit.then((code) => {
        throw new Error(`Uninstaller lock holder exited before becoming ready (${code}).`)
      })
    ])
  } catch (error) {
    await terminate(child)
    throw error
  }
  return { child, uninstaller }
}

// Exercise a registered, working installation rather than an orphaned uninstaller. Read sharing
// lets the old uninstaller be copied and launched, but blocks replacing its original file. A check
// performed only after uninstalling is too late: it leaves the app executable missing on failure.
const drillLockedUpgrade = async ({
  installer,
  installDirectory,
  env,
  executableName = APP_EXECUTABLE
}) => {
  const executable = join(installDirectory, executableName)
  const original = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  const lock = await launchUninstallerLockHolder(
    installDirectory,
    env,
    spawn,
    waitFor,
    terminateProcessTree,
    'Read'
  )
  try {
    const result = await runProcess(installer, ['/S', '--updated', `/D=${installDirectory}`], {
      allowNonZero: true,
      env,
      timeoutMs: 30_000
    })
    if (result.code === 0) throw new Error('Update accepted a write-locked uninstaller target.')
    if (lock.child.exitCode !== null) throw new Error('Update terminated the external lock holder.')
    const remaining = await readFile(executable).catch((cause) => {
      throw new Error('Rejected update removed the previously launchable application.', { cause })
    })
    if (createHash('sha256').update(remaining).digest('hex') !== original) {
      throw new Error('Rejected update replaced the previous application.')
    }
  } finally {
    await terminateProcessTree(lock.child)
  }
}

const drillOrphanedUninstallerLock = async ({ installer, installDirectory, env }) => {
  await mkdir(installDirectory, { recursive: true })
  const staleUninstaller = join(installDirectory, 'Uninstall open-science.exe')
  await copyFile(installer, staleUninstaller)
  const staleUninstallerHash = createHash('sha256')
    .update(await readFile(staleUninstaller))
    .digest('hex')
  const lock = await launchUninstallerLockHolder(installDirectory, env)
  let installResult
  try {
    const writeProbe = await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "try { $stream = [System.IO.File]::Open($env:OPEN_SCIENCE_LOCK_PROBE_PATH, 'Open', 'Write', 'None'); $stream.Dispose(); exit 0 } catch { exit 1 }"
      ],
      {
        allowNonZero: true,
        env: { ...env, OPEN_SCIENCE_LOCK_PROBE_PATH: lock.uninstaller }
      }
    )
    if (writeProbe.code !== 1) {
      throw new Error('Uninstaller lock fixture did not block an independent write handle.')
    }
    installResult = await runProcess(installer, ['/S', `/D=${installDirectory}`], {
      allowNonZero: true,
      env,
      timeoutMs: 30_000
    })
    await delay(250)
    if (lock.child.exitCode !== null) {
      throw new Error(`Installer terminated the external lock holder with ${lock.child.exitCode}.`)
    }
  } catch (error) {
    throw new Error(
      `Installer could not recover the orphaned locked uninstaller at ${lock.uninstaller}.`,
      { cause: error }
    )
  } finally {
    await terminateProcessTree(lock.child)
  }

  const appInstalled = await pathExists(join(installDirectory, APP_EXECUTABLE))
  if (installResult.code !== 0) {
    if (appInstalled) {
      throw new Error('Installer failed after partially extracting the new application.')
    }
    return
  }
  const installedUninstaller = await findUninstaller(installDirectory)
  const installedUninstallerHash = createHash('sha256')
    .update(await readFile(installedUninstaller))
    .digest('hex')
  if (installedUninstallerHash === staleUninstallerHash) {
    throw new Error(
      `Installer reported success without replacing the locked uninstaller at ${installedUninstaller}.`
    )
  }
  if (!appInstalled)
    throw new Error('Installer reported success without installing the application.')
}

const terminateDirectoryProcesses = async (directory, run = runProcess) => {
  const root = `${directory.replace(/[\\/]+$/u, '')}\\`
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$root = $args[0]; Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      root
    ],
    { allowNonZero: true }
  )
}

const uninstallAndVerify = async (installDirectory, env) => {
  const uninstaller = await findUninstaller(installDirectory)
  const installedPaths = [...packagedResourcePaths(installDirectory), uninstaller]
  await terminateDirectoryProcesses(installDirectory)
  const result = await runProcess(uninstaller, ['/S', '/KEEP_APP_DATA'], {
    allowNonZero: true,
    env
  })
  await terminateDirectoryProcesses(installDirectory)
  await waitFor('the installed application files to be removed', async () => {
    const pathsRemain = (await Promise.all(installedPaths.map(pathExists))).some(Boolean)
    if (pathsRemain) return undefined
    if (!(await pathExists(installDirectory))) return true
    return (await readdir(installDirectory)).length === 0 || undefined
  })
  if (result.code !== 0) {
    console.warn(`Uninstaller reported ${result.code} after removing the application files.`)
  }
}

const parseArguments = (argv) => {
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const installerDirectory = valueFor('--installer-dir')
  if (!installerDirectory)
    throw new Error(
      'Usage: --installer-dir <path> [--previous-installer-dir <path>] [--artifact-rpc-contract <legacy|reservation>] [--expected-migration-count <count>]'
    )
  const artifactRpcContractIndex = argv.indexOf('--artifact-rpc-contract')
  const artifactRpcContract =
    artifactRpcContractIndex === -1 ? 'reservation' : argv[artifactRpcContractIndex + 1]
  if (artifactRpcContract !== 'legacy' && artifactRpcContract !== 'reservation') {
    throw new Error('Artifact RPC contract must be legacy or reservation.')
  }
  const expectedMigrationCountIndex = argv.indexOf('--expected-migration-count')
  const expectedMigrationCountValue =
    expectedMigrationCountIndex === -1 ? undefined : argv[expectedMigrationCountIndex + 1]
  if (
    expectedMigrationCountIndex !== -1 &&
    (expectedMigrationCountValue === undefined || !/^[1-9]\d*$/.test(expectedMigrationCountValue))
  ) {
    throw new Error('Expected migration count must be a positive integer.')
  }
  const expectedMigrationCount =
    expectedMigrationCountValue === undefined ? undefined : Number(expectedMigrationCountValue)
  if (expectedMigrationCount !== undefined && !Number.isSafeInteger(expectedMigrationCount)) {
    throw new Error('Expected migration count must be a positive safe integer.')
  }
  const scenario = valueFor('--scenario')
  if (scenario !== undefined && scenario !== ORPHANED_UNINSTALLER_LOCK_SCENARIO) {
    throw new Error(`Unsupported Windows installer smoke scenario: ${scenario}`)
  }
  return {
    installerDirectory: resolve(installerDirectory),
    previousInstallerDirectory: valueFor('--previous-installer-dir')
      ? resolve(valueFor('--previous-installer-dir'))
      : undefined,
    artifactRpcContract,
    expectedMigrationCount,
    scenario
  }
}

const removeSmokeRoot = async (root) => {
  if (!basename(root).startsWith(SMOKE_ROOT_PREFIX)) {
    throw new Error(`Refusing to remove unexpected smoke root: ${root}`)
  }
  await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 500 })
}

const cleanupSmokeRoot = async (root, primaryError, remove = removeSmokeRoot) => {
  try {
    await remove(root)
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    console.warn(`Windows installer smoke cleanup also failed: ${message}`)
  }
}

const runOrphanedUninstallerLockSmoke = async (installer) => {
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const installDirectory = join(root, 'installed app 程序')
  const profileDirectory = join(root, 'profile 数据 with spaces')
  const env = windowsProfileEnvironment(profileDirectory)
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true })
  ])

  let primaryError
  try {
    await drillOrphanedUninstallerLock({ installer, installDirectory, env })
  } catch (error) {
    primaryError = error
  }
  await cleanupSmokeRoot(root, primaryError)
  if (primaryError) throw primaryError
  console.log('Windows orphaned-uninstaller lock smoke completed successfully.')
}

const main = async () => {
  if (process.platform !== 'win32') throw new Error('Windows installer smoke requires Windows.')
  const options = parseArguments(process.argv.slice(2))
  const currentInstaller = await findSetupInstaller(options.installerDirectory)
  if (options.scenario === ORPHANED_UNINSTALLER_LOCK_SCENARIO) {
    await runOrphanedUninstallerLockSmoke(currentInstaller)
    return
  }
  const previousInstaller = options.previousInstallerDirectory
    ? await findSetupInstaller(options.previousInstallerDirectory)
    : undefined
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const installDirectory = join(root, 'installed app 程序')
  const lockedInstallDirectory = join(root, 'locked uninstaller 程序')
  const profileDirectory = join(root, 'profile 数据 with spaces')
  const freshStorageRoot = join(root, 'fresh database 数据 with spaces')
  const legacyStorageRoot = join(root, 'legacy database 数据 with spaces')
  const legacyConfigRoots = [
    win32.join(homedir(), CONFIG_DIRECTORY),
    win32.join(profileDirectory, CONFIG_DIRECTORY)
  ]
  const env = windowsProfileEnvironment(profileDirectory)
  const upgradeProfileGuard = createUpgradeProfileGuard(Boolean(previousInstaller))
  const sqliteVersions = []
  const onSqliteVersion = (sqliteVersion) => sqliteVersions.push(sqliteVersion)
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true })
  ])

  let primaryError
  try {
    await drillOrphanedUninstallerLock({
      installer: currentInstaller,
      installDirectory: lockedInstallDirectory,
      env
    })
    await executeSmokePlan(
      buildSmokePlan({ currentInstaller, previousInstaller }),
      async (cycle) => {
        const configRoot = cycle.runningInstaller
          ? await installOverRunningApp({
              ...cycle,
              installDirectory,
              env,
              legacyConfigRoots,
              artifactRpcContract: options.artifactRpcContract,
              expectedMigrationCount: releasedMigrationCountForPhase(
                cycle.phase,
                options.expectedMigrationCount
              ),
              onSqliteVersion: cycle.phase === 'rollback' ? undefined : onSqliteVersion
            })
          : await installAndProbe({
              ...cycle,
              installDirectory,
              env,
              legacyConfigRoots,
              artifactRpcContract: options.artifactRpcContract,
              expectedMigrationCount: releasedMigrationCountForPhase(
                cycle.phase,
                options.expectedMigrationCount
              ),
              onSqliteVersion: cycle.phase === 'previous' ? undefined : onSqliteVersion
            })
        if (cycle.phase === 'rollback' && upgradeProfileGuard.shouldExpectDowngradeBlock()) {
          await launchAndExpectDatabaseBlocked({ installDirectory, env })
        }
        if (configRoot) await upgradeProfileGuard.verifyCycle(cycle.phase, configRoot)
        if (cycle.phase === 'previous') {
          await drillLockedUpgrade({ installer: currentInstaller, installDirectory, env })
        }
      }
    )
    const smokeIsolatedDatabase = async (storageRoot, expectLegacyProject) => {
      const isolatedEnv = { ...env, OPEN_SCIENCE_E2E_STORAGE_ROOT: storageRoot }
      for (let launch = 0; launch < 2; launch += 1) {
        const configRoot = await launchAndProbe({
          installDirectory,
          expectedVersion: installerVersion(currentInstaller),
          env: isolatedEnv,
          verifyLedger: true,
          expectedMigrationCount: options.expectedMigrationCount,
          onSqliteVersion
        })
        if (resolve(configRoot).toLowerCase() !== resolve(storageRoot).toLowerCase()) {
          throw new Error('Windows database smoke did not use its isolated storage root.')
        }
      }
      if (expectLegacyProject) await verifyLegacyProjectPreserved(storageRoot)
    }
    await smokeIsolatedDatabase(freshStorageRoot, false)
    await seedLegacyDatabase(legacyStorageRoot)
    await smokeIsolatedDatabase(legacyStorageRoot, true)
    await writeDatabaseMigrationCertification({
      output: join(options.installerDirectory, 'database-migration-certification.json'),
      sqliteVersions,
      checks: {
        freshInstall: 'passed',
        legacyAdoption: 'passed',
        reopen: 'passed',
        specialPath: 'passed'
      }
    })
    await uninstallAndVerify(installDirectory, env)
    console.log('Windows installer smoke completed successfully.')
  } catch (error) {
    primaryError = error
  }

  let sentinelCleanupError
  try {
    await upgradeProfileGuard.cleanup(primaryError)
  } catch (error) {
    sentinelCleanupError = error
  }
  await cleanupSmokeRoot(root, primaryError ?? sentinelCleanupError)
  if (primaryError) throw primaryError
  if (sentinelCleanupError) throw sentinelCleanupError
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export {
  authenticatePackagedAppEndpoint,
  assertDatabaseDowngradeBlocked,
  assertPackagedResources,
  assertUpgradeProfilePreserved,
  buildSmokePlan,
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  drillLockedUpgrade,
  drillOrphanedUninstallerLock,
  executeSmokePlan,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  launchUninstallerLockHolder,
  launchAndExpectDatabaseBlocked,
  installAndProbe,
  launchAndProbe,
  packagedArtifactSmokeRpcResult,
  packagedMainEntryPath,
  observeChildClose,
  parseArguments,
  packagedResourcePaths,
  parsePackagedAppEndpoint,
  readPackagedAppConfigRoot,
  requestPackagedAppShutdown,
  releasedMigrationCountForPhase,
  runProcess,
  terminateDirectoryProcesses,
  terminateProcessTree,
  uninstallAndVerify,
  waitFor,
  waitForShutdownExit,
  windowsProfileEnvironment,
  writeUpgradeSentinel
}
