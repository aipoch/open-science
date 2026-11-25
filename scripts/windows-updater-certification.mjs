/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { rejects } from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { dump, load } from 'js-yaml'
import { chromium, expect } from '@playwright/test'
import {
  prepareOwnedAgentFixture,
  startOwnedAgentFixture,
  assertOwnedAgentReaped,
  prepareStaleNotebookFixture,
  startUpdateNotebook,
  assertUpdateNotebookReaped
} from './windows-updater-owned-processes.mjs'

import {
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  installApplication,
  installAndProbe,
  launchAndExpectDatabaseBlocked,
  launchAndProbe,
  launchUninstallerLockHolder,
  runProcess,
  terminateDirectoryProcesses,
  terminateProcessTree,
  uninstallAndVerify,
  waitFor,
  waitForShutdownExit
} from './windows-installer-smoke.mjs'

const UPDATE_TIMEOUT_MS = 180_000
const SMOKE_ROOT_PREFIX = 'open-science-installer-smoke-updater-'
const WINDOWS_SIGNING_PUBLISHER_DN = 'CN=AIPOCH PTE. LTD., O=AIPOCH PTE. LTD., L=Singapore, C=SG'
const compileWindowsInstallPublication = createRequire(import.meta.url)(
  '../build/compile-windows-install-publication.cjs'
)

const buildWindowsUninstallHelper = (destination) => {
  compileWindowsInstallPublication.uninstallHelper(destination)
  return destination
}

const sha512Base64 = async (path) =>
  createHash('sha512')
    .update(await readFile(path))
    .digest('base64')

// Model a cached package without duplicating a full extracted installer on the runner.
const seedPreparedFixture = async (root, executable, version, fileName, marker) => {
  const canonical = await realpath(executable)
  const sha512 = createHash('sha512').update(randomUUID()).digest('base64')
  const id = createHash('sha256')
    .update(canonical.toLowerCase())
    .update('\0')
    .update(sha512)
    .digest('hex')
    .slice(0, 32)
  const stage = join(root, id)
  await mkdir(join(stage, 'payload'), { recursive: true })
  await writeFile(join(stage, 'payload', 'sample'), 'prepared payload')
  await writeFile(
    join(stage, marker),
    JSON.stringify({ executable: canonical, version, fileName, sha512 }),
    { flag: 'wx' }
  )
  return stage
}

const verifyCachedInstaller = async (source, cached) => {
  const [sourceHash, cachedHash] = await Promise.all([sha512Base64(source), sha512Base64(cached)])
  if (sourceHash !== cachedHash) {
    throw new Error(
      `The previous NSIS install retained an unexpected installer cache. Expected ${sourceHash}, found ${cachedHash}.`
    )
  }
  return sourceHash
}

const normalizeLegacyPublisherName = (value) => {
  const names = Array.isArray(value) ? value : [value]
  if (!names.some((name) => name === 'AIPOCH PTE. LTD.')) return undefined
  return names.map((name) => (name === 'AIPOCH PTE. LTD.' ? WINDOWS_SIGNING_PUBLISHER_DN : name))
}

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
  if (!currentDirectory || !previousDirectory || !output) {
    throw new Error('Usage: --current-dir <path> --previous-dir <path> --output <path>')
  }
  return {
    currentDirectory: resolve(currentDirectory),
    previousDirectory: resolve(previousDirectory),
    output: resolve(output),
    ...(argv.includes('--rollback') ? { rollback: true } : {}),
    ...(argv.includes('--cold-launch') ? { coldLaunch: true } : {}),
    ...(argv.includes('--foreign-process') ? { foreignProcess: true } : {}),
    ...(argv.includes('--owned-processes') ? { ownedProcesses: true } : {}),
    ...(argv.includes('--windows-recovery') ? { windowsRecovery: true } : {}),
    ...(argv.includes('--notebook') ? { notebook: true } : {})
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
  const publisherName = normalizeLegacyPublisherName(parsed.publisherName)
  const config = {
    ...parsed,
    provider: 'generic',
    url,
    channel: 'latest',
    useMultipleRangeRequest: false,
    ...(publisherName ? { publisherName } : {})
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
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
        // The fixture owns every connection; no download remains after updater certification.
        server.closeAllConnections()
      })
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

const summarizeUpdateStatus = ({ state, current, latest, reason, error, recovery }) => ({
  state,
  current,
  latest,
  reason,
  error,
  recovery
})

