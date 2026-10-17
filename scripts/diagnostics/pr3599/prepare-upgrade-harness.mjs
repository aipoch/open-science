// Generate an instrumented copy of the candidate's existing real NSIS updater harness.
// Product binaries and the original harness remain unchanged. No preload or fake provider is added.
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const source = resolve(process.argv[2] || '.')
const original = join(source, 'scripts/windows-updater-certification.mjs')
let smoke = await readFile(join(source, 'scripts/windows-installer-smoke.mjs'), 'utf8')
const probeStart = smoke.indexOf('const launchAndProbe = async')
const probeEnd = smoke.indexOf('const assertDatabaseDowngradeBlocked =', probeStart)
if (probeStart < 0 || probeEnd < 0) throw new Error('Unexpected installed-app probe boundary')
let probe = smoke.slice(probeStart, probeEnd).replace('    await terminateProcessTree(child)', `    const records = await snapshotInstallation(installDirectory)
    let windows
    try { windows = await readRecordedWindows(records) } catch (error) { windows = { captureError: error.message } }
    await writeFile(join(process.env.PR3599_EVIDENCE_DIR, 'initial-startup-failure.json'), JSON.stringify({ error: error.message, records, windows }, null, 2))
    const cleanup = await waitForRecordedExit(records, { force: true, timeoutMs: 10000 })
    await writeFile(join(process.env.PR3599_EVIDENCE_DIR, 'initial-startup-forced-cleanup.json'), JSON.stringify(cleanup, null, 2))`)
const prepareBoundary = '    await requestPackagedAppShutdown(endpoint, auth)'
if (probe.split(prepareBoundary).length !== 2) throw new Error('Unexpected profile preparation boundary')
probe = probe.replace(prepareBoundary, () => `    if (expectedVersion === '1.0.0') {
      // Explicitly authorized fixture preparation; no provider and no update API calls.
      const prepared = await fetchWithTimeout(endpoint + '/rpc/settings%3Amark-onboarding-complete?' + auth, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: bootstrap.rpcProtocolVersion, args: [] })
      })
      const payload = await prepared.json()
      if (!prepared.ok || payload.ok !== true || !Number.isFinite(payload.result?.onboardingCompletedAt)) throw new Error('Synthetic profile preparation failed')
      await writeFile(join(process.env.PR3599_EVIDENCE_DIR, 'synthetic-profile-preparation.json'), JSON.stringify({
        command: 'settings:mark-onboarding-complete', configRoot, expectedVersion,
        onboardingCompletedAt: payload.result.onboardingCompletedAt, dataRoot: payload.result.dataRoot,
        userAuthorized: true, realModelConfigured: false, onboardingFlowValidated: false
      }, null, 2))
    }
    const probeProcesses = await snapshotInstallation(installDirectory)
    await requestPackagedAppShutdown(endpoint, auth)`)
probe = probe.replace('    if (verifyLedger)', `    await writeFile(join(process.env.PR3599_EVIDENCE_DIR, 'probe-normal-exit-' + expectedVersion + '.json'), JSON.stringify(await waitForRecordedExit(probeProcesses), null, 2))
    if (verifyLedger)`)
