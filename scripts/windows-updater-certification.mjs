/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { dump, load } from 'js-yaml'

import {
  APP_GUID,
  cleanupSmokeRoot,
  captureStartupLogs,
  assertIsolatedWindowsAccount,
  createUpgradeProfileGuard,
  cleanupSmokeRegistrations,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  installAndProbe,
  launchForProcessLock,
  requestPackagedAppShutdown,
  inspectInstalledProcess,
  readPackagedAppConfigRoot,
  authenticatePackagedAppEndpoint,
  runProcess,
  terminateProcessTree,
  terminateDirectoryProcesses,
  uninstallAndVerify,
  waitFor,
  waitForShutdownExit,
  windowsProfileEnvironment
} from './windows-installer-smoke.mjs'

const UPDATE_TIMEOUT_MS = 180_000
const SMOKE_ROOT_PREFIX = 'open-science-installer-smoke-updater-'

const singleFile = async (directory, pattern, description) => {
  const matches = (await readdir(directory))
    .filter((name) => pattern.test(name))
    .map((name) => join(directory, name))
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description} in ${directory}; found ${matches.length}.`)
  }
  return matches[0]
}

const parseArguments = (argv) => {
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const currentDirectory = valueFor('--current-dir')
  const previousDirectory = valueFor('--previous-dir')
  const output = valueFor('--output')
  const scenario = valueFor('--scenario') ?? 'basic'
  if (
    ![
      'basic',
      'workload',
      'active-work',
      'downgrade',
      'multi-profile',
      'unresponsive-profile',
      'no-protocol-runtime',
      'missing-exe-recovery',
      'cancel-cleanup',
      'writer-shortcut-wait'
    ].includes(scenario)
  )
    throw new Error(`Unknown updater scenario: ${scenario}`)
  if (!currentDirectory || !previousDirectory || !output) {
    throw new Error('Usage: --current-dir <path> --previous-dir <path> --output <path>')
  }
  return {
    currentDirectory: resolve(currentDirectory),
    previousDirectory: resolve(previousDirectory),
    output: resolve(output),
    scenario
  }
}

const buildLocalUpdaterConfig = (source, url) => {
  const parsed = load(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Installed app-update.yml is invalid.')
  }
  const updaterCacheDirName = String(parsed.updaterCacheDirName ?? '')
  if (
    !updaterCacheDirName ||
    basename(updaterCacheDirName) !== updaterCacheDirName ||
    updaterCacheDirName === '.' ||
    updaterCacheDirName === '..'
  ) {
    throw new Error('Installed app-update.yml has an unsafe updaterCacheDirName.')
  }
  const config = {
    ...parsed,
    provider: 'generic',
    url,
    channel: 'latest',
    useMultipleRangeRequest: false
  }
  return { source: dump(config, { lineWidth: -1 }), updaterCacheDirName }
}

const parseSingleRange = (header, size) => {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (!match) throw new Error(`Unsupported HTTP range: ${header ?? '<missing>'}`)
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0
  ) {
    throw new Error(`Invalid HTTP range: ${header}`)
  }
  if (start >= size) return undefined
  if (end < start) throw new Error(`Invalid HTTP range: ${header}`)
  return { start, end: Math.min(end, size - 1) }
}

const rewriteFeedPaths = (source, version) =>
  source.replace(
    /^(\s*(?:- )?(?:path|url):\s*)(?!https?:|releases\/)([^\s].*)$/gm,
    (_match, prefix, name) => `${prefix}releases/${version}/${name}`
  )

const startAssetServer = async ({ assets, currentInstallerRoute }) => {
  const byRoute = new Map(assets.map(({ path, route }) => [route, path]))
  if (byRoute.size !== assets.length) throw new Error('Updater assets have duplicate routes.')
  const metrics = {
    feedRequests: 0,
    blockmapRequests: 0,
    rangeRequests: 0,
    fullInstallerRequests: 0,
    downloadedInstallerBytes: 0
  }
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      if (!byRoute.has(pathname)) {
        response.writeHead(404).end()
        return
      }
      const path = byRoute.get(pathname)
      const size = (await stat(path)).size
      const rangeHeader =
        typeof request.headers.range === 'string' ? request.headers.range : undefined

      const transfersBody = request.method !== 'HEAD'
      if (transfersBody && pathname === '/latest.yml') metrics.feedRequests += 1
      if (transfersBody && pathname.endsWith('.blockmap')) metrics.blockmapRequests += 1

      let range
      if (rangeHeader) {
        try {
          range = parseSingleRange(rangeHeader, size)
        } catch {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
        if (!range) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
      }

      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      const length = end - start + 1
      if (transfersBody && pathname === currentInstallerRoute) {
        if (range) metrics.rangeRequests += 1
        else metrics.fullInstallerRequests += 1
        metrics.downloadedInstallerBytes += length
      }

      response.writeHead(range ? 206 : 200, {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': length,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
      })
      if (request.method === 'HEAD') response.end()
      else createReadStream(path, { start, end }).pipe(response)
    })().catch((error) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Updater asset server has no port.')
  return {
    metrics,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
  }
}

const withTimeout = (promise, description, timeoutMs = UPDATE_TIMEOUT_MS) =>
  new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`Timed out waiting for ${description}.`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })

const observeChildExit = (child) =>
  new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })

const redactPackagedAppOutput = (output) => output.replace(/([?&]token=)[^\s&#]+/gi, '$1<redacted>')

const samePath = (left, right) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()

const findUpdateRequest = async ({ appDataRoots, parentPid, startedAt, executable }) => {
  const matches = []
  for (const appData of [...new Set(appDataRoots.filter(Boolean))]) {
    for (const root of [
      join(appData, 'Open-Science', 'UpdateHandoffs'),
      join(appData, 'Open-Science-UpdateHandoffs')
    ]) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })) {
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
        const directory = join(root, entry.name)
        const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'))
        if (
          request.parentPid !== parentPid ||
          request.operationId !== entry.name ||
          !Number.isSafeInteger(request.createdAt) ||
          request.createdAt < startedAt ||
          !samePath(request.applicationPath, executable)
        )
          continue
        matches.push({ request, directory })
      }
    }
  }
  if (!matches.length) return undefined
  if (matches.length !== 1) throw new Error('Ambiguous automatic update completion evidence.')
  return matches[0]
}

// Observe only: this function cannot launch or repair an app. The production ready receipt is
// written after the successor window is shown and the original profile's backend/data are ready.
const readAutomaticUpdateReady = async ({
  appDataRoots,
  parentPid,
  startedAt,
  executable,
  expectedVersion,
  expectedConfigRoot,
  probeProcess = inspectInstalledProcess,
  fetchImpl = fetch
}) => {
  const match = await findUpdateRequest({ appDataRoots, parentPid, startedAt, executable })
  if (!match) return undefined
  const { request, directory } = match
  if (
    request.targetVersion !== expectedVersion ||
    !samePath(request.startupOptions?.configRoot, expectedConfigRoot) ||
    !samePath(request.profilePath, request.startupOptions?.profilePath)
  ) {
    throw new Error('Automatic update target or original profile does not match.')
  }
  for (const stage of ['installed', 'ready']) {
    const receipt = await readFile(join(directory, `${stage}.receipt`), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (receipt === undefined) return undefined
    if (receipt !== `${request.operationId}\r\n${stage}\r\n`)
      throw new Error(`Invalid ${stage} receipt.`)
  }
  const process = await probeProcess(executable, request.successorPid)
  if (!process || process.startedAt < request.createdAt || process.pid === parentPid) {
    throw new Error('Automatic successor is absent or its process identity has changed.')
  }
  const state = JSON.parse(await readFile(join(expectedConfigRoot, 'web-service.json'), 'utf8'))
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535)
    throw new Error('Successor web-service port is invalid.')
  const token = (await readFile(join(expectedConfigRoot, 'web-token'), 'utf8')).trim()
  if (token.length < 32) throw new Error('Successor authentication state is invalid.')
  const auth = `token=${encodeURIComponent(token)}`
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${state.port}/api/bootstrap?${auth}`,
    {},
    15_000,
    fetchImpl
  )
  if (!response.ok) throw new Error(`Successor bootstrap returned HTTP ${response.status}.`)
  const configRoot = await readPackagedAppConfigRoot(await response.json(), expectedVersion)
  if (!samePath(configRoot, expectedConfigRoot))
    throw new Error('Automatic successor opened a different profile.')
  return {
    automatic: true,
    operationId: request.operationId,
    successorPid: process.pid,
    executable: process.executablePath,
    version: expectedVersion,
    configRoot,
    profilePath: request.profilePath,
    windowAndBackendReady: true
  }
}