const inspectUpdaterSuccessor = async ({
  appDataRoots,
  executable,
  parentPid,
  expectedVersion
}) => {
  for (const appData of new Set(appDataRoots.filter(Boolean))) {
    for (const suffix of ['Open-Science/UpdateHandoffs', 'Open-Science-UpdateHandoffs']) {
      const root = join(appData, suffix)
      for (const name of await readdir(root).catch(() => [])) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)) continue
        const directory = join(root, name)
        const request = await readFile(join(directory, 'request.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => undefined)
        if (
          !request ||
          request.schema !== 1 ||
          request.operationId !== name ||
          request.parentPid !== parentPid ||
          request.targetVersion !== expectedVersion ||
          typeof request.applicationPath !== 'string' ||
          win32.normalize(request.applicationPath).toLowerCase() !==
            win32.normalize(executable).toLowerCase()
        )
          continue
        for (const stage of ['installed', 'ready']) {
          const receipt = await readFile(join(directory, `${stage}.receipt`), 'utf8').catch(
            () => ''
          )
          if (receipt !== `${name}\r\n${stage}\r\n`)
            throw new Error(`Update ${name} has no valid ${stage} receipt in ${directory}.`)
        }
        return { operationId: name, successorReadyVerified: true }
      }
    }
  }
  throw new Error('No handoff request matches the source process, executable and target version.')
}