smoke = smoke.slice(0, probeStart) + probe + smoke.slice(probeEnd)
// A shutdown timeout remains a failure; the enclosing catch owns verified, recorded cleanup.
const shutdownCleanup = 'timeoutMs = SHUTDOWN_TIMEOUT_MS,\n  terminate = terminateProcessTree'
if (smoke.split(shutdownCleanup).length !== 2) throw new Error('Unexpected shutdown timeout cleanup boundary')
smoke = smoke.replace(shutdownCleanup, 'timeoutMs = SHUTDOWN_TIMEOUT_MS,\n  terminate = async () => undefined')
smoke = "import { snapshotInstallation, readRecordedWindows, waitForRecordedExit } from './pr3599-owned-processes.mjs'\n" + smoke
await writeFile(join(source, 'scripts/pr3599-installer-smoke.mjs'), smoke)
let text = await readFile(original, 'utf8')
const replace = (before, after) => {
  if (text.split(before).length !== 2) throw new Error(`Unexpected harness boundary: ${before.slice(0, 100)}`)
  text = text.replace(before, () => after)
}
replace("import { basename, join, resolve, win32 } from 'node:path'", "import { basename, dirname, join, resolve, win32 } from 'node:path'")
replace("import { randomUUID } from 'node:crypto'", "import { createHash, randomUUID } from 'node:crypto'")
replace("import { pathToFileURL } from 'node:url'", "import { fileURLToPath, pathToFileURL } from 'node:url'")
replace("from './windows-installer-smoke.mjs'", "from './pr3599-installer-smoke.mjs'")
replace("const child = spawn(executable, ['--open-science-headless', '--serve=0'], {\n    env,\n    windowsHide: true\n  })", "const child = spawn(executable, ['--serve=0'], {\n    env,\n    windowsHide: false\n  })")
replace('  cleanupSmokeRoot,', '')
replace('channel, fetchImpl = fetch }) => {', 'channel, args = [], fetchImpl = fetch }) => {')
replace('JSON.stringify({ protocolVersion, args: [] })', 'JSON.stringify({ protocolVersion, args })')
replace("const UPDATE_TIMEOUT_MS = 180_000", "import { snapshotInstallation, waitForRecordedExit, closeRecordedWindow, readRecordedWindows, operateRecordedButton, operateRecordedDraft } from './pr3599-owned-processes.mjs'\nconst UPDATE_TIMEOUT_MS = 180_000")
replace('    const checked = await withTimeout(', '    await seedUpgradeData({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable))\n    const checked = await withTimeout(')
replace('    await onDownloaded()', "    await onDownloaded()\n    if (process.env.PR3599_BASELINE === 'pr') await verifyOccupiedInstallation({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable), env)")
const checkStart = text.indexOf('    const checked = await withTimeout(')
const checkEnd = text.indexOf('    await onDownloaded()', checkStart)
if (checkStart < 0 || checkEnd < 0) throw new Error('Missing native update button boundary')
text = text.slice(0, checkStart) + `    await desktopButton(dirname(executable), 'open-update', '^New version: Update [(]v' + expectedVersion.replaceAll('.', '[.]') + '[)]$', true)
    await exerciseDownloadFaults({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable), expectedVersion)
    await desktopButton(dirname(executable), 'download-update', '^Download update(?: [(]|$)', true)
    await desktopButton(dirname(executable), 'download-ready', '^Restart to update$', false)
` + text.slice(checkEnd)
const applyStart = text.indexOf('    const applied = await invokeWebRpc(')
const applyEnd = text.indexOf('    const exitCode = await closed', applyStart)
if (applyStart < 0 || applyEnd < 0) throw new Error('Missing native apply button boundary')
text = text.slice(0, applyStart) + `    const mainIdentity = ownedBeforeUpdate.find((record) => record.pid === child.pid)
    if (!mainIdentity) throw new Error('Cannot identify the update window owner')
    windowObservation = await observeUpdateWindow(mainIdentity)
    await evidence('apply-requested-at', { at: new Date().toISOString(), source: 'actual accessibility button' })
    await desktopButton(dirname(executable), 'apply-update', '^Restart to update$', true)
` + text.slice(applyEnd)
replace('  let installerExit', '  let installerExit\n  let windowObservation')
replace("[Console]::Out.WriteLine('OPEN_SCIENCE_INSTALLER_OBSERVER_ACQUIRED')", "[Console]::Out.WriteLine('OPEN_SCIENCE_INSTALLER_OBSERVER_ACQUIRED'); [Console]::Out.WriteLine(('PR3599_INSTALLER_STARTED ' + $candidate.CreationDate.ToUniversalTime().ToString('o')))")
replace("$target = [IO.Path]::GetFullPath($env:OPEN_SCIENCE_INSTALLER_WATCH_TARGET)", "Add-Type -AssemblyName UIAutomationClient\n$target = [IO.Path]::GetFullPath($env:OPEN_SCIENCE_INSTALLER_WATCH_TARGET)")
replace('$wait = [OpenScienceProcessObserver]::WaitForSingleObject($handle, 300000)', String.raw`
$uiFile = Join-Path $env:PR3599_EVIDENCE_DIR 'installer-window-timeline.jsonl'
$uiWriter = [IO.StreamWriter]::new($uiFile,$false,[Text.UTF8Encoding]::new($false))
$uiWriter.AutoFlush = $true
$installDeadline = [DateTime]::UtcNow.AddMilliseconds(300000)
try {
  do {
    $sample = @{at=[DateTime]::UtcNow.ToString('o');rootPid=$candidate.ProcessId;windows=@();processes=@()}
    try {
      $all = @(Get-CimInstance Win32_Process)
      $owned = @($all | Where-Object { $_.ProcessId -eq $candidate.ProcessId -and $_.CreationDate -eq $candidate.CreationDate })
      do {
        $before = $owned.Count
        $parents = @($owned.ProcessId)
        $owned += @($all | Where-Object { $_.ParentProcessId -in $parents -and $_.ProcessId -notin $parents -and $_.CreationDate -ge $candidate.CreationDate })
      } while ($owned.Count -gt $before)
      $sample.processes = @($owned | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;path=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o')} })
      foreach ($record in $owned) {
        $process = $null
        try {
          $process = [Diagnostics.Process]::GetProcessById($record.ProcessId)
          if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            $texts = @($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object { if (-not $_.Current.IsOffscreen) { $_.Current.Name } })
            $sample.windows += @{pid=$record.ProcessId;title=$window.Current.Name;offscreen=$window.Current.IsOffscreen;text=$texts}
          }
        } catch { $sample.windows += @{pid=$record.ProcessId;observerError=$_.Exception.Message} }
        finally { if ($process) { $process.Dispose() } }
      }
    } catch { $sample.observerError = $_.Exception.Message }
    $sample.rootAlive = ([OpenScienceProcessObserver]::WaitForSingleObject($handle, 0) -eq 0x00000102)
    $uiWriter.WriteLine(($sample | ConvertTo-Json -Depth 7 -Compress))
    $wait = [OpenScienceProcessObserver]::WaitForSingleObject($handle, 500)
  } while ($wait -eq 0x00000102 -and [DateTime]::UtcNow -lt $installDeadline)
} finally { $uiWriter.Dispose() }
`)
replace('[Console]::Out.Write("installer pid=$($candidate.ProcessId) exit=$exitCode")', "[Console]::Out.WriteLine(('PR3599_INSTALLER_EXITED ' + [DateTime]::UtcNow.ToString('o'))); [Console]::Out.Write(\"installer pid=$($candidate.ProcessId) exit=$exitCode\")")
replace('    console.log(`Updater installer observation:', `    await evidence('installer-result', installerResult)
    if (windowObservation) await windowObservation.completion
    await evidence('persistence-order', inspectPersistenceOrder(stdout))
    console.log(\`Updater installer observation:`)