const invokeWebRpc = async ({
  endpoint,
  auth,
  protocolVersion,
  channel,
  args = [],
  timeoutMs = UPDATE_TIMEOUT_MS,
  fetchImpl = fetch
}) => {
  const response = await fetchWithTimeout(
    `${endpoint}/rpc/${encodeURIComponent(channel)}?${auth}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion, args })
    },
    timeoutMs,
    fetchImpl
  )
  const payload = await response.json()
  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      `Headless updater RPC ${channel} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`
    )
  }
  return payload.result
}

const prepareNotebookWorkload = async ({
  connection,
  workspace,
  rpc = invokeWebRpc,
  probeProcess = inspectInstalledProcess
}) => {
  await mkdir(workspace, { recursive: true })
  const call = (channel, args = [], timeoutMs = UPDATE_TIMEOUT_MS) =>
    rpc({ ...connection, channel, args, timeoutMs })
  const protection = await call('settings:install-notebook-network', [], 600_000)
  if (protection?.kind !== 'ready')
    throw new Error('The real Notebook sandbox did not become ready.')
  await call('notebook-env:provision', ['python', `updater-${randomUUID()}`], 600_000)
  const project = await call('projects:create', [{ name: 'Updater preserved Notebook' }])
  if (typeof project?.id !== 'string') throw new Error('Notebook test project was not created.')
  const scope = { projectId: project.id, sessionId: randomUUID(), workspaceCwd: workspace }
  const content = `persisted-before-update-${randomUUID()}\n`
  const filename = 'update-preserved-output.txt'
  const run = await call(
    'notebook:execute',
    [
      {
        ...scope,
        language: 'python',
        source: 'user',
        code: `import os, pathlib\npathlib.Path(${JSON.stringify(filename)}).write_text(${JSON.stringify(content)}, encoding="utf-8")\nprint("UPDATE_KERNEL_PID=" + str(os.getpid()))`,
        timeoutMs: 120_000
      }
    ],
    600_000
  )
  if (run?.status !== 'completed')
    throw new Error(`Real Notebook execution failed: ${JSON.stringify(run)}`)
  const match = /UPDATE_KERNEL_PID=(\d+)/.exec(run.text?.stdout ?? '')
  if (!match) throw new Error('The real Python kernel did not report its process identity.')
  const state = await call('notebook:state', [scope])
  const python = state.runtimeBindings?.python?.interpreterPath ?? state.pythonPath
  const process = await probeProcess(python, Number(match[1]))
  if (
    !process ||
    !state.environments?.some((entry) => entry.kind === 'python' && entry.status === 'idle')
  ) {
    throw new Error('The Notebook workload did not leave a verified live Python kernel.')
  }
  if ((await readFile(join(workspace, filename), 'utf8')) !== content)
    throw new Error('Notebook output was not persisted before updating.')
  return { scope, runId: run.runId, outputPath: join(workspace, filename), content, process }
}

const verifyNotebookWorkload = async (workload, configRoot) => {
  const surviving = await inspectInstalledProcess(
    workload.process.executablePath,
    workload.process.pid
  )
  if (surviving?.startedAt === workload.process.startedAt)
    throw new Error('The original Python kernel survived the installation update.')
  if ((await readFile(workload.outputPath, 'utf8')) !== workload.content)
    throw new Error('The updated application lost the persisted Notebook output.')
  const service = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
  const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
  const endpoint = `http://127.0.0.1:${service.port}`
  const auth = `token=${encodeURIComponent(token)}`
  const bootstrap = await (await fetchWithTimeout(`${endpoint}/api/bootstrap?${auth}`)).json()
  const state = await invokeWebRpc({
    endpoint,
    auth,
    protocolVersion: bootstrap.rpcProtocolVersion,
    channel: 'notebook:state',
    args: [workload.scope]
  })
  if (!state.runs?.some((run) => run.runId === workload.runId && run.status === 'completed'))
    throw new Error('The updated backend could not read the original completed Notebook run.')
  if (workload.activeWork) {
    const interrupted = state.runs?.find((run) => run.runId === workload.activeWork.runId)
    if (!interrupted || !['cancelled', 'interrupted', 'failed'].includes(interrupted.status))
      throw new Error(
        'The updated backend did not retain the stopped active run as terminal history.'
      )
    workload.activeWork = { ...workload.activeWork, terminalStatus: interrupted.status }
  }
  return {
    runId: workload.runId,
    scope: workload.scope,
    originalKernel: workload.process,
    ...(workload.activeWork ? { activeWork: workload.activeWork } : {}),
    outputPreserved: true,
    historyReadable: true
  }
}

// Leave a real Python execution pending. Production update owns stopping it; a successful
// certification requires the old kernel to exit and the durable completed output to survive.
const prepareActiveNotebookWork = async ({ connection, workload, rpc = invokeWebRpc }) => {
  const call = (channel, args = []) => rpc({ ...connection, channel, args })
  const marker = join(workload.scope.workspaceCwd, 'active-work-started')
  const pending = call('notebook:execute', [
    {
      ...workload.scope,
      language: 'python',
      source: 'user',
      code: `import pathlib, time\npathlib.Path(${JSON.stringify(marker)}).write_text("started")\ntime.sleep(600)\nprint("UNEXPECTED_ACTIVE_WORK_COMPLETION")`,
      timeoutMs: 660_000
    }
  ])
  void pending.catch(() => undefined)
  const running = await waitFor(
    'a real active Python execution',
    async () => {
      if ((await readFile(marker, 'utf8')) !== 'started') return undefined
      const state = await call('notebook:state', [workload.scope])
      return state.activeRunId &&
        state.environments?.some((entry) => entry.kind === 'python' && entry.status === 'running')
        ? state
        : undefined
    },
    60_000
  )
  return { runId: running.activeRunId, activeBeforeApply: true }
}

const suspendFixtureProcess = async ({ identity, root }) => {
  const signal = join(root, `suspended-${randomUUID()}`)
  const release = `${signal}.release`
  const exit = runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./windows-certification-processes.ps1', import.meta.url)),
      '-Mode',
      'Suspend',
      '-Root',
      win32.dirname(identity.executablePath),
      '-TargetPid',
      String(identity.pid),
      '-ExpectedStartedAt',
      String(identity.startedAt),
      '-SignalFile',
      signal,
      '-ReleaseFile',
      release
    ],
    { timeoutMs: 330_000 }
  )
  void exit.catch(() => undefined)
  const resume = async () => {
    await writeFile(release, 'release')
    await exit
  }
  try {
    await Promise.race([
      waitFor(
        'the verified fixture process to be suspended',
        async () => (await readFile(signal, 'utf8')) === 'suspended' || undefined
      ),
      exit.then(() => {
        throw new Error('Fixture suspension ended before its barrier.')
      })
    ])
    return { resume, exit, identity }
  } catch (error) {
    await resume().catch(() => undefined)
    throw error
  }
}