const invokeWebRpc = async ({ endpoint, auth, protocolVersion, channel, fetchImpl = fetch }) => {
  const response = await fetchWithTimeout(
    `${endpoint}/rpc/${encodeURIComponent(channel)}?${auth}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion, args: [] })
    },
    UPDATE_TIMEOUT_MS,
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
  // Consumers await readiness before applying; handle an early observer exit immediately too.
  void ready.catch(() => undefined)
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

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
$target = [IO.Path]::GetFullPath($env:OPEN_SCIENCE_INSTALLER_WATCH_TARGET)
# Warm up CIM before acknowledging readiness: starting PowerShell is not enough.
Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" | Out-Null
[Console]::Out.WriteLine('OPEN_SCIENCE_INSTALLER_OBSERVER_READY')
[Console]::Out.Flush()
$deadline = [DateTime]::UtcNow.AddMinutes(3)
$candidate = $null
$handle = [IntPtr]::Zero
do {
  $candidate = Get-CimInstance -ClassName Win32_Process -Filter "Name = '$([IO.Path]::GetFileName($target).Replace("'", "''"))'" |
    Where-Object {
      $_.ExecutablePath -and
      [String]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase)
    } |
    Select-Object -First 1
  if ($candidate) {
    $access = 0x00100000 -bor 0x00001000
    $handle = [OpenScienceProcessObserver]::OpenProcess($access, $false, [uint32]$candidate.ProcessId)
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
      timeoutMs: 490_000,
      onStdout: (output) => {
        if (output.split(/\r?\n/).includes('OPEN_SCIENCE_INSTALLER_OBSERVER_READY')) markReady()
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
  return { ready, exit }
}

const waitForInstalledApplicationsToExit = (installDirectory, env) =>
  runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        "$prefix = $env:OPEN_SCIENCE_SMOKE_INSTALL_DIR + '\\'",
        '$deadline = [DateTime]::UtcNow.AddSeconds(60)',
        'do {',
        '  $owners = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })',
        '  if (!$owners.Count) { exit 0 }',
        '  Start-Sleep -Milliseconds 250',
        '} while ([DateTime]::UtcNow -lt $deadline)',
        'throw ("Desktop quit left installation processes running: " + (($owners | Select-Object Name, ProcessId, ParentProcessId | ConvertTo-Json -Compress)))'
      ].join('\n')
    ],
    { env: { ...env, OPEN_SCIENCE_SMOKE_INSTALL_DIR: installDirectory } }
  )

// The isolated profile survives successive launches. Keep only this launch's records,
// including any that rotated while NSIS handed off to the new desktop.
const readShortcutEvidence = async (env, since) => {
  const directory = join(env.OPEN_SCIENCE_USER_DATA, 'desktop-logs')
  const scans = []
  const decisions = []
  for (const name of await readdir(directory)) {
    if (!/^main(?:\.\d+)?\.log$/.test(name)) continue
    const lines = (await readFile(join(directory, name), 'utf8')).split('\n').slice(0, -1)
    for (const line of lines) {
      if (
        !line.includes('Windows installation occupancy inspected') &&
        !line.includes('"windows-prepared-update"')
      )
        continue
      const { t, scope, msg, data } = JSON.parse(line)
      if (!(Date.parse(t) >= since)) continue
      if (scope === 'windows-prepared-update') decisions.push({ t, msg, data })
      if (scope === 'update' && msg === 'Windows installation occupancy inspected') {
        const { fileCount, resourceCount, enumMs, rmMs, durationMs } = data
        scans.push({ t, fileCount, resourceCount, enumMs, rmMs, durationMs })
      }
    }
  }
  const byTime = (a, b) => a.t.localeCompare(b.t)
  return { scans: scans.sort(byTime), decisions: decisions.sort(byTime) }
}

// A new cold launch can recheck on holder exit or after the product's one-minute cache expires.
const shortcutBlockerCacheMs = 60_000
const waitForShortcutRecheck = async (pids) => {
  const deadline = performance.now() + shortcutBlockerCacheMs
  while (
    performance.now() < deadline &&
    pids.some((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if (error.code === 'ESRCH') return false
        if (error.code === 'EPERM') return true
        throw error
      }
    })
  )
    await delay(250)
}

const certifyShortcutVersion = async (launch, expectedVersion, released) => {
  let observation = await launch()
  if (released && observation.current === released.previousVersion && observation.scans.length) {
    const last = observation.decisions.at(-1)
    const data = last?.data
    const pids = Array.isArray(data?.blockers) ? data.blockers.map((blocker) => blocker?.pid) : []
    if (
      last?.msg === 'Prepared update deferred at startup' &&
      data?.reason === 'installation-busy' &&
      data.detail === 'foreign-process' &&
      pids.length &&
      pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== released.holderPid)
    ) {
      console.log('Released shortcut deferred by a different file holder:', JSON.stringify(last))
      await released.waitForRecheck(pids)
      observation = await launch()
    }
  }
  if (observation.current !== expectedVersion)
    throw new Error(
      `Shortcut opened ${observation.current}, expected ${expectedVersion}. Handoff decisions: ${JSON.stringify(observation.decisions)}`
    )
  return observation.scans
}

// Launch the installer-created link itself. Its unchanged target and the version reported by
// the healthy renderer distinguish activation from a harness that launched the staged exe.
const launchInstalledShortcut = async (installDirectory, env, expectedVersion) => {
  const portFile = join(env.OPEN_SCIENCE_USER_DATA, 'DevToolsActivePort')
  await rm(portFile, { force: true })
  const startedAt = Date.now()
  await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        "$shortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Open-Science.lnk'",
        '$target = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath',
        "if ($target -ne $env:OPEN_SCIENCE_EXPECTED_SHORTCUT) { throw 'Unexpected desktop shortcut' }",
        "Start-Process -FilePath $shortcut -ArgumentList '--remote-debugging-port=0'"
      ].join('\n')
    ],
    { env: { ...env, OPEN_SCIENCE_EXPECTED_SHORTCUT: join(installDirectory, 'open-science.exe') } }
  )
  const browser = await waitFor(
    'the workspace launched through the shortcut',
    async () => {
      const port = (await readFile(portFile, 'utf8')).split('\n')[0]
      const pages = await (await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`)).json()
      if (!pages.some((target) => target.type === 'page' && target.url.startsWith('file:'))) return
      return chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    },
    UPDATE_TIMEOUT_MS
  )
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith('file:'))
    await page.waitForFunction(
      async () => (await window.api?.databaseStartup.getState())?.phase === 'ready'
    )
    const { current } = await page.evaluate(() => window.api.update.getStatus())
    const { scans, decisions } = await readShortcutEvidence(env, startedAt)
    console.log('Shortcut occupancy scans:', JSON.stringify({ expectedVersion, current, scans }))
    // The database can already be ready while the renderer is still hydrating. Quit from the
    // interactive home screen so its normal persistence and confirmation handlers are mounted.
    await page
      .locator('[data-home-scroll]')
      .waitFor({ state: 'attached', timeout: UPDATE_TIMEOUT_MS })
    console.log(`Original shortcut opened the home screen on ${current}.`)
    page.on('console', (message) => {
      if (message.text().startsWith('Smoke quit confirmation:')) console.log(message.text())
    })
    await page.evaluate(() => {
      window.api.window.onCloseConfirmRequest(({ requestId, variant }) => {
        console.info('Smoke quit confirmation:', variant)
        if (variant === 'quit')
          window.api.window.sendCloseConfirmResponse({ requestId, choice: 'quit' })
      })
      void window.api.databaseStartup.quit()
    })
    try {
      await waitForInstalledApplicationsToExit(installDirectory, env)
    } catch (error) {
      const dialogs = await page
        .locator('[role="alertdialog"], [role="alert"]')
        .allTextContents()
        .catch(() => [])
      throw new Error(
        `Shortcut version ${current} did not exit. Visible notices: ${JSON.stringify(dialogs)}`,
        { cause: error }
      )
    }
    return { current, scans, decisions }
  } finally {
    await browser.close()
  }
}

const probeInstalledShortcut = (installDirectory, env, expectedVersion, released) =>
  certifyShortcutVersion(
    () => launchInstalledShortcut(installDirectory, env, expectedVersion),
    expectedVersion,
    released
  )