replace("  const profileDirectory = join(root, 'profile')", '  const profileDirectory = process.env.USERPROFILE')
replace('  const env = windowsProfileEnvironment(profileDirectory)', "  const env = { ...process.env, OPEN_SCIENCE_WEB_PORT: '0' }\n  await writeFile(options.output + '.root.json', JSON.stringify({ root, installDirectory, profileDirectory, independentHarnessPid: process.pid, independentHarnessExecutable: process.execPath }, null, 2))")
replace('    const closed = waitForShutdownExit(exit, child, diagnosticOutput)', "    const ownedBeforeUpdate = await snapshotInstallation(dirname(executable))\n    rememberedProcesses.push(...ownedBeforeUpdate)\n    await evidence('old-processes-before-update', ownedBeforeUpdate)\n    const closed = waitForShutdownExit(exit, child, diagnosticOutput)")
replace('    const installerResult = await installerExit', "    await evidence('old-app-output', { pid: child.pid, stdout: redactPackagedAppOutput(stdout), stderr: redactPackagedAppOutput(stderr), exitCode })\n    await evidence('old-processes-normal-exit', await waitForRecordedExit(ownedBeforeUpdate))\n    const installerResult = await installerExit")
replace('    installerObserver.abort(', "    await evidence('old-app-failure-output', { pid: child.pid, stdout: redactPackagedAppOutput(stdout), stderr: redactPackagedAppOutput(stderr), error: error.message })\n    installerObserver.abort(")
replace('    await Promise.all([terminateProcessTree(child), installerExit?.catch(() => undefined)])', `    const failedProcesses = await snapshotInstallation(dirname(executable))
    await evidence('update-failure-processes', failedProcesses)
    await evidence('update-failure-windows', await readRecordedWindows(failedProcesses).catch((error) => ({ error: error.message })))
    await evidence('update-failure-forced-cleanup', await waitForRecordedExit(failedProcesses, { force: true, timeoutMs: 10000 }))
    if (installerExit) await evidence('installer-observer-after-failure', await installerExit.then((result) => result, (error) => ({ error: error.message })))`)
replace("    await runProcess('taskkill.exe', ['/IM', 'open-science.exe', '/T', '/F'], {\n      allowNonZero: true,\n      env,\n      timeoutMs: 10_000\n    })", '    await verifyAndStopSuccessor(installDirectory, previousConfigRoot, currentVersion)\n    await verifyNormalReopen(installDirectory, previousConfigRoot, currentVersion, env)\n    await verifyUpdateObservations()')
replace("  await cleanup(() =>\n    runProcess('taskkill.exe', ['/IM', 'open-science.exe', '/T', '/F'], {\n      allowNonZero: true,\n      env,\n      timeoutMs: 10_000\n    })\n  )", `  await cleanup(async () => {
    const residual = await snapshotInstallation(installDirectory)
    await evidence('processes-before-cleanup', residual)
    if (!primaryError && residual.length) throw new Error('Normal completion left installation processes alive')
    if (primaryError) {
      const identities = [...new Map([...rememberedProcesses, ...residual].map((p) => [p.pid + ':' + p.started, p])).values()]
      await evidence('failure-only-forced-cleanup', await waitForRecordedExit(identities, { force: true, timeoutMs: 10000 }))
    }
    const after = await snapshotInstallation(installDirectory)
    await evidence('processes-after-cleanup', after)
    if (after.length) throw new Error('Owned installation processes remain after cleanup')
  })`)