const startNoProtocolRuntime = async ({ installDirectory, root, env }) => {
  const executable = join(installDirectory, 'resources', 'node-runtime', 'node.exe')
  const marker = join(root, 'no-protocol-runtime-ready')
  // The installed production Node binary runs a real process without lifecycle registrations,
  // representing a legacy runtime that cannot answer the new save/close protocol.
  const child = spawn(
    executable,
    [
      '-e',
      `require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)`,
      marker
    ],
    { env, windowsHide: true }
  )
  const exit = observeChildExit(child)
  void exit.catch(() => undefined)
  try {
    await Promise.race([
      waitFor(
        'the unregistered installed runtime',
        async () => (await readFile(marker, 'utf8')) === 'ready' || undefined
      ),
      exit.then((code) => {
        throw new Error(`Unregistered runtime exited early (${code}).`)
      })
    ])
    const identity = await inspectInstalledProcess(executable, child.pid)
    if (!identity) throw new Error('Unregistered runtime identity was not verifiable.')
    return { child, exit, identity }
  } catch (error) {
    await terminateProcessTree(child)
    throw error
  }
}

const certificationFaultScript = fileURLToPath(
  new URL('./windows-certification-faults.ps1', import.meta.url)
)
const denyFixturePublication = async ({ installDirectory, root }) => {
  const signal = join(root, `publication-denied-${randomUUID()}`)
  const release = `${signal}.release`
  const exit = runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      certificationFaultScript,
      '-Mode',
      'DenyPublication',
      '-Root',
      installDirectory,
      '-SignalFile',
      signal,
      '-ReleaseFile',
      release
    ],
    { timeoutMs: 510_000 }
  )
  void exit.catch(() => undefined)
  const restore = async () => {
    await writeFile(release, 'restore')
    await exit
  }
  try {
    await Promise.race([
      waitFor(
        'the publication failure barrier',
        async () => (await readFile(signal, 'utf8')) === 'publication-denied' || undefined
      ),
      exit.then(() => {
        throw new Error('The publication fault ended before it was armed.')
      })
    ])
    return { restore }
  } catch (error) {
    await restore().catch(() => undefined)
    throw error
  }
}

const sha256File = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const readOriginalShortcut = async ({ executable, installer }) => {
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) | Select-Object -Unique
$matches = @()
foreach ($root in $roots) {
  if (!$root -or !(Test-Path -LiteralPath $root)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse) {
    $link = $shell.CreateShortcut($file.FullName)
    if ($link.Arguments -ceq '--open-science-launch' -and $link.IconLocation.Split(',')[0] -ieq $env:CERTIFICATION_APPLICATION_PATH) {
      $matches += @{ path=$file.FullName; target=$link.TargetPath; arguments=$link.Arguments }
    }
  }
}
ConvertTo-Json -InputObject @($matches) -Compress
`.trim()
    ],
    { env: { ...process.env, CERTIFICATION_APPLICATION_PATH: executable } }
  )
  const matches = JSON.parse(result.stdout)
  if (!Array.isArray(matches) || matches.length === 0)
    throw new Error('The installed application has no ordinary persistent shortcut.')
  const shortcut = matches[0]
  if ((await sha256File(shortcut.target)) !== (await sha256File(installer)))
    throw new Error(
      'The ordinary shortcut does not point at the original verified installed package.'
    )
  return { ...shortcut, sha256: await sha256File(shortcut.path) }
}

const startOrdinaryShortcut = async (shortcut) => {
  if ((await sha256File(shortcut.path)) !== shortcut.sha256)
    throw new Error('The original ordinary shortcut was removed or changed before recovery.')
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      certificationFaultScript,
      '-Mode',
      'StartShortcut',
      '-Shortcut',
      shortcut.path
    ],
    { timeoutMs: 45_000 }
  )
  const evidence = JSON.parse(result.stdout)
  if (evidence.ordinaryShortcut !== true || evidence.administrator !== false)
    throw new Error('The ordinary shortcut was not opened with the expected normal user token.')
  return evidence
}

const profileConnection = async (configRoot, expectedVersion) => {
  const state = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
  const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
  const endpoint = `http://127.0.0.1:${state.port}`
  const auth = `token=${encodeURIComponent(token)}`
  const bootstrap = await (await fetchWithTimeout(`${endpoint}/api/bootstrap?${auth}`)).json()
  if (bootstrap.appVersion !== expectedVersion || !samePath(bootstrap.configRoot, configRoot))
    throw new Error('Cancellation did not restore the original version and profile.')
  return { endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }
}