const runElectronUpdater = async ({
  executable,
  env,
  expectedVersion,
  expectedInstaller,
  onDownloaded,
  transferMetrics,
  beforeApply,
  coldLaunch,
  ownedAgentFixture,
  windowsRecovery,
  notebook,
  evidencePath
}) => {
  // Playwright attaches a Node debugger to Electron. On Windows that debugger can keep the old
  // process alive after quitAndInstall, racing the detached NSIS handoff. Drive the same production
  // update commands through renderer IPC over CDP, without attaching the Node debugger. The Node
  // backend's web RPC intentionally does not own desktop updates.
  const appEnv = windowsRecovery
    ? {
        ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')),
        PATH: ''
      }
    : env
  const preparedRoot = join(
    win32.dirname(win32.dirname(expectedInstaller)),
    'open-science-prepared'
  )
  let claimedFixture
  if (coldLaunch) {
    // Model an already-claimed, superseded build of the same version. Only the SDK's current
    // installer is genuine; the desktop must leave this receipt alone until the new app starts.
    const directory = await seedPreparedFixture(
      preparedRoot,
      executable,
      expectedVersion,
      basename(expectedInstaller),
      'installing.json'
    )
    claimedFixture = join(directory, 'installing.json')
  }
  const child = spawn(executable, ['--remote-debugging-port=0'], {
    env: appEnv,
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
  let browser
  let page
  let staleNotebookFixture
  let phase = 'desktop-startup'
  try {
    const port = await Promise.race([
      waitFor('the updater renderer CDP port', async () => {
        const portFile = join(env.OPEN_SCIENCE_USER_DATA, 'DevToolsActivePort')
        return (await readFile(portFile, 'utf8')).split('\n')[0] || undefined
      }),
      exit.then((code) => {
        throw new Error(
          `Updater app exited before becoming healthy (${code}).\n${diagnosticOutput()}`
        )
      })
    ])
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    page = await waitFor('the updater desktop window', () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => page.url().startsWith('file:'))
    )
    page.setDefaultTimeout(60_000)
    console.log('Updater desktop window connected.')
    await page.waitForFunction(() => Boolean(window.api?.update))
    await waitFor(
      'the updater database',
      async () =>
        (await page.evaluate(() => window.api.databaseStartup.getState())).phase === 'ready'
    )
    await page.evaluate(() => window.api.settings.markOnboardingComplete())
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    const ownedEvidence = ownedAgentFixture
      ? await startOwnedAgentFixture(page, ownedAgentFixture)
      : undefined
    const notebookEvidence = notebook ? await startUpdateNotebook(page, evidencePath) : undefined
    if (windowsRecovery) {
      const { dataRoot } = await page.evaluate(() => window.api.storage.getStatus())
      staleNotebookFixture = await prepareStaleNotebookFixture(dataRoot)
      console.log(
        'Seeded a stale Notebook host receipt with a live unrelated PID; app PATH is empty.'
      )
    }
    const invoke = async (action) => {
      phase = action
      console.log(`Updater command started: ${action}`)
      const status = await withTimeout(
        page.evaluate((name) => window.api.update[name](), action),
        `desktop update ${action}`
      )
      console.log(
        `Updater command completed: ${action} ${JSON.stringify(summarizeUpdateStatus(status))}`
      )
      return status
    }

    const checked = coldLaunch
      ? await waitFor('scheduled startup offer', async () => {
          const status = await page.evaluate(() => window.api.update.getStatus())
          return status.state === 'available' && status.automaticDownloads ? status : undefined
        })
      : await withTimeout(invoke('check'), 'electron-updater check')
    if (checked.state !== 'available' || checked.latest !== expectedVersion) {
      throw new Error(`Unexpected updater check result: ${JSON.stringify(checked)}`)
    }
    let admission
    if (coldLaunch) {
      // CI can start the desktop without a foreground HWND. The product admission rule is
      // lack of focus. Use the actual tray action only when a foreground window needs hiding.
      phase = 'background-download'
      const connection = await runProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            "$ErrorActionPreference = 'Stop'",
            '$profileInfo = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]::GetInternetConnectionProfile()',
            "if (!$profileInfo) { throw 'Runner has no Internet connection profile' }",
            '$cost = $profileInfo.GetConnectionCost()',
            '$cost | Select-Object NetworkCostType, Roaming, OverDataLimit, ApproachingDataLimit, BackgroundDataUsageRestricted | ConvertTo-Json -Compress'
          ].join('\n')
        ],
        { env }
      )
      console.log('Windows connection cost at download admission:', connection.stdout.trim())
      const cost = JSON.parse(connection.stdout)
      admission =
        cost.NetworkCostType === 1 &&
        !cost.Roaming &&
        !cost.OverDataLimit &&
        !cost.ApproachingDataLimit &&
        !cost.BackgroundDataUsageRestricted
          ? 'unrestricted'
          : 'restricted-or-unknown'
      if (await page.evaluate(() => document.hasFocus())) {
        await page.evaluate(async () => {
          await window.api.settings.setClosePreference({ preference: 'minimize' })
          await window.api.window.close()
        })
      }
      if (admission === 'restricted-or-unknown') {
        // Hosted Windows Server commonly reports Unknown. Observe a full admission interval,
        // then exercise the real user's Download action to certify preparation and cold launch.
        await delay(65_000)
        const status = await page.evaluate(() => window.api.update.getStatus())
        if (
          status.state !== 'available' ||
          transferMetrics.blockmapRequests ||
          transferMetrics.downloadedInstallerBytes
        )
          throw new Error(
            'An ineligible connection started a background transfer: ' +
              JSON.stringify(transferMetrics)
          )
        await invoke('download')
      }
    }
    await waitFor(
      'electron-updater differential download',
      async () => {
        const status = coldLaunch
          ? await page.evaluate(() => window.api.update.getStatus())
          : await invoke('download')
        const classification = classifyUpdaterDownloadStatus(status, expectedVersion)
        if (classification === 'ready') return status
        if (classification === 'pending') return undefined
        throw new Error(`Unexpected updater download result: ${JSON.stringify(status)}`)
      },
      coldLaunch ? UPDATE_TIMEOUT_MS + 60_000 : UPDATE_TIMEOUT_MS
    )
    if (
      windowsRecovery &&
      (!output().includes('LiteralPath:') || /Ignoring signature validation/i.test(output()))
    )
      throw new Error(
        'The installed updater did not complete Authenticode verification with an empty PATH.'
      )
    await onDownloaded(ownedEvidence)
    await beforeApply?.({ invoke, page })

    if (coldLaunch) {
      phase = 'background-extraction'
      await waitFor(
        'verified background extraction',
        async () => {
          const sdk = JSON.parse(
            await readFile(join(win32.dirname(expectedInstaller), 'update-info.json'), 'utf8')
          )
          for (const name of await readdir(preparedRoot)) {
            if (name === basename(win32.dirname(claimedFixture))) continue
            const receipt = JSON.parse(
              await readFile(join(preparedRoot, name, 'ready.json'), 'utf8')
            )
            if (
              receipt.version === expectedVersion &&
              receipt.fileName === basename(expectedInstaller) &&
              receipt.sha512 === sdk.sha512
            )
              return true
          }
          return false
        },
        UPDATE_TIMEOUT_MS
      )
      await stat(claimedFixture)
      await page.evaluate(() => {
        void window.api.databaseStartup.quit()
      })
      const code = await waitForShutdownExit(exit, child, diagnosticOutput)
      if (code !== 0) throw new Error(`Normal desktop quit failed (${code})`)
      return {
        normalQuit: true,
        admission,
        downloadInitiator: admission === 'unrestricted' ? 'scheduler' : 'manual'
      }
    }

    // electron-updater intentionally detaches NSIS, so the app exit is not evidence that the
    // installation handoff finished. Attach a read-only watcher before applying the update to avoid
    // racing the new executable and to retain the real installer exit code when the handoff fails.
    const observer = observeInstaller({
      installer: expectedInstaller,
      env,
      signal: installerObserver.signal
    })
    installerExit = observer.exit
    // The observer starts before update:apply to avoid racing detached NSIS. Mark its rejection as
    // handled immediately; the original promise is still awaited below or during failure cleanup.
    void installerExit.catch(() => undefined)
    await withTimeout(observer.ready, 'installer observer readiness', 60_000)
    await applyWithOccupancyRecheck(invoke)
    // Preflight can perform a cold resource scan. Its time must not consume the app-exit budget.
    const exitCode = await waitForShutdownExit(exit, child, diagnosticOutput)
    if (exitCode !== 0)
      throw new Error(`Updater app exited with ${exitCode}.\n${diagnosticOutput()}`)
    const ownedProcessRecovery = ownedEvidence
      ? await assertOwnedAgentReaped(ownedEvidence)
      : undefined
    const notebookRecovery = notebookEvidence
      ? await assertUpdateNotebookReaped(notebookEvidence)
      : undefined
    if (notebookRecovery)
      console.log(`Notebook processes released: ${JSON.stringify(notebookRecovery)}`)
    if (ownedProcessRecovery)
      console.log(
        `Application-owned processes released before installer completion: ${JSON.stringify(ownedProcessRecovery)}`
      )
    const installerResult = await installerExit
    console.log(`Updater installer observation: ${installerResult.stdout}`)
    if (installerResult.code !== 0) {
      throw new Error(
        `Updater installer exited with ${installerResult.code}.${installerResult.stderr ? `\n${installerResult.stderr}` : ''}`
      )
    }
    const successor = await waitFor(
      'the updated application readiness receipt',
      () =>
        inspectUpdaterSuccessor({
          appDataRoots: [env.APPDATA, process.env.APPDATA],
          executable,
          parentPid: child.pid,
          expectedVersion
        }),
      UPDATE_TIMEOUT_MS
    )
    console.log(`Updated application presentation and backend ready: ${JSON.stringify(successor)}`)
    const windowsRecoveryEvidence = staleNotebookFixture
      ? {
          applicationPathEmpty: true,
          downloadSignatureVerified: true,
          ...(await staleNotebookFixture.assertRecovered())
        }
      : undefined
    return {
      ...successor,
      ...(notebookRecovery ? { notebookRecovery } : {}),
      ...(ownedProcessRecovery ? { ownedProcessRecovery } : {}),
      ...(windowsRecoveryEvidence ? { windowsRecovery: windowsRecoveryEvidence } : {})
    }
  } catch (error) {
    console.error(`Updater failed during ${phase}.`)
    if (page && evidencePath) {
      await page
        .screenshot({ path: `${evidencePath}.failed.png`, timeout: 10_000 })
        .catch(() => undefined)
    }
    installerObserver.abort(
      new Error('Updater installer observation cancelled after updater failure.')
    )
    await Promise.all([terminateProcessTree(child), installerExit?.catch(() => undefined)])
    const processOutput = diagnosticOutput().trim()
    if (error instanceof Error) {
      error.message = redactPackagedAppOutput(error.message)
      if (processOutput && !error.message.includes(processOutput))
        error.message += `\n${processOutput}`
    }
    throw error
  } finally {
    if (evidencePath) await writeFile(`${evidencePath}.application.log`, diagnosticOutput(), 'utf8')
    await browser?.close()
    await staleNotebookFixture?.cleanup()
  }
}