replace('  await cleanup(() => profileGuard.cleanup(primaryError))', '  if (!primaryError) await cleanup(() => profileGuard.cleanup(primaryError))')
replace('  if (installed) await cleanup(() => uninstallAndVerify(installDirectory, env))', "  await evidence('retained-installation', { installDirectory, installed, reason: 'Upgrade acceptance retains the isolated installation for inspection; standalone AppContainer uninstall requires separate interactive elevation acceptance.', standaloneUninstallAttempted: false })")
replace('  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))', "  await evidence('final-state', { root, independentHarnessPid: process.pid, primaryError: primaryError?.message, cleanupErrors: cleanupErrors.map((e) => e.message), processes: await snapshotInstallation(installDirectory), directoryRetained: true })")
replace('      const path = byRoute.get(pathname)', "      if (pathname === currentInstallerRoute && request.method !== 'HEAD' && downloadFault.mode !== 'none') {\n        const mode = downloadFault.mode\n        const event = { mode, pathname, range: request.headers.range, at: new Date().toISOString(), closed: false }\n        downloadFault.events.push(event)\n        response.once('close', () => { event.closed = true; downloadFault.held.delete(response) })\n        if (mode === 'http503') { response.writeHead(503, { 'Content-Type': 'text/plain' }).end('PR3599 isolated download failure'); return }\n        const file = byRoute.get(pathname)\n        const size = (await stat(file)).size\n        if (mode === 'hold') {\n          downloadFault.held.add(response)\n          response.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })\n          response.flushHeaders()\n          return\n        }\n        if (mode !== 'corrupt') throw new Error('Unknown controlled download fault')\n        const range = request.headers.range ? parseSingleRange(request.headers.range, size) : undefined\n        const start = range?.start ?? 0, end = range?.end ?? size - 1\n        response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {}) })\n        const { Transform } = await import('node:stream')\n        let changed = false\n        const corruption = new Transform({ transform(chunk, encoding, callback) {\n          if (!changed && chunk.length) { chunk = Buffer.from(chunk); chunk[0] ^= 1; changed = true }\n          callback(null, chunk)\n        } })\n        const stream = createReadStream(file, { start, end })\n        response.once('close', () => stream.destroy())\n        stream.pipe(corruption).pipe(response)\n        return\n      }\n      const path = byRoute.get(pathname)")
const helpers = String.raw`

const downloadFault = { mode: 'none', held: new Set(), events: [] }
async function exerciseDownloadFaults(connection, installDirectory, expectedVersion) {
  const appPath = join(installDirectory, 'resources/app.asar')
  const before = createHash('sha256').update(await readFile(appPath)).digest('hex')
  const stillUsable = async (phase) => {
    const response = await fetchWithTimeout(connection.endpoint + '/api/bootstrap?' + connection.auth)
    if (!response.ok) throw new Error('Backend unavailable after ' + phase)
    const after = createHash('sha256').update(await readFile(appPath)).digest('hex')
    if (after !== before) throw new Error('Installation changed during ' + phase)
    const processes = await snapshotInstallation(installDirectory)
    if (!processes.some(p => p.pid === seededData.mcp.pid)) throw new Error('MCP exited during ' + phase)
    await evidence('download-fault-' + phase, { before, after, backendStatus: response.status, mcpPid: seededData.mcp.pid, processes, events: downloadFault.events })
  }
  downloadFault.mode = 'hold'
  await desktopButton(installDirectory, 'cancel-download-start', '^Download update(?: [(]|$)', true)
  await waitFor('an actual held installer HTTP request', async () => downloadFault.held.size > 0 || undefined, UPDATE_TIMEOUT_MS)
  await desktopButton(installDirectory, 'cancel-download', '^Cancel$', true)
  await waitFor('all cancelled installer HTTP requests to close', async () => downloadFault.held.size === 0 || undefined, UPDATE_TIMEOUT_MS)
  await stillUsable('cancelled')
  downloadFault.mode = 'http503'
  await desktopButton(installDirectory, 'reopen-after-download-cancel', '^New version: Update [(]v' + expectedVersion.replaceAll('.', '[.]') + '[)]$', true)
  for (const mode of ['http503', 'corrupt']) {
    downloadFault.mode = mode
    await desktopButton(installDirectory, mode + '-download-start', '^Download update(?: [(]|$)', true)
    const pattern = mode === 'http503' ? /503/ : /sha512|checksum/i
    const windows = await waitFor('the actual ' + mode + ' download rejection', async () => {
      const windows = await readRecordedWindows(await snapshotInstallation(installDirectory))
      await evidence('download-fault-' + mode + '-windows', windows)
      if (windows.some(window => window.text.some(text => pattern.test(text)))) return windows
    }, UPDATE_TIMEOUT_MS)
    await desktopButton(installDirectory, mode + '-retry-enabled', '^Download update(?: [(]|$)', false)
    if (!downloadFault.events.some(event => event.mode === mode)) throw new Error('No actual HTTP fault request observed')
    await stillUsable(mode)
  }
  downloadFault.mode = 'none'
  await evidence('download-fault-sequence', { events: downloadFault.events, finalMode: downloadFault.mode, goodTransferMetricsScope: 'Final successful download only; fault requests retained separately above' })
}

const rememberedProcesses = []
let seededData
const composerDraft = { marker: 'PR3599 unsent draft must survive signed update', seed: null, restored: [] }
async function seedComposerDraft(installDirectory) {
  try {
    await desktopButton(installDirectory, 'open-project-for-draft', '^PR3599 upgrade preservation$', true)
    const written = await waitFor('the real editable composer', async () => {
      const read = await operateRecordedDraft(await snapshotInstallation(installDirectory))
      if (!read.found) return
      return operateRecordedDraft(await snapshotInstallation(installDirectory), composerDraft.marker)
    }, 30000)
    await evidence('composer-draft-immediate-write-result', written)
    const result = await waitFor('the actual composer text after input settles', async () => {
      const read = await operateRecordedDraft(await snapshotInstallation(installDirectory))
      await evidence('composer-draft-settle-read', read)
      return read.text?.replace(/[\r\n]+$/, '') === composerDraft.marker ? read : undefined
    }, 30000)
    composerDraft.seed = { status: 'PASS', written, result }
  } catch (error) {
    composerDraft.seed = { status: 'BLOCKED', error: error.message, windows: await readRecordedWindows(await snapshotInstallation(installDirectory)) }
  }
  await evidence('composer-draft-seed', composerDraft)
}
async function inspectRestoredDraft(installDirectory, prefix) {
  if (composerDraft.seed?.status !== 'PASS') return
  try {
    let result = await operateRecordedDraft(await snapshotInstallation(installDirectory))
    if (!result.found) {
      await desktopButton(installDirectory, prefix + 'open-project-for-restored-draft', '^PR3599 upgrade preservation$', true)
      result = await waitFor('the restored composer', async () => {
        const read = await operateRecordedDraft(await snapshotInstallation(installDirectory))
        return read.found ? read : undefined
      }, 30000)
    }
    composerDraft.restored.push({ prefix, status: result.text?.replace(/[\r\n]+$/, '') === composerDraft.marker ? 'PASS' : 'FAIL', result })
  } catch (error) { composerDraft.restored.push({ prefix, status: 'BLOCKED', error: error.message }) }
  await evidence('composer-draft-restoration', composerDraft)
}
async function observeUpdateWindow(record) {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'pr3599-observe-update-window.ps1')
  const output = join(process.env.PR3599_EVIDENCE_DIR, 'update-window-timeline.jsonl')
  const observer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-TargetPid', String(record.pid), '-Started', record.started, '-Output', output], { windowsHide: true })
  let stdout = '', stderr = ''
  const ready = Promise.withResolvers()
  observer.stdout.setEncoding('utf8'); observer.stderr.setEncoding('utf8')
  observer.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('PR3599_WINDOW_OBSERVER_READY')) ready.resolve() })
  observer.stderr.on('data', (chunk) => { stderr += chunk })
  const completion = new Promise((resolve, reject) => {
    observer.once('error', reject)
    observer.once('close', (code) => {
      const result = { code, stdout, stderr, output }
      evidence('window-observer-result', result).then(() => {
        if (code !== 0) reject(new Error('Update window observer failed: ' + stderr))
        else resolve(result)
      }, reject)
    })
  })
  void completion.catch((error) => ready.reject(error))
  await withTimeout(ready.promise, 'read-only window observer readiness', 15000)
  // Return a wrapper so async promise assimilation does not await application exit here.
  return { completion }
}
function inspectPersistenceOrder(stdout) {
  const preflight = stdout.indexOf("update renderer persistence { phase: 'preflight', outcome: 'completed' }")
  const final = stdout.indexOf("update renderer persistence { phase: 'final', outcome: 'completed' }")
  const stop = stdout.indexOf('[desktop-runtime-client] runtime-stop')
  return { preflight, final, stop, status: preflight >= 0 && final > preflight && stop > final ? 'PASS' : 'FAIL', source: 'actual signed Electron stdout; offsets preserve emitted order' }
}
async function verifyUpdateObservations() {
  const directory = process.env.PR3599_EVIDENCE_DIR
  const timeline = (await readFile(join(directory, 'update-window-timeline.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  const samples = timeline.filter((event) => event.event === 'sample')
  const visible = samples.flatMap((sample) => sample.controls.filter((control) => !control.offscreen).map((control) => ({ at: sample.at, name: control.name })))
  const errors = visible.filter((control) => /Desktop connection lost|Check failed/i.test(control.name))
  const progress = visible.filter((control) => /Preparing update|Stopping the service|Preparing installation|Installing update/i.test(control.name))
  const observerErrors = samples.filter((sample) => sample.observerError && !sample.processExited)
  const missingWindow = samples.filter((sample) => !sample.windowPresent && !sample.processExited)
  const persistence = JSON.parse(await readFile(join(directory, 'persistence-order.json'), 'utf8'))
  const installerTimeline = (await readFile(join(directory, 'installer-window-timeline.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse).filter((sample) => sample.rootAlive)
  const installerWindows = installerTimeline.filter((sample) => sample.windows.some((window) => window.title && !window.offscreen))
  const installerErrors = installerTimeline.filter((sample) => sample.observerError || sample.windows.some((window) => window.observerError))
  const installerUi = { status: installerErrors.length ? 'BLOCKED' : installerWindows.length === installerTimeline.length && installerTimeline.length ? 'PASS' : 'FAIL', sampleCount: installerTimeline.length, visibleSampleCount: installerWindows.length, errors: installerErrors, source: 'actual installer PID and descendants; no synthetic window' }
  const result = {
    status: errors.length || observerErrors.length || persistence.status !== 'PASS' || composerDraft.restored.some((draft) => draft.status === 'FAIL') || installerUi.status === 'FAIL' ? 'FAIL' : progress.length ? 'PASS' : 'BLOCKED',
    sampleCount: samples.length, progress, errors, observerErrors, missingWindow, persistence,
    scope: '100ms requested accessibility sampling until the original signed Electron process exits; raw timestamps include actual sampling gaps. Installer UI after handoff is not observed.',
    continuousInstallationUi: installerUi,
    composerDraft,
    authorizationTiming: 'No interactive elevation was requested for this per-user update; installer process timestamps are recorded separately'
  }
  await evidence('additional-update-observations', result)
  if (result.status === 'FAIL') throw new Error('Signed update observation failed; see additional-update-observations.json')
}
async function desktopButton(installDirectory, step, pattern, invoke) {
  const outcome = await waitFor('the actual product button: ' + step, async () => {
    let result
    try { result = await operateRecordedButton(await snapshotInstallation(installDirectory), pattern, invoke) }
    catch (error) {
      // A lost action acknowledgement must fail, not blindly invoke a possibly completed action again.
      await evidence('ui-' + step + '-driver-error', { error: error.message })
      return { driverError: error }
    }
    await evidence('ui-' + step, result)
    if (result.matched && (!invoke || result.invoked)) return result
  }, UPDATE_TIMEOUT_MS)
  if (outcome.driverError) throw outcome.driverError
  return outcome
}
async function verifyOccupiedInstallation(connection, installDirectory, env) {
  const executable = join(installDirectory, 'resources/node-runtime/node.exe')
  const blocker = spawn(executable, ['-e', 'process.stdin.once("data",()=>process.exit(0));console.log("owned-lock-ready")'], { env, windowsHide: true })
  const exited = new Promise((resolve, reject) => { blocker.once('exit', resolve); blocker.once('error', reject) })
  try {
    await withTimeout(new Promise((resolve, reject) => { blocker.stdout.once('data', resolve); blocker.once('error', reject) }), 'owned installation lock readiness', 15000)
    const records = await snapshotInstallation(installDirectory)
    rememberedProcesses.push(...records)
    const before = createHash('sha256').update(await readFile(join(installDirectory, 'resources/app.asar'))).digest('hex')
    await desktopButton(installDirectory, 'occupied-apply', '^Restart to update$', true)
    const rejection = await waitFor('the real occupied-installation error in the product', async () => {
      const windows = await readRecordedWindows(await snapshotInstallation(installDirectory))
      await evidence('occupied-installation-windows', windows)
      if (windows.some((window) => window.text.includes('Application files are in use') && window.text.includes('Stop the other service from the app or terminal that started it, then recheck.'))) return windows
    }, UPDATE_TIMEOUT_MS)
    const after = createHash('sha256').update(await readFile(join(installDirectory, 'resources/app.asar'))).digest('hex')
    if (before !== after) throw new Error('The occupied installation was modified')
    await evidence('occupied-installation-blocked', { blockerPid: blocker.pid, processes: records, rejection, before, after })
    if (blocker.exitCode !== null) throw new Error('Product terminated the independent installation occupant')
    const response = await fetchWithTimeout(connection.endpoint + '/api/bootstrap?' + connection.auth)
    if (!response.ok) throw new Error('Product became unavailable after refusing occupied installation')
  } finally {
    blocker.stdin.end('release\n')
    const code = await withTimeout(exited, 'owned lock fixture normal exit', 15000)
    await evidence('occupied-installation-release', { pid: blocker.pid, exitCode: code, forced: false })
    if (code !== 0) throw new Error('Installation lock fixture did not exit normally')
  }
  await desktopButton(installDirectory, 'occupied-recheck', '^Retry$', true)
  await desktopButton(installDirectory, 'occupied-retry-ready', '^Restart to update$', false)
}
async function seedUpgradeData(connection, installDirectory) {
  const rpc = (channel, ...args) => invokeWebRpc({ ...connection, channel, args })
  const windows = await waitFor('the actual pre-upgrade product window', async () => {
    const records = await snapshotInstallation(installDirectory)
    const found = await readRecordedWindows(records)
    if (found.length) return found
  }, UPDATE_TIMEOUT_MS)
  await evidence('pre-upgrade-windows', windows)
  const project = await rpc('projects:create', { name: 'PR3599 upgrade preservation', description: 'Synthetic upgrade data; no user content' })
  const now = Date.now()
  const session = {
    id: randomUUID(), projectId: project.id, title: 'Synthetic upgrade transcript',
    cwd: process.env.PR3599_EVIDENCE_DIR, status: 'idle', createdAt: now, updatedAt: now,
    messages: [{ id: randomUUID(), role: 'user', content: 'Synthetic persistence marker: no model request.', status: 'complete', eventIds: [] }]
  }
  await rpc('sessions:save-session', session)
  const loaded = await rpc('sessions:load-one', { projectId: project.id, sessionId: session.id })
  if (loaded?.messages?.[0]?.content !== session.messages[0].content) throw new Error('Initial synthetic session was not persisted')
  await rpc('settings:set-close-preference', { preference: 'quit' })
  const credential = await rpc('settings:create-device-credential', { displayName: 'PR3599 synthetic MCP', kind: 'token', secret: 'synthetic-pr3599-no-access' })
  if (!credential.createdCredential?.id || !project.id) throw new Error('Could not seed actual product data')
  const marker = join(process.env.PR3599_EVIDENCE_DIR, 'mcp-lifecycle.jsonl')
  const fixture = join(process.env.PR3599_EVIDENCE_DIR, 'product-local-mcp.cjs')
  await rpc('settings:add-custom-server', { id: 'pr3599-upgrade', name: 'pr3599-upgrade', displayName: 'PR3599 local upgrade MCP', transport: 'stdio', command: process.execPath, args: [fixture, marker], envCredentialIds: { PR3599_TEST_SECRET: credential.createdCredential.id } })
  await rpc('settings:set-custom-server-enabled', { id: 'pr3599-upgrade', enabled: true })
  await rpc('settings:retry-custom-server', { id: 'pr3599-upgrade' })
  const mcp = await waitFor('the real pre-upgrade MCP with its synthetic credential', async () => {
    const events = (await readFile(marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    const started = events.filter((event) => event.event === 'started').at(-1)
    const processes = await snapshotInstallation(installDirectory)
    if (started?.credentialMatched && processes.some((p) => p.pid === started.pid)) return started
  }, UPDATE_TIMEOUT_MS)
  seededData = { project, session, credentialId: credential.createdCredential.id, marker, mcp, mcpCommand: process.execPath, diagnosticFixture: "independent-node" }
  await evidence('seeded-product-data', seededData)
  await seedComposerDraft(installDirectory)
}
async function evidence(name, value) {
  const directory = process.env.PR3599_EVIDENCE_DIR
  if (!directory) throw new Error('Missing PR3599_EVIDENCE_DIR')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2))
}
async function verifyAndStopSuccessor(installDirectory, configRoot, expectedVersion, prefix = '') {
  const writePhaseEvidence = (name, value) => evidence(prefix + name, value)
  const ready = await waitFor('the actual automatically launched updated application', async () => {
    const state = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
    if (state.appVersion !== expectedVersion || resolve(state.configRoot).toLowerCase() !== resolve(configRoot).toLowerCase()) return
    const processes = await snapshotInstallation(installDirectory)
    if (!processes.some((p) => p.pid === state.pid)) return
    if (state.attached) throw new Error('Cannot certify shutdown of an attached web service')
    const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
    if (token.length < 32) throw new Error('Missing successor authentication token')
    const endpoint = 'http://127.0.0.1:' + state.port
    const auth = 'token=' + encodeURIComponent(token)
    const response = await fetchWithTimeout(endpoint + '/api/bootstrap?' + auth)
    if (!response.ok) throw new Error('Successor bootstrap returned ' + response.status)
    const bootstrap = await response.json()
    if (bootstrap.appVersion !== expectedVersion) throw new Error('Successor version mismatch')
    return { state, processes, endpoint, auth, bootstrap }
  }, UPDATE_TIMEOUT_MS)
  rememberedProcesses.push(...ready.processes)
  await writePhaseEvidence('automatic-successor-ready', { state: ready.state, processes: ready.processes, version: ready.bootstrap.appVersion, platform: ready.bootstrap.platform })
  const hashes = {}
  for (const relative of ['open-science.exe', 'resources/node-runtime/node.exe', 'resources/app.asar']) {
    hashes[relative] = createHash('sha256').update(await readFile(join(installDirectory, relative))).digest('hex')
  }
  await writePhaseEvidence('installed-candidate-hashes', hashes)
  const rpc = (channel, ...args) => invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel, args })
  const project = await rpc('projects:get', seededData.project.id)
  if (project?.name !== seededData.project.name || project?.description !== seededData.project.description) throw new Error('Upgrade did not preserve the project')
  const session = await rpc('sessions:load-one', { projectId: project.id, sessionId: seededData.session.id })
  if (session?.title !== seededData.session.title || session?.messages?.[0]?.content !== seededData.session.messages[0].content) throw new Error('Upgrade did not preserve the synthetic session transcript')
  const settings = await rpc('settings:get-settings')
  if (settings.closePreference !== 'quit') throw new Error('Upgrade did not preserve the close preference')
  if (!Number.isFinite(settings.onboardingCompletedAt)) throw new Error('Upgrade lost the prepared profile setup marker')
  await rpc('settings:retry-custom-server', { id: 'pr3599-upgrade' })
  const reconnected = await waitFor('the updated MCP resolving the preserved synthetic credential', async () => {
    const events = (await readFile(seededData.marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    const latest = events.filter((event) => event.event === 'started').at(-1)
    const processes = await snapshotInstallation(installDirectory)
    if (latest?.pid !== seededData.mcp.pid && latest?.credentialMatched && processes.some((p) => p.pid === latest.pid)) return { latest, processes }
  }, UPDATE_TIMEOUT_MS)
  ready.processes = reconnected.processes
  rememberedProcesses.push(...ready.processes)
  await writePhaseEvidence('preserved-project-and-credential', { project, session, credentialId: seededData.credentialId, mcp: reconnected.latest })
  await inspectRestoredDraft(installDirectory, prefix)
  await invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel: 'settings:set-close-preference', args: [{ preference: 'quit' }] })
  const closeRequest = await waitFor('the updated product window to accept normal close', () => closeRecordedWindow(ready.processes), UPDATE_TIMEOUT_MS)
  await writePhaseEvidence('automatic-successor-close-request', closeRequest)
  await writePhaseEvidence('automatic-successor-normal-exit', await waitForRecordedExit(ready.processes))
  const remaining = (await readdir(configRoot)).filter((name) => name.startsWith('.credential-inventory-') && name.endsWith('.json'))
  await writePhaseEvidence('credential-handoff-after-normal-exit', { configRoot, remaining })
  if (remaining.length) throw new Error('Normal exit retained credential handoff snapshots')
}
async function verifyNormalReopen(installDirectory, configRoot, expectedVersion, env) {
  const executable = join(installDirectory, 'open-science.exe')
  const child = spawn(executable, ['--serve=0'], { env, windowsHide: false })
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  void exited.catch(() => undefined) // Observe early spawn errors; the awaited promise below still rejects.
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  await evidence('normal-reopen-launch', { executable, args: ['--serve=0'], pid: child.pid, expectedVersion, configRoot, testPreload: false })
  try {
    await verifyAndStopSuccessor(installDirectory, configRoot, expectedVersion, 'reopened-')
    const exitCode = await withTimeout(exited, 'normally reopened desktop exit', 60000)
    await evidence('normal-reopen-exit', { pid: child.pid, exitCode, forced: false, stdout: redactPackagedAppOutput(stdout), stderr: redactPackagedAppOutput(stderr) })
    if (exitCode !== 0) throw new Error('Reopened desktop exited abnormally')
  } catch (error) {
    await evidence('normal-reopen-failure', { pid: child.pid, error: error.message, stdout: redactPackagedAppOutput(stdout), stderr: redactPackagedAppOutput(stderr) })
    throw error
  }
}

`
replace('const invokedAsScript =', helpers + '\nconst invokedAsScript =')
if (text.includes("'/IM'")) throw new Error('Global image-name termination remains')
await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'owned-processes.mjs'), join(source, 'scripts/pr3599-owned-processes.mjs'))
await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'observe-update-window.ps1'), join(source, 'scripts/pr3599-observe-update-window.ps1'))
await writeFile(join(source, 'scripts/pr3599-upgrade-certification.mjs'), text)
console.log('Prepared candidate-bound upgrade harness with scoped cleanup and normal successor shutdown.')