const verifyCancellationAtCleanup = async ({
  connection,
  configRoot,
  sourceVersion,
  executable,
  workload,
  suspendedPeer
}) => {
  const beforeHash = await sha256File(executable)
  const started = Date.now()
  const call = (channel) => invokeWebRpc({ ...connection, channel })
  const applying = call('update:apply')
  void applying.catch(() => undefined)
  const barrier = await waitFor(
    'the cancellable cleanup barrier with a suspended peer',
    async () => {
      const status = await call('update:get-status')
      let diagnostics
      try {
        diagnostics = JSON.parse(status.diagnostics ?? 'null')
      } catch {
        return undefined
      }
      return status.recovery?.phase === 'preparing' &&
        status.recovery?.canCancel === true &&
        Array.isArray(diagnostics) &&
        diagnostics.some((step) => step.step === 'backend-shutdown')
        ? status
        : undefined
    },
    15_000
  )
  const peer = await inspectInstalledProcess(
    suspendedPeer.identity.executablePath,
    suspendedPeer.identity.pid
  )
  if (peer?.startedAt !== suspendedPeer.identity.startedAt)
    throw new Error('The suspended cleanup peer exited before cancellation reached its barrier.')
  const [cancelled] = await withTimeout(
    Promise.all([call('update:cancel'), applying]),
    'bounded cancellation and already-started cleanup',
    60_000
  )
  if (cancelled.state !== 'ready' || cancelled.outcome !== 'cancelled')
    throw new Error(`The pending update did not cancel after cleanup: ${JSON.stringify(cancelled)}`)
  const surviving = await inspectInstalledProcess(
    suspendedPeer.identity.executablePath,
    suspendedPeer.identity.pid
  )
  if (surviving?.startedAt === suspendedPeer.identity.startedAt)
    throw new Error('Cancellation returned before its already-started peer cleanup converged.')
  await suspendedPeer.exit
  if ((await sha256File(executable)) !== beforeHash)
    throw new Error('Cancelling before handoff changed the installed executable.')
  const restored = await waitFor(
    'the original backend after cancellation',
    () => profileConnection(configRoot, sourceVersion),
    30_000
  )
  const resumed = await invokeWebRpc({
    ...restored,
    channel: 'notebook:execute',
    args: [
      {
        ...workload.scope,
        language: 'python',
        source: 'user',
        code: 'import os\nprint("CANCEL_KERNEL_PID=" + str(os.getpid()))',
        timeoutMs: 30_000
      }
    ]
  })
  const pid = Number(/CANCEL_KERNEL_PID=(\d+)/.exec(resumed?.text?.stdout ?? '')?.[1])
  const kernel = await inspectInstalledProcess(workload.process.executablePath, pid)
  if (resumed.status !== 'completed' || !kernel)
    throw new Error(
      'The restored backend did not admit a real Notebook execution after cancellation.'
    )
  workload.process = kernel
  if ((await readFile(workload.outputPath, 'utf8')) !== workload.content)
    throw new Error('Cancelling lost the original durable Notebook output.')
  return {
    connection: restored,
    evidence: {
      barrierPhase: barrier.recovery.phase,
      peerWasSuspended: true,
      cleanupConverged: true,
      originalVersionRestored: true,
      notebookExecutionCompleted: true,
      elapsedMs: Date.now() - started
    }
  }
}

const inspectFixtureDirectory = async (root) => {
  const result = await runProcess('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fileURLToPath(new URL('./windows-certification-processes.ps1', import.meta.url)),
    '-Mode',
    'Inspect',
    '-Root',
    root
  ])
  return JSON.parse(result.stdout)
}