const isForeignOccupancy = (status) =>
  status.state === 'ready' &&
  status.reason === 'installation-busy' &&
  status.recovery?.detail === 'foreign-process'

const isTransientRuntimeDisconnect = (status) =>
  status.state === 'ready' &&
  status.reason === 'runtime-not-controlled' &&
  status.error === 'Desktop runtime is disconnected.'

const waitForInstallRetry = async (invoke) => {
  const status = await waitFor(
    'external file holder to release installation files',
    async () => {
      const checked = await invoke('recheck')
      return isForeignOccupancy(checked) || isTransientRuntimeDisconnect(checked)
        ? undefined
        : checked
    },
    30_000
  )
  if (status.state !== 'ready' || status.reason || !status.recovery?.canRetryInstall)
    throw new Error(`Unexpected updater recheck result: ${JSON.stringify(status)}`)
}

const applyWithOccupancyRecheck = async (invoke) => {
  let applied = await invoke('apply')
  if (isForeignOccupancy(applied)) {
    await waitForInstallRetry(invoke)
    applied = await invoke('apply')
  }
  if (applied.state !== 'applying')
    throw new Error(`Unexpected updater apply result: ${JSON.stringify(applied)}`)
}

const certifyForeignProcessRecovery = async ({ invoke, acquireLock, onBlocked }) => {
  const lock = await acquireLock()
  const observations = []
  const command = async (action) => {
    const started = Date.now()
    const status = await withTimeout(invoke(action), `blocked update ${action}`, 30_000)
    observations.push({
      action,
      elapsedMs: Date.now() - started,
      status: summarizeUpdateStatus(status)
    })
    return status
  }
  const assertBlocked = (status) => {
    if (
      status.state !== 'ready' ||
      status.reason !== 'installation-busy' ||
      status.recovery?.detail !== 'foreign-process' ||
      !status.recovery.blockingProcesses?.some((process) => process.pid === lock.pid)
    ) {
      throw new Error(`External file holder was not reported: ${JSON.stringify(status)}`)
    }
  }
  try {
    assertBlocked(await command('apply'))
    assertBlocked(await command('recheck'))
    await onBlocked?.()
  } finally {
    await lock.release()
  }
  await waitForInstallRetry(command)
  console.log(`External process recovery: ${JSON.stringify(observations)}`)
  return observations
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
  // NSIS relaunches through the user's Windows shell. Preserve its native user folders so the
  // source, installer and successor resolve the same handoff and updater-cache directories.
  // The disposable runner still isolates application state through the explicit profile below.
  const env = { ...process.env }
  env.OPEN_SCIENCE_USER_DATA = join(profileDirectory, 'electron-profile')
  env.OPEN_SCIENCE_E2E_STORAGE_ROOT = join(profileDirectory, 'config')
  console.log(`Updater isolated root: ${root}`)
  const legacyConfigRoots = [env.OPEN_SCIENCE_E2E_STORAGE_ROOT]
  const profileGuard = createUpgradeProfileGuard(true, `updater-${randomUUID()}`)
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true }),
    mkdir(join(profileDirectory, 'Downloads'), { recursive: true })
  ])

  let installed = false
  let nextPreparation
  let assetServer
  let primaryError
  let observation
  try {
    const previousConfigRoot = await installAndProbe({
      installer: previousInstaller,
      installDirectory,
      phase: 'previous',
      env,
      legacyConfigRoots
    })
    installed = true
    await profileGuard.verifyCycle('previous', previousConfigRoot)
    const ownedAgentFixture = options.ownedProcesses
      ? await prepareOwnedAgentFixture({
          installDirectory,
          configRoot: previousConfigRoot,
          directory: join(root, 'owned-agent')
        })
      : undefined

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
    const previousInstallerSha512 = await verifyCachedInstaller(previousInstaller, cachedInstaller)

    const installerBytes = (await stat(currentInstaller)).size
    const persistObservation = async (ownedEvidence) => {
      observation = assertDifferentialObservation({
        schemaVersion: 1,
        mode: 'electron-updater-differential',
        previousVersion,
        currentVersion,
        installerBytes,
        ...assetServer.metrics,
        versionedFeed: true,
        previousInstallerCacheVerified: true,
        previousInstallerSha512
      })
      if (ownedEvidence)
        observation.ownedProcessRecovery = { ...ownedEvidence, processTreeReaped: false }
      await writeFile(options.output, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')
    }
    const successor = await runElectronUpdater({
      executable: join(installDirectory, 'open-science.exe'),
      env,
      evidencePath: options.output,
      expectedVersion: currentVersion,
      expectedInstaller: join(
        env.LOCALAPPDATA,
        updateConfig.updaterCacheDirName,
        'pending',
        basename(currentInstaller)
      ),
      onDownloaded: persistObservation,
      transferMetrics: assetServer.metrics,
      coldLaunch: options.coldLaunch,
      ownedAgentFixture,
      windowsRecovery: options.windowsRecovery,
      notebook: options.notebook,
      ...(options.foreignProcess
        ? {
            beforeApply: async ({ invoke, page }) => {
              observation.foreignProcessRecovery = await certifyForeignProcessRecovery({
                invoke,
                acquireLock: async () => {
                  const { child } = await launchUninstallerLockHolder(
                    installDirectory,
                    env,
                    undefined,
                    undefined,
                    undefined,
                    'Read'
                  )
                  return { pid: child.pid, release: () => terminateProcessTree(child) }
                },
                onBlocked: async () => {
                  const dialog = page.getByTestId('runtime-update-dialog')
                  await expect(dialog).toContainText('Another app is using Open-Science files')
                  await expect(dialog).toContainText('Quit ')
                  await expect(dialog).toContainText('then recheck.')
                  await expect(
                    dialog.getByRole('button', { name: 'Cancel', exact: true })
                  ).toBeEnabled()
                  await expect(
                    dialog.getByRole('button', { name: 'Retry', exact: true })
                  ).toBeEnabled()
                  await page.screenshot({ path: `${options.output}.blocked.png` })
                }
              })
              if (observation.ownedProcessRecovery) {
                const { leaderPid, descendantPid } = observation.ownedProcessRecovery
                for (const pid of [leaderPid, descendantPid]) {
                  process.kill(pid, 0)
                  if (
                    observation.foreignProcessRecovery.some((entry) =>
                      entry.status.recovery?.blockingProcesses?.some((item) => item.pid === pid)
                    )
                  )
                    throw new Error('An application-owned process was reported as foreign.')
                }
              }
              await writeFile(options.output, `${JSON.stringify(observation, null, 2)}\n`)
            }
          }
        : {})
    })

    const installedExecutable = join(installDirectory, 'open-science.exe')
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
    if (options.coldLaunch) await waitForInstalledApplicationsToExit(installDirectory, env)
    else await terminateDirectoryProcesses(installDirectory)
    if (options.coldLaunch) {
      // The upgrade's nested uninstall must leave a future preparation for this installation.
      const nextVersion = currentVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1))
      const prepared = join(updaterCache, 'open-science-prepared')
      nextPreparation = await seedPreparedFixture(
        prepared,
        installedExecutable,
        nextVersion,
        basename(currentInstaller),
        'ready.json'
      )
      const { child } = await launchUninstallerLockHolder(
        installDirectory,
        env,
        undefined,
        undefined,
        undefined,
        'Read'
      )
      try {
        const heldStart = performance.now()
        successor.shortcutOccupancyScans = {
          held: await probeInstalledShortcut(installDirectory, env, previousVersion)
        }
        successor.shortcutOccupancyScans.stillHeld = await probeInstalledShortcut(
          installDirectory,
          env,
          previousVersion
        )
        if (
          !successor.shortcutOccupancyScans.held.length ||
          (performance.now() - heldStart < shortcutBlockerCacheMs &&
            successor.shortcutOccupancyScans.stillHeld.length)
        )
          throw new Error(
            'Expected one initial occupancy check and no rescan of the same live holder.'
          )
      } finally {
        await terminateProcessTree(child)
      }
      successor.shortcutOccupancyScans.released = await probeInstalledShortcut(
        installDirectory,
        env,
        currentVersion,
        { previousVersion, holderPid: child.pid, waitForRecheck: waitForShortcutRecheck }
      )
      if (!successor.shortcutOccupancyScans.released.length)
        throw new Error('The update must recheck occupancy after the holder exits.')
      successor.nextDeltaBasisSha512 = await verifyCachedInstaller(
        currentInstaller,
        cachedInstaller
      )
      successor.shortcutVersions = [previousVersion, currentVersion]
      const remaining = await readdir(prepared)
      if (remaining.length !== 1 || remaining[0] !== basename(nextPreparation))
        throw new Error('Expected only the future preparation to survive the upgrade.')
      await stat(join(nextPreparation, 'payload', 'sample'))
    }
    const currentConfigRoot = await launchAndProbe({
      installDirectory,
      expectedVersion: currentVersion,
      env,
      legacyConfigRoots: [previousConfigRoot]
    })
    await profileGuard.verifyCycle('current', currentConfigRoot)
    Object.assign(observation, successor)
    observation.installedVersionVerified = currentVersion
    if (options.rollback) {
      await installApplication(previousInstaller, installDirectory, env)
      if (profileGuard.shouldExpectDowngradeBlock()) {
        const record = await launchAndExpectDatabaseBlocked({
          installDirectory,
          env,
          configRoot: currentConfigRoot,
          expectedVersion: previousVersion
        })
        if (!record) throw new Error('Missing structured database block from the rollback launch.')
        observation.rollback = {
          version: previousVersion,
          code: record.data.code,
          runId: record.runId
        }
        await profileGuard.verifyCycle('rollback', currentConfigRoot)
      } else {
        const root = await launchAndProbe({
          installDirectory,
          env,
          expectedVersion: previousVersion,
          legacyConfigRoots
        })
        await profileGuard.verifyCycle('rollback', root)
        observation.rollback = { version: previousVersion, healthy: true }
      }
    }
    await writeFile(options.output, `${JSON.stringify(observation, null, 2)}\n`)
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
      console.error('Updater cleanup failed:', error)
    }
  }
  await cleanup(() => terminateDirectoryProcesses(installDirectory))
  await cleanup(async () => {
    const logDirectory = join(env.OPEN_SCIENCE_E2E_STORAGE_ROOT, 'logs')
    for (const name of await readdir(logDirectory).catch(() => [])) {
      if (name.endsWith('.log'))
        await copyFile(join(logDirectory, name), `${options.output}.${name}`)
    }
  })
  console.log('Updater cleanup: closing asset server.')
  if (assetServer) await cleanup(() => assetServer.close())
  console.log('Updater cleanup: asset server closed; cleaning profile and uninstalling.')
  await cleanup(() => profileGuard.cleanup(primaryError))
  // A completed update can retain an NSIS helper in the fixture Temp. It must release the
  // uninstaller mutex before starting the separate cleanup uninstall.
  await cleanup(() => terminateDirectoryProcesses(root))
  if (installed)
    await cleanup(async () => {
      // Surface the real uninstall guard's reason without leaving an unattended NSIS message box.
      // Compile the helper from the repository source so certification does not depend on a
      // pre-existing out/windows-installer directory or the caller's current working directory.
      const uninstallHelper = buildWindowsUninstallHelper(
        join(root, 'windows-uninstall-helper.exe')
      )
      await runProcess(uninstallHelper, ['update-handoff', '--install-path', installDirectory], {
        env
      })
      await uninstallAndVerify(installDirectory, env, { processRoot: root })
      if (nextPreparation) {
        await rejects(
          stat(nextPreparation),
          { code: 'ENOENT' },
          'Manual uninstall retained the prepared update.'
        )
      }
    })
  // NSIS can leave its Un_A helper in this fixture's Temp after the installation and uninstall
  // have finished. Reap only executables inside our owned root before removing their files.
  await cleanup(() => terminateDirectoryProcesses(root))
  console.log('Updater cleanup: removing fixture root.')
  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))
  if (primaryError) throw primaryError
  if (cleanupErrors[0]) throw cleanupErrors[0]
  console.log('Windows updater certification and cleanup completed.')
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
  certifyShortcutVersion,
  applyWithOccupancyRecheck,
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  buildWindowsUninstallHelper,
  classifyUpdaterDownloadStatus,
  certifyForeignProcessRecovery,
  invokeWebRpc,
  inspectUpdaterSuccessor,
  redactPackagedAppOutput,
  observeInstaller,
  parseArguments,
  parseSingleRange,
  rewriteFeedPaths,
  sha512Base64,
  verifyCachedInstaller,
  startAssetServer
}