const verifyShortcutWaitsForWriter = async ({
  identity,
  parentPid,
  startedAt,
  executable,
  appDataRoots,
  shortcut,
  root,
  observerHelper
}) => {
  const operation = await waitFor(
    'the actual NSIS installing receipt',
    async () => {
      const match = await findUpdateRequest({ parentPid, startedAt, executable, appDataRoots })
      if (!match) return undefined
      const receipt = await readFile(join(match.directory, 'installing.receipt'), 'utf8')
      return receipt === `${match.request.operationId}\r\ninstalling\r\n` ? match : undefined
    },
    30_000
  )
  const held = await suspendFixtureProcess({ identity, root })
  const assertNotInstalled = async () => {
    const exists = await stat(join(operation.directory, 'installed.receipt')).catch((error) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (exists)
      throw new Error('The writer had already published the payload before the waiting barrier.')
    const mutex = JSON.parse((await runProcess(observerHelper, ['writer-active', APP_GUID])).stdout)
    if (mutex.active !== true)
      throw new Error('The suspended real installer does not own the production writer mutex.')
  }
  try {
    await assertNotInstalled()
    const launchedAt = Date.now()
    await startOrdinaryShortcut(shortcut)
    const launcher = await waitFor(
      'the original shortcut to remain a waiting process',
      async () => {
        const processes = await inspectFixtureDirectory(win32.dirname(shortcut.target))
        const matches = processes.filter(
          (process) =>
            samePath(process.executablePath, shortcut.target) && process.startedAt >= launchedAt
        )
        if (matches.length > 1) throw new Error('The shortcut created ambiguous launch processes.')
        return matches[0]
      },
      20_000
    )
    // Both observations happen while the exact writer handle remains suspended. No fixture
    // executable owns the mutex, writes a receipt, or completes the update on its behalf.
    await assertNotInstalled()
    const stillWaiting = await inspectInstalledProcess(launcher.executablePath, launcher.pid)
    if (stillWaiting?.startedAt !== launcher.startedAt)
      throw new Error('The ordinary shortcut exited instead of waiting for the live writer.')
    return {
      operationId: operation.request.operationId,
      writer: identity,
      waitingShortcut: launcher,
      originalWriterAlive: true,
      publicationNotCompleteWhileWaiting: true
    }
  } finally {
    await held.resume()
  }
}

// 0.18.0–0.18.2 return the in-flight check snapshot from update:download while the startup
// scheduler still owns check() (notes hydration). Poll until the download actually reaches ready.
const classifyUpdaterDownloadStatus = (downloaded, expectedVersion) => {
  if (!downloaded || typeof downloaded !== 'object') return 'unexpected'
  if (
    downloaded.state === 'ready' &&
    downloaded.applyKind === 'restart' &&
    downloaded.latest === expectedVersion
  ) {
    return 'ready'
  }
  if (downloaded.state === 'error') return 'failed'
  if (downloaded.state === 'checking' || downloaded.state === 'downloading') return 'pending'
  if (downloaded.state === 'available' && downloaded.latest === expectedVersion) return 'pending'
  return 'unexpected'
}

const observeInstaller = ({ installer, env, signal, runProcessImpl = runProcess }) => {
  const { promise: ready, resolve: markReady, reject: failReady } = Promise.withResolvers()
  const { promise: acquired, resolve: markAcquired, reject: failAcquired } = Promise.withResolvers()
  // Consumers await readiness before applying; handle an early observer exit immediately too.
  void ready.catch(() => undefined)
  void acquired.catch(() => undefined)
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OpenScienceProcessObserver
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, System.Text.StringBuilder path, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
$target = [IO.Path]::GetFullPath($env:OPEN_SCIENCE_INSTALLER_WATCH_TARGET)
# The observer uses direct process enumeration, independently of the product's CIM query.
# A regression that disables CIM must not also disable the acceptance observer.
[Diagnostics.Process]::GetCurrentProcess().Dispose()
[Console]::Out.WriteLine('OPEN_SCIENCE_INSTALLER_OBSERVER_READY')
[Console]::Out.Flush()
$deadline = [DateTime]::UtcNow.AddMinutes(1)
$candidate = $null
$handle = [IntPtr]::Zero
do {
  foreach ($process in [Diagnostics.Process]::GetProcessesByName([IO.Path]::GetFileNameWithoutExtension($target))) {
    $candidate = @{ ProcessId = $process.Id }
    $process.Dispose()
    $access = 0x00100000 -bor 0x00001000
    $handle = [OpenScienceProcessObserver]::OpenProcess($access, $false, [uint32]$candidate.ProcessId)
    if ($handle -ne [IntPtr]::Zero) {
      $image = [Text.StringBuilder]::new(32768)
      [uint32]$size = 32768
      $verified = [OpenScienceProcessObserver]::QueryFullProcessImageName($handle, 0, $image, [ref]$size)
      if (-not $verified -or -not [String]::Equals([IO.Path]::GetFullPath($image.ToString()), $target, [StringComparison]::OrdinalIgnoreCase)) {
        [OpenScienceProcessObserver]::CloseHandle($handle) | Out-Null
        $handle = [IntPtr]::Zero
      }
    }
    if ($handle -ne [IntPtr]::Zero) { break }
  }
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 50 }
} while ($handle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
if (-not $candidate) {
  [Console]::Error.Write("The updater installer process did not appear at $target.")
  exit 124
}
if ($handle -eq [IntPtr]::Zero) {
  [Console]::Error.Write("Could not observe updater installer process $($candidate.ProcessId) after retrying.")
  exit 126
}
[Console]::Out.WriteLine('OPEN_SCIENCE_INSTALLER_OBSERVER_ACQUIRED')
[long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0
if (-not [OpenScienceProcessObserver]::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) {
  [OpenScienceProcessObserver]::CloseHandle($handle) | Out-Null
  throw 'Could not retain the observed installer creation time'
}
$startedAt = [DateTimeOffset]::new([DateTime]::FromFileTimeUtc($created)).ToUnixTimeMilliseconds()
[Console]::Out.WriteLine("OPEN_SCIENCE_INSTALLER_IDENTITY=$($candidate.ProcessId),$startedAt")
[Console]::Out.Flush()
$wait = [OpenScienceProcessObserver]::WaitForSingleObject($handle, 300000)
if ($wait -eq 0x00000102) {
  [OpenScienceProcessObserver]::CloseHandle($handle) | Out-Null
  [Console]::Error.Write("The updater installer process $($candidate.ProcessId) did not exit.")
  exit 125
}
[uint32]$exitCode = 0
if ($wait -ne 0 -or -not [OpenScienceProcessObserver]::GetExitCodeProcess($handle, [ref]$exitCode)) {
  [OpenScienceProcessObserver]::CloseHandle($handle) | Out-Null
  [Console]::Error.Write("Could not read updater installer exit code for process $($candidate.ProcessId).")
  exit 126
}
[OpenScienceProcessObserver]::CloseHandle($handle) | Out-Null
[Console]::Out.Write("installer pid=$($candidate.ProcessId) exit=$exitCode")
exit $exitCode
`.trim()
  const exit = runProcessImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      allowNonZero: true,
      env: { ...env, OPEN_SCIENCE_INSTALLER_WATCH_TARGET: installer },
      signal,
      timeoutMs: 370_000,
      onStdout: (output) => {
        if (output.split(/\r?\n/).includes('OPEN_SCIENCE_INSTALLER_OBSERVER_READY')) markReady()
        const match = /OPEN_SCIENCE_INSTALLER_IDENTITY=(\d+),(\d+)\r?\n/.exec(output)
        if (match)
          markAcquired({
            pid: Number(match[1]),
            startedAt: Number(match[2]),
            executablePath: installer
          })
      }
    }
  )
  void exit.then(
    (result) =>
      failReady(
        new Error(`Installer observer exited before readiness (${result.code}).\n${result.stderr}`)
      ),
    failReady
  )
  void exit.then(
    () => failAcquired(new Error('Installer exited before its identity was observed.')),
    failAcquired
  )
  return { ready, acquired, exit }
}

const requireObservedInstallerExit = (result) => {
  const match = /installer pid=(\d+) exit=(\d+)\s*$/.exec(result.stdout)
  if (!match || Number(match[2]) !== result.code)
    throw new Error(`The installer writer exit was not verified: ${result.stderr || result.stdout}`)
  return { pid: Number(match[1]), code: Number(match[2]) }
}

const runElectronUpdater = async ({
  executable,
  env,
  configRoots,
  expectedVersion,
  expectedInstaller,
  onDownloaded,
  onBeforeApply = async () => undefined,
  expectInstallerFailure = false,
  onInstallerObserved
}) => {
  // Playwright attaches a Node debugger to Electron. On Windows that debugger can keep the old
  // process alive after quitAndInstall, racing the detached NSIS handoff. Drive the same production
  // update commands through the app's authenticated loopback RPC instead, with no debugger attached.
  const startedAt = Date.now()
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
  const diagnosticOutput = () => redactPackagedAppOutput(output())
  const exit = observeChildExit(child)
  const installerObserver = new AbortController()
  let installerExit
  let installerInspection
  try {
    let { endpoint, auth } = await Promise.race([
      waitFor('the updater app web service', async () =>
        authenticatePackagedAppEndpoint(output(), configRoots)
      ),
      exit.then((code) => {
        throw new Error(
          `Updater app exited before becoming healthy (${code}).\n${diagnosticOutput()}`
        )
      })
    ])
    const bootstrapResponse = await fetchWithTimeout(`${endpoint}/api/bootstrap?${auth}`)
    if (!bootstrapResponse.ok) {
      throw new Error(`Updater app bootstrap returned HTTP ${bootstrapResponse.status}.`)
    }
    const bootstrap = await bootstrapResponse.json()
    if (bootstrap.platform !== 'win32' || !Number.isInteger(bootstrap.rpcProtocolVersion)) {
      throw new Error(`Unexpected updater app bootstrap: ${JSON.stringify(bootstrap)}`)
    }

    const checked = await withTimeout(
      invokeWebRpc({
        endpoint,
        auth,
        protocolVersion: bootstrap.rpcProtocolVersion,
        channel: 'update:check'
      }),
      'electron-updater check'
    )
    if (checked.state !== 'available' || checked.latest !== expectedVersion) {
      throw new Error(`Unexpected updater check result: ${JSON.stringify(checked)}`)
    }
    await waitFor(
      'electron-updater differential download',
      async () => {
        const status = await invokeWebRpc({
          endpoint,
          auth,
          protocolVersion: bootstrap.rpcProtocolVersion,
          channel: 'update:download'
        })
        const classification = classifyUpdaterDownloadStatus(status, expectedVersion)
        if (classification === 'ready') return status
        if (classification === 'pending') return undefined
        throw new Error(`Unexpected updater download result: ${JSON.stringify(status)}`)
      },
      UPDATE_TIMEOUT_MS
    )
    await onDownloaded()
    const preparation = await onBeforeApply({
      endpoint,
      auth,
      protocolVersion: bootstrap.rpcProtocolVersion
    })
    if (preparation?.connection) ({ endpoint, auth } = preparation.connection)

    // electron-updater intentionally detaches NSIS, so the app exit is not evidence that the
    // installation handoff finished. Attach a read-only watcher before applying the update to avoid
    // racing the new executable and to retain the real installer exit code when the handoff fails.
    const observer = observeInstaller({
      installer: expectedInstaller,
      env,
      signal: installerObserver.signal
    })
    installerExit = observer.exit
    installerInspection = onInstallerObserved
      ? observer.acquired.then((identity) =>
          onInstallerObserved({ identity, parentPid: child.pid, startedAt })
        )
      : Promise.resolve()
    void installerInspection.catch(() => undefined)
    // The observer starts before update:apply to avoid racing detached NSIS. Mark its rejection as
    // handled immediately; the original promise is still awaited below or during failure cleanup.
    void installerExit.catch(() => undefined)
    await withTimeout(observer.ready, 'installer observer readiness', 60_000)
    const closed = waitForShutdownExit(exit, child, diagnosticOutput)
    const applied = await invokeWebRpc({
      endpoint,
      auth,
      protocolVersion: bootstrap.rpcProtocolVersion,
      channel: 'update:apply'
    })
    if (applied.state !== 'applying') {
      throw new Error(`Unexpected updater apply result: ${JSON.stringify(applied)}`)
    }
    const exitCode = await closed
    if (exitCode !== 0)
      throw new Error(`Updater app exited with ${exitCode}.\n${diagnosticOutput()}`)
    const installerResult = await installerExit
    await installerInspection
    requireObservedInstallerExit(installerResult)
    console.log(`Updater installer observation: ${installerResult.stdout}`)
    if (!expectInstallerFailure && installerResult.code !== 0) {
      throw new Error(
        `Updater installer exited with ${installerResult.code}.${installerResult.stderr ? `\n${installerResult.stderr}` : ''}`
      )
    }
    if (expectInstallerFailure && installerResult.code === 0)
      throw new Error('The controlled publication failure did not prevent installation.')
    return { parentPid: child.pid, startedAt, installerExitCode: installerResult.code }
  } catch (error) {
    installerObserver.abort(
      new Error('Updater installer observation cancelled after updater failure.')
    )
    await Promise.all([
      terminateProcessTree(child),
      installerExit?.catch(() => undefined),
      installerInspection?.catch(() => undefined)
    ])
    const processOutput = diagnosticOutput().trim()
    if (error instanceof Error) {
      error.message = redactPackagedAppOutput(error.message)
      if (processOutput && !error.message.includes(processOutput))
        error.message += `\n${processOutput}`
    }
    throw error
  }
}

const assertDifferentialObservation = (observation) => {
  if (
    observation.feedRequests < 1 ||
    observation.blockmapRequests < 2 ||
    observation.rangeRequests < 1 ||
    observation.fullInstallerRequests !== 0 ||
    observation.downloadedInstallerBytes < 1 ||
    observation.downloadedInstallerBytes >= observation.installerBytes ||
    observation.versionedFeed !== true ||
    observation.previousInstallerCacheVerified !== true ||
    typeof observation.previousVersion !== 'string' ||
    typeof observation.currentVersion !== 'string' ||
    observation.previousVersion === observation.currentVersion
  ) {
    throw new Error(
      `Windows updater did not use a complete differential path: ${JSON.stringify(observation)}`
    )
  }
  return observation
}

const main = async () => {
  if (process.platform !== 'win32')
    throw new Error('Windows updater certification requires Windows.')
  const options = parseArguments(process.argv.slice(2))
  await assertIsolatedWindowsAccount()
  await mkdir(win32.dirname(options.output), { recursive: true })
  const currentInstaller = await findSetupInstaller(options.currentDirectory)
  const previousInstaller = await findSetupInstaller(options.previousDirectory)
  const currentBlockmap = await singleFile(
    options.currentDirectory,
    /-win-x64-setup\.exe\.blockmap$/i,
    'current Windows blockmap'
  )
  const previousBlockmap = await singleFile(
    options.previousDirectory,
    /-win-x64-setup\.exe\.blockmap$/i,
    'previous Windows blockmap'
  )
  const latestFeed = await singleFile(options.currentDirectory, /^latest\.yml$/i, 'latest.yml')
  const currentVersion = installerVersion(currentInstaller)
  const previousVersion = installerVersion(previousInstaller)
  if (currentVersion === previousVersion)
    throw new Error('Updater certification needs two versions.')
  const expectedPreviousBlockmap = `${basename(currentInstaller).replaceAll(currentVersion, previousVersion)}.blockmap`
  if (basename(previousBlockmap).toLowerCase() !== expectedPreviousBlockmap.toLowerCase()) {
    throw new Error(
      `Previous blockmap is incompatible with the current feed: expected ${expectedPreviousBlockmap}.`
    )
  }
  gunzipSync(await readFile(currentBlockmap))
  gunzipSync(await readFile(previousBlockmap))

  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const installDirectory = join(root, 'app')
  const profileDirectory = join(root, 'profile')
  const env = windowsProfileEnvironment(profileDirectory)
  // Use the ordinary supported configuration-root option. Do not inherit a test-only override
  // that relocates installation coordination state out of the production location.
  delete env.OPEN_SCIENCE_E2E_STORAGE_ROOT
  const legacyConfigRoots = [win32.join(profileDirectory, '.open-science')]
  env.OPEN_SCIENCE_CONFIG_ROOT = legacyConfigRoots[0]
  const profileGuard = createUpgradeProfileGuard(true, `updater-${randomUUID()}`)
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true })
  ])

  let installed = false
  let assetServer
  let primaryError
  let observation
  let sentinel
  let sentinelIdentity
  let workload
  let secondary
  let secondaryIdentity
  let secondaryWorkload
  let suspendedSecondary
  let unregistered
  let secondaryEvidence
  let publicationFault
  let originalShortcut
  let recoveryEvidence
  let cancellationEvidence
  let writerWaitEvidence
  let observerHelper
  const secondaryProfile = join(root, 'secondary-profile')
  try {
    if (options.scenario === 'downgrade') {
      await installAndProbe({
        installer: currentInstaller,
        installDirectory,
        phase: 'previous',
        env,
        legacyConfigRoots
      })
      installed = true
    }
    const previousConfigRoot = await installAndProbe({
      installer: previousInstaller,
      installDirectory,
      phase: 'previous',
      env,
      legacyConfigRoots
    })
    installed = true
    await profileGuard.verifyCycle('previous', previousConfigRoot)
    if (['missing-exe-recovery', 'writer-shortcut-wait'].includes(options.scenario))
      originalShortcut = await readOriginalShortcut({
        executable: join(installDirectory, 'open-science.exe'),
        installer: previousInstaller
      })
    if (options.scenario === 'writer-shortcut-wait') {
      observerHelper = join(root, 'observer', 'windows-installation-processes.exe')
      await mkdir(win32.dirname(observerHelper), { recursive: true })
      // Read-only native mutex inspection remains available while the actual installation is
      // being replaced. This copy is never used as an application or recovery launcher.
      await cp(
        join(installDirectory, 'resources', 'windows-installation-processes.exe'),
        observerHelper
      )
    }

    // A second complete application tree exercises isolation under the same executable name.
    // It is deliberately outside the installation being updated and has its own real profile.
    const sentinelDirectory = join(root, 'other-installation')
    const sentinelProfile = join(root, 'other-profile')
    await cp(installDirectory, sentinelDirectory, { recursive: true })
    const sentinelEnv = { ...env, OPEN_SCIENCE_CONFIG_ROOT: sentinelProfile }
    sentinel = await launchForProcessLock({
      installDirectory: sentinelDirectory,
      expectedVersion: previousVersion,
      env: sentinelEnv,
      legacyConfigRoots: [sentinelProfile]
    })
    sentinelIdentity = await inspectInstalledProcess(
      join(sentinelDirectory, 'open-science.exe'),
      sentinel.child.pid
    )
    if (!sentinelIdentity) throw new Error('The other-installation sentinel did not start.')

    const localFeed = join(root, 'latest.yml')
    await writeFile(
      localFeed,
      rewriteFeedPaths(await readFile(latestFeed, 'utf8'), currentVersion),
      'utf8'
    )
    const currentInstallerRoute = `/releases/${currentVersion}/${basename(currentInstaller)}`
    assetServer = await startAssetServer({
      assets: [
        { route: '/latest.yml', path: localFeed },
        { route: currentInstallerRoute, path: currentInstaller },
        {
          route: `/releases/${currentVersion}/${basename(currentBlockmap)}`,
          path: currentBlockmap
        },
        {
          route: `/releases/${previousVersion}/${basename(previousBlockmap)}`,
          path: previousBlockmap
        }
      ],
      currentInstallerRoute
    })
    const updateConfigPath = join(installDirectory, 'resources', 'app-update.yml')
    const updateConfig = buildLocalUpdaterConfig(
      await readFile(updateConfigPath, 'utf8'),
      assetServer.url
    )
    await writeFile(updateConfigPath, updateConfig.source, 'utf8')
    const updaterCache = join(env.LOCALAPPDATA, updateConfig.updaterCacheDirName)
    const cachedInstaller = join(updaterCache, 'installer.exe')
    // electron-builder's NSIS template copies $EXEPATH here during a normal install. Do not seed the
    // cache: observing the real installer-created file proves production differential readiness.
    const [previousInstallerInfo, cachedInstallerInfo] = await Promise.all([
      stat(previousInstaller),
      stat(cachedInstaller)
    ])
    if (cachedInstallerInfo.size !== previousInstallerInfo.size) {
      throw new Error(
        'The previous NSIS install did not retain its installer for differential use.'
      )
    }

    const installerBytes = (await stat(currentInstaller)).size
    const persistObservation = async () => {
      observation = assertDifferentialObservation({
        schemaVersion: 1,
        mode: 'electron-updater-differential',
        previousVersion,
        currentVersion,
        installerBytes,
        ...assetServer.metrics,
        versionedFeed: true,
        previousInstallerCacheVerified: true,
        scenario: options.scenario
      })
      await writeFile(
        options.output,
        `${JSON.stringify({ ...observation, completed: false }, null, 2)}\n`,
        'utf8'
      )
    }
    const updateOwner = await runElectronUpdater({
      executable: join(installDirectory, 'open-science.exe'),
      env,
      configRoots: [previousConfigRoot],
      expectedVersion: currentVersion,
      expectedInstaller: join(
        env.LOCALAPPDATA,
        updateConfig.updaterCacheDirName,
        'pending',
        basename(currentInstaller)
      ),
      onDownloaded: persistObservation,
      expectInstallerFailure: options.scenario === 'missing-exe-recovery',
      onInstallerObserved:
        options.scenario === 'writer-shortcut-wait'
          ? async (writer) => {
              writerWaitEvidence = await verifyShortcutWaitsForWriter({
                ...writer,
                executable: join(installDirectory, 'open-science.exe'),
                appDataRoots: [env.APPDATA, process.env.APPDATA],
                shortcut: originalShortcut,
                root,
                observerHelper
              })
            }
          : undefined,
      onBeforeApply: async (connection) => {
        if (options.scenario !== 'basic')
          workload = await prepareNotebookWorkload({
            connection,
            workspace: join(root, 'notebook-workspace')
          })
        if (options.scenario === 'active-work')
          workload.activeWork = await prepareActiveNotebookWork({ connection, workload })
        if (
          ['multi-profile', 'unresponsive-profile', 'cancel-cleanup'].includes(options.scenario)
        ) {
          secondary = await launchForProcessLock({
            installDirectory,
            expectedVersion: previousVersion,
            env: { ...env, OPEN_SCIENCE_CONFIG_ROOT: secondaryProfile },
            legacyConfigRoots: [secondaryProfile]
          })
          secondaryIdentity = await inspectInstalledProcess(
            join(installDirectory, 'open-science.exe'),
            secondary.child.pid
          )
          if (!secondaryIdentity)
            throw new Error('The second installed application did not retain its identity.')
          const bootstrap = await (
            await fetchWithTimeout(`${secondary.endpoint}/api/bootstrap?${secondary.auth}`)
          ).json()
          if (!samePath(bootstrap.configRoot, secondaryProfile))
            throw new Error('The second instance opened the original profile.')
          const secondaryConnection = {
            endpoint: secondary.endpoint,
            auth: secondary.auth,
            protocolVersion: bootstrap.rpcProtocolVersion
          }
          secondaryWorkload = await prepareNotebookWorkload({
            connection: secondaryConnection,
            workspace: join(root, 'secondary-workspace')
          })
          secondaryWorkload.activeWork = await prepareActiveNotebookWork({
            connection: secondaryConnection,
            workload: secondaryWorkload
          })
          if (['unresponsive-profile', 'cancel-cleanup'].includes(options.scenario)) {
            const service = JSON.parse(
              await readFile(join(secondaryProfile, 'web-service.json'), 'utf8')
            )
            const executable =
              service.pid === secondary.child.pid
                ? join(installDirectory, 'open-science.exe')
                : join(installDirectory, 'resources', 'node-runtime', 'node.exe')
            const identity = await inspectInstalledProcess(executable, service.pid)
            if (!identity)
              throw new Error('Cannot bind the second profile backend for the RPC-hang fixture.')
            suspendedSecondary = await suspendFixtureProcess({ identity, root })
          }
        }
        if (options.scenario === 'no-protocol-runtime')
          unregistered = await startNoProtocolRuntime({ installDirectory, root, env })
        if (options.scenario === 'missing-exe-recovery')
          publicationFault = await denyFixturePublication({ installDirectory, root })
        if (options.scenario === 'cancel-cleanup') {
          const cancelled = await verifyCancellationAtCleanup({
            connection,
            configRoot: previousConfigRoot,
            sourceVersion: previousVersion,
            executable: join(installDirectory, 'open-science.exe'),
            workload,
            suspendedPeer: suspendedSecondary
          })
          cancellationEvidence = cancelled.evidence
          return { connection: cancelled.connection }
        }
      }
    })

    const installedExecutable = join(installDirectory, 'open-science.exe')
    if (publicationFault) {
      // The fixture never deletes or replaces the application. Only a genuine NSIS failure
      // after its old payload was removed satisfies this recovery checkpoint.
      const existing = await stat(installedExecutable).catch((error) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (existing)
        throw new Error('The failed real installation did not leave the main executable missing.')
      await publicationFault.restore()
      const token = await startOrdinaryShortcut(originalShortcut)
      recoveryEvidence = {
        fault: 'root-file-publication-denied',
        firstInstallerExitCode: updateOwner.installerExitCode,
        mainExecutableMissingAfterWriterExit: true,
        originalShortcut: { path: originalShortcut.path, sha256: originalShortcut.sha256 },
        launch: token
      }
    }
    await waitFor(
      'the updated executable to be committed to disk',
      async () => {
        try {
          const installedFile = await stat(installedExecutable)
          if (installedFile.isFile() && installedFile.size > 0) return installedFile.size
        } catch (error) {
          throw new Error(`Last observed no executable at ${installedExecutable}.`, {
            cause: error
          })
        }
        throw new Error(`Last observed an empty executable at ${installedExecutable}.`)
      },
      UPDATE_TIMEOUT_MS
    )
    const observedReady = await waitFor(
      recoveryEvidence
        ? 'the target window and backend after ordinary shortcut recovery'
        : 'the automatically launched target window and backend',
      () =>
        readAutomaticUpdateReady({
          ...updateOwner,
          appDataRoots: [env.APPDATA, process.env.APPDATA],
          executable: installedExecutable,
          expectedVersion: currentVersion,
          expectedConfigRoot: previousConfigRoot
        }),
      UPDATE_TIMEOUT_MS
    )
    const automaticReady = recoveryEvidence
      ? { ...observedReady, automatic: false, ordinaryShortcutRecovery: true }
      : observedReady
    await profileGuard.verifyCycle('current', automaticReady.configRoot)
    if (writerWaitEvidence) {
      const launcher = writerWaitEvidence.waitingShortcut
      await waitFor(
        'the ordinary waiting shortcut to exit after update completion',
        async () => {
          const live = await inspectInstalledProcess(launcher.executablePath, launcher.pid)
          return !live || live.startedAt !== launcher.startedAt ? true : undefined
        },
        30_000
      )
    }
    const sentinelAfter = await inspectInstalledProcess(
      sentinelIdentity.executablePath,
      sentinelIdentity.pid
    )
    if (sentinelAfter?.startedAt !== sentinelIdentity.startedAt)
      throw new Error('The update terminated or replaced the other-installation sentinel.')
    const sentinelResponse = await fetchWithTimeout(
      `${sentinel.endpoint}/api/bootstrap?${sentinel.auth}`
    )
    if (!sentinelResponse.ok || (await sentinelResponse.json()).appVersion !== previousVersion)
      throw new Error('The other installation no longer has a healthy backend.')
    const workloadEvidence = workload
      ? await verifyNotebookWorkload(workload, automaticReady.configRoot)
      : undefined
    if (unregistered) {
      const live = await inspectInstalledProcess(
        unregistered.identity.executablePath,
        unregistered.identity.pid
      )
      if (live?.startedAt === unregistered.identity.startedAt)
        throw new Error('The unregistered installed runtime survived production update cleanup.')
      secondaryEvidence = {
        kind: 'no-protocol-runtime',
        originalProcess: unregistered.identity,
        stopped: true
      }
    }
    if (secondary) {
      const live = await inspectInstalledProcess(
        secondaryIdentity.executablePath,
        secondaryIdentity.pid
      )
      if (live?.startedAt === secondaryIdentity.startedAt)
        throw new Error('The original second-profile application survived the installation update.')
      if (suspendedSecondary) await suspendedSecondary.exit
      // This is a separate data-readback launch after the original automatic-ready assertion.
      // It cannot satisfy or repair the primary update's automatic launch requirement.
      secondary = await launchForProcessLock({
        installDirectory,
        expectedVersion: currentVersion,
        env: { ...env, OPEN_SCIENCE_CONFIG_ROOT: secondaryProfile },
        legacyConfigRoots: [secondaryProfile]
      })
      secondaryEvidence = {
        kind: options.scenario,
        originalProcess: secondaryIdentity,
        originalStopped: true,
        ...(suspendedSecondary
          ? { unresponsiveBackend: suspendedSecondary.identity, rpcSuspendedBeforeApply: true }
          : {}),
        ...(await verifyNotebookWorkload(secondaryWorkload, secondaryProfile))
      }
      await requestPackagedAppShutdown(secondary.endpoint, secondary.auth)
      await waitForShutdownExit(secondary.exit, secondary.child, secondary.output)
      secondary = undefined
    }
    await writeFile(
      options.output,
      `${JSON.stringify(
        {
          ...observation,
          completed: true,
          ...(recoveryEvidence
            ? { ordinaryStartupRecovery: { ...recoveryEvidence, ready: automaticReady } }
            : { automaticReady }),
          sentinel: { ...sentinelIdentity, survived: true },
          ...(workloadEvidence ? { workload: workloadEvidence } : {}),
          ...(secondaryEvidence ? { secondary: secondaryEvidence } : {}),
          ...(cancellationEvidence ? { cancellation: cancellationEvidence } : {}),
          ...(writerWaitEvidence ? { writerWait: writerWaitEvidence } : {}),
          artifacts: {
            currentInstaller: {
              path: currentInstaller,
              sha256: await sha256File(currentInstaller)
            },
            previousInstaller: {
              path: previousInstaller,
              sha256: await sha256File(previousInstaller)
            },
            currentBlockmap: { path: currentBlockmap, sha256: await sha256File(currentBlockmap) },
            previousBlockmap: {
              path: previousBlockmap,
              sha256: await sha256File(previousBlockmap)
            },
            feed: { path: latestFeed, sha256: await sha256File(latestFeed) }
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    console.log('Windows electron-updater differential certification completed successfully.')
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  const cleanup = async (operation) => {
    try {
      await operation()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (primaryError) {
    await cleanup(() =>
      captureStartupLogs(
        [...legacyConfigRoots, secondaryProfile],
        resolve('test-results', 'windows-installer-smoke', `updater-${randomUUID()}`)
      )
    )
    await cleanup(() =>
      writeFile(
        options.output,
        `${JSON.stringify(
          {
            ...observation,
            completed: false,
            failure: redactPackagedAppOutput(
              primaryError instanceof Error ? primaryError.message : String(primaryError)
            )
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    )
  }
  if (sentinel) {
    await cleanup(() => requestPackagedAppShutdown(sentinel.endpoint, sentinel.auth))
    await cleanup(() => waitForShutdownExit(sentinel.exit, sentinel.child, sentinel.output))
  }
  if (publicationFault) await cleanup(() => publicationFault.restore())
  if (suspendedSecondary) await cleanup(() => suspendedSecondary.resume())
  if (secondary && secondary.child.exitCode === null && secondary.child.signalCode === null) {
    await cleanup(() => requestPackagedAppShutdown(secondary.endpoint, secondary.auth))
    await cleanup(() => waitForShutdownExit(secondary.exit, secondary.child, secondary.output))
  }
  if (unregistered) await cleanup(() => terminateProcessTree(unregistered.child))
  await cleanup(() => terminateDirectoryProcesses(root))
  if (assetServer) await cleanup(() => assetServer.close())
  await cleanup(() => profileGuard.cleanup(primaryError))
  if (installed) await cleanup(() => uninstallAndVerify(installDirectory, env))
  for (const version of [previousVersion, currentVersion]) {
    await cleanup(() => cleanupSmokeRegistrations(root, version, primaryError))
  }
  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))
  if (primaryError) throw primaryError
  if (cleanupErrors[0]) throw cleanupErrors[0]
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
  requireObservedInstallerExit,
  denyFixturePublication,
  startOrdinaryShortcut,
  suspendFixtureProcess,
  startNoProtocolRuntime,
  prepareActiveNotebookWork,
  prepareNotebookWorkload,
  readAutomaticUpdateReady,
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  classifyUpdaterDownloadStatus,
  invokeWebRpc,
  redactPackagedAppOutput,
  observeInstaller,
  parseArguments,
  parseSingleRange,
  rewriteFeedPaths
}
