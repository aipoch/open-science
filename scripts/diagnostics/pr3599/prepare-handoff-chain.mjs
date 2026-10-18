// Extend the existing real signed-product harness; never patch application binaries.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = resolve(process.argv[2] || '.')
execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-upgrade-harness.mjs', import.meta.url)), source], { stdio: 'inherit' })
const target = join(source, 'scripts/pr3599-upgrade-certification.mjs')
let text = await readFile(target, 'utf8')
const replace = (before, after) => {
  if (text.split(before).length !== 2) throw new Error('Unexpected chain harness boundary: ' + before.slice(0, 100))
  text = text.replace(before, () => after)
}
replace('const main = async () => {', 'const runTransition = async (options, reuseRoot) => {')
replace("import { snapshotInstallation, waitForRecordedExit,", "import { sameRecordedProcess, snapshotInstallation, waitForRecordedExit,")
replace("    windowObservation = await observeUpdateWindow(mainIdentity)", "    activeOwnerIdentity = mainIdentity\n    windowObservation = await observeUpdateWindow(mainIdentity)")
replace('  const options = parseArguments(process.argv.slice(2))\n', '')
replace("  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))", "  const root = reuseRoot ?? await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))\n  chainRoot = root")
replace("  const env = { ...process.env, OPEN_SCIENCE_WEB_PORT: '0' }", "  const env = { ...process.env, OPEN_SCIENCE_WEB_PORT: '0', OPEN_SCIENCE_CONFIG_ROOT: join(root, 'synthetic-config'), OPEN_SCIENCE_USER_DATA: join(root, 'synthetic-profile') }\n  chainEnvironment = env")
replace('    const previousConfigRoot = await installAndProbe({', "    const previousConfigRoot = reuseRoot ? await launchAndProbe({ installDirectory, expectedVersion: previousVersion, env, legacyConfigRoots }) : await installAndProbe({")
replace('  const legacyConfigRoots = [', '  const legacyConfigRoots = [\n    env.OPEN_SCIENCE_CONFIG_ROOT,')
replace("    await seedUpgradeData({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable))", "    await verifyInstalledSignatures(dirname(executable), 'before-update')\n    await seedUpgradeData({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable))")
replace("  await writePhaseEvidence('installed-candidate-hashes', hashes)", "  await writePhaseEvidence('installed-candidate-hashes', hashes)\n  await verifyInstalledSignatures(installDirectory, prefix + 'successor')")
replace("  return { preflight, final, stop, status: preflight >= 0 && final > preflight && stop > final ? 'PASS' : 'FAIL', source: 'actual signed Electron stdout; offsets preserve emitted order' }", "  const helperReady = stdout.indexOf('Windows update progress window ready')\n  return { preflight, final, stop, helperReady, status: preflight >= 0 && final > preflight && stop > final && helperReady >= 0 && stop > helperReady ? 'PASS' : 'FAIL', source: 'actual signed Electron stdout; persistence and helper visible acknowledgement must precede backend stop' }")
replace("    await desktopButton(dirname(executable), 'apply-update', '^Restart to update$', true)", "    const beforeOperation = await listOperationIds()\n    await desktopButton(dirname(executable), 'apply-update', '^Restart to update$', true)\n    activeOperation = await captureOperation(beforeOperation, child.pid, expectedVersion, executable, configRoots[0])")
replace("  const rpc = (channel, ...args) => invokeWebRpc({ ...connection, channel, args })\n  const windows", "  const rpc = (channel, ...args) => invokeWebRpc({ ...connection, channel, args })\n  if (seededData) {\n    const project = await rpc('projects:get', seededData.project.id)\n    const session = await rpc('sessions:load-one', { projectId: project.id, sessionId: seededData.session.id })\n    if (project.name !== seededData.project.name || session.messages[0].content !== seededData.session.messages[0].content) throw new Error('First-round data was lost before the second upgrade')\n    await rpc('settings:retry-custom-server', { id: 'pr3599-upgrade' })\n    seededData.mcp = await readLiveCredentialMcp(installDirectory)\n    composerDraft.restored = []\n    await inspectRestoredDraft(installDirectory, 'before-second-upgrade-')\n    await evidence('same-data-before-second-upgrade', seededData)\n    return\n  }\n  const windows")
replace('  await inspectRestoredDraft(installDirectory, prefix)', "  seededData.mcp = reconnected.latest\n  if (!prefix) await verifyOperationReceipts(installDirectory, configRoot, expectedVersion)\n  await inspectRestoredDraft(installDirectory, prefix)")
replace("  await invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel: 'settings:set-close-preference'", "  if (!prefix && expectedVersion === '1.0.2') {\n    await verifyMigrationRelaunch(ready, installDirectory, configRoot, expectedVersion)\n    return\n  }\n  await invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel: 'settings:set-close-preference'")
const extra = String.raw`
let chainRoot
let chainEnvironment
let activeOperation
let activeHelperIdentity
let activeOwnerIdentity
const confirmedOperations = []
const operationRoot = () => join(process.env.APPDATA, 'Open-Science', 'UpdateHandoffs')
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
async function verifyInstalledSignatures(installDirectory, phase) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    "$records = foreach($file in ($env:OPEN_SCIENCE_SIGNATURE_FILES | ConvertFrom-Json)) {",
    "$signature = Get-AuthenticodeSignature -LiteralPath $file.path",
    "if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch $file.publisher) { throw ('Installed executable signature mismatch: ' + $file.path) }",
    "@{path=$file.path;sha256=(Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash;status=$signature.Status.ToString();publisher=$signature.SignerCertificate.Subject}",
    "}",
    "ConvertTo-Json -InputObject @($records) -Compress"
  ].join('\n')
  const files = [
    { path: join(installDirectory, 'open-science.exe'), publisher: 'CN=AIPOCH PTE[.] LTD[.]' },
    { path: join(installDirectory, 'resources/open-science-update-progress.exe'), publisher: 'CN=AIPOCH PTE[.] LTD[.]' },
    { path: join(installDirectory, 'resources/node-runtime/node.exe'), publisher: 'CN=AIPOCH PTE[.] LTD[.]' }
  ]
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, OPEN_SCIENCE_SIGNATURE_FILES: JSON.stringify(files) }, timeoutMs: 60000
  })
  await evidence(phase + '-installed-signatures', { exitCode: result.code, records: JSON.parse(result.stdout) })
}
async function listOperationIds() {
  try { return await readdir(operationRoot()) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function captureOperation(before, parentPid, targetVersion, applicationPath, configRoot) {
  return waitFor('the new correlated product operation request', async () => {
    const ids = (await listOperationIds()).filter(id => !before.includes(id))
    if (!ids.length) return
    const requests = []
    for (const id of ids) {
      try {
        const request = JSON.parse(await readFile(join(operationRoot(), id, 'request.json'), 'utf8'))
        if (request.parentPid === parentPid) requests.push(request)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!requests.length) return
    if (requests.length !== 1) throw new Error('More than one operation for the update click')
    const request = requests[0]
    if (!request.helperPid) return
    if (request.targetVersion !== targetVersion || !samePath(request.applicationPath, applicationPath) || !samePath(request.startupOptions.configRoot, configRoot) || !samePath(request.profilePath, chainEnvironment.OPEN_SCIENCE_USER_DATA)) throw new Error('Operation is bound to the wrong launch identity')
    if (confirmedOperations.includes(request.operationId)) throw new Error('A prior operation UUID was reused')
    activeHelperIdentity = (await snapshotInstallation(join(operationRoot(), request.operationId))).find(p => p.pid === request.helperPid)
    if (!activeHelperIdentity) throw new Error('The operation helper was not observed before installation')
    rememberedProcesses.push(activeHelperIdentity)
    await evidence('operation-created', { request, ownerIdentity: activeOwnerIdentity, helperIdentity: activeHelperIdentity })
    return request
  }, 15000)
}
async function verifyOperationReceipts(installDirectory, configRoot, expectedVersion) {
  if (!activeOperation) throw new Error('No captured update operation')
  const id = activeOperation.operationId
  const directory = join(operationRoot(), id)
  const result = await waitFor('installed, ready and closed receipts from this signed update', async () => {
    const receipts = {}
    let previousTime = 0
    for (const stage of ['accepted', 'installing', 'installed', 'ready', 'closed']) {
      const path = join(directory, stage + '.receipt')
      let content, info
      try { content = await readFile(path, 'utf8'); info = await stat(path) }
      catch (error) { if (error.code === 'ENOENT') return; throw error }
      if (content !== id + '\r\n' + stage + '\r\n') throw new Error('Receipt correlation failed: ' + stage)
      if (info.mtimeMs < previousTime) throw new Error('Receipt publication order reversed: ' + stage)
      previousTime = info.mtimeMs
      receipts[stage] = { content, modifiedAt: info.mtime.toISOString() }
    }
    const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'))
    const processes = await snapshotInstallation(installDirectory)
    if (!processes.some(p => p.pid === request.successorPid && samePath(p.path, join(installDirectory, 'open-science.exe')))) throw new Error('Ready receipt has no live owned successor')
    if (processes.some(p => sameRecordedProcess(p, activeOwnerIdentity) || sameRecordedProcess(p, activeHelperIdentity))) throw new Error('Successful handoff retains its original owner/helper identity')
    if (!samePath(request.startupOptions.configRoot, configRoot) || request.targetVersion !== expectedVersion) throw new Error('Confirmed operation identity changed')
    return { request, receipts, processes, directory }
  }, 60000)
  confirmedOperations.push(id)
  result.helperExit = await waitForRecordedExit([activeHelperIdentity])
  await evidence('operation-confirmed', result)
}
async function readLiveCredentialMcp(installDirectory) {
  return waitFor('the same synthetic credential resolving after a normal launch', async () => {
    const events = (await readFile(seededData.marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    const latest = events.filter(event => event.event === 'started').at(-1)
    if (latest?.credentialMatched && (await snapshotInstallation(installDirectory)).some(p => p.pid === latest.pid)) return latest
  }, UPDATE_TIMEOUT_MS)
}
async function verifyMigrationRelaunch(ready, installDirectory, configRoot, expectedVersion) {
  const rpc = (channel, ...args) => invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel, args })
  const before = await rpc('storage:get-status')
  const oldLaunch = await readOperationLaunchIdentity(installDirectory)
  // Use an account-owned short path: the product reserves room for nested files
  // beneath dataRoot and intentionally rejects the long installation fixture path.
  const destination = join(process.env.RUNNER_TEMP, 'migrated')
  await mkdir(destination, { recursive: true })
  await evidence('migration-before', { state: ready.state, storage: before, destination, launch: oldLaunch, operationId: activeOperation.operationId })
  await desktopButton(installDirectory, 'migration-settings', '^Settings$', true)
  await desktopButton(installDirectory, 'migration-storage', '^Storage$', true)
  await desktopButton(installDirectory, 'migration-change', '^Change location$', true)
  await desktopButton(installDirectory, 'migration-warning', '^Continue$', true)
  await waitFor('the new data location text field', async () => {
    const result = await operateRecordedDraft(await snapshotInstallation(installDirectory), undefined, 'New location')
    return result.found ? result : undefined
  }, 30000)
  const input = await operateRecordedDraft(await snapshotInstallation(installDirectory), destination, 'New location')
  await evidence('migration-path-input', input)
  if (!input.set) throw new Error('Data location input did not receive real keyboard input')
  const settledInput = await waitFor('the product to reflect the typed migration path', async () => {
    const result = await operateRecordedDraft(await snapshotInstallation(installDirectory), undefined, 'New location')
    return result.valueText === destination ? result : undefined
  }, 30000)
  await evidence('migration-path-accepted-input', settledInput)
  await desktopButton(installDirectory, 'migration-start-copy', '^Change location$', true)
  await desktopButton(installDirectory, 'migration-copy-complete', '^Restart now$', false)
  const oldProcesses = await snapshotInstallation(installDirectory)
  await evidence('migration-before-relaunch', oldProcesses)
  await desktopButton(installDirectory, 'migration-native-relaunch', '^Restart now$', true)
  await evidence('migration-original-normal-exit', await waitForRecordedExit(oldProcesses))
  const after = await waitFor('the product-relaunched runtime with the new data directory', async () => {
    const state = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
    if (state.pid === ready.state.pid || state.appVersion !== expectedVersion) return
    const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
    const endpoint = 'http://127.0.0.1:' + state.port
    const auth = 'token=' + encodeURIComponent(token)
    const response = await fetchWithTimeout(endpoint + '/api/bootstrap?' + auth)
    if (!response.ok) return
    const bootstrap = await response.json()
    const storage = await invokeWebRpc({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion, channel: 'storage:get-status' })
    if (samePath(storage.dataRoot, before.dataRoot) || !samePath(dirname(storage.dataRoot), destination)) throw new Error('Product relaunch did not select the migrated data directory')
    if (!samePath(state.configRoot, configRoot)) throw new Error('Product relaunch changed the config profile')
    return { state, storage, operationId: activeOperation.operationId, source: 'real Storage settings Restart now button; no external spawn' }
  }, UPDATE_TIMEOUT_MS)
  after.launch = await readOperationLaunchIdentity(installDirectory)
  if (after.launch.pid === oldLaunch.pid) throw new Error('Native relaunch did not replace the desktop process')
  await evidence('migration-native-relaunch-result', after)
  await verifyAndStopSuccessor(installDirectory, configRoot, expectedVersion, 'migrated-')
}
async function readOperationLaunchIdentity(installDirectory) {
  const records = await snapshotInstallation(installDirectory)
  const script = [
    "$ErrorActionPreference='Stop'",
    "$results=@(foreach($record in ($env:OPEN_SCIENCE_LAUNCH_RECORDS | ConvertFrom-Json)) {",
    "$current=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $record.pid)",
    "if($current -and $current.CreationDate.ToUniversalTime().ToString(\"yyyy-MM-ddTHH:mm:ss.ffffff'Z'\") -eq $record.started -and $current.ExecutablePath -eq $env:OPEN_SCIENCE_LAUNCH_APP -and $current.CommandLine -notmatch '--type=') {",
    "$operation=[regex]::Match($current.CommandLine,'--open-science-update-operation=([a-fA-F0-9-]+)').Groups[1].Value",
    "@{pid=$current.ProcessId;path=$current.ExecutablePath;started=$record.started;operationId=$operation}",
    "}})",
    "ConvertTo-Json -InputObject $results -Compress"
  ].join('\n')
  const result = await runProcess('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { env: { ...process.env, OPEN_SCIENCE_LAUNCH_RECORDS: JSON.stringify(records), OPEN_SCIENCE_LAUNCH_APP: join(installDirectory, 'open-science.exe') }, timeoutMs: 15000 })
  const launches = JSON.parse(result.stdout)
  if (launches.length !== 1 || launches[0].operationId !== activeOperation.operationId) throw new Error('Native product process did not retain its confirmed update UUID')
  return launches[0]
}
async function verifyRealUninstall() {
  const directory = join(chainRoot, 'app')
  // NSIS copies its worker outside the installation into this disposable account's TEMP.
  // The launcher's exit alone does not prove that worker or its cleanup scripts completed.
  const temporaryRoot = resolve(process.env.RUNNER_TEMP)
  if (!resolve(chainRoot).toLowerCase().startsWith(temporaryRoot.toLowerCase() + '\\')) throw new Error('Uninstall temporary root is not the isolated account directory')
  const processes = await snapshotInstallation(temporaryRoot)
  await evidence('before-real-uninstall', { processes, operations: confirmedOperations })
  if (processes.length) throw new Error('Refuse uninstall acceptance with live installation processes')
  const uninstaller = await singleFile(directory, /^Uninstall .*\.exe$/i, 'installed uninstaller')
  let forced = false
  let timeoutCleanup
  try {
    const result = await runProcess(uninstaller, ['/S', '/KEEP_APP_DATA'], { env: chainEnvironment, allowNonZero: true, timeoutMs: 120000 }, async (child) => {
      const owned = await snapshotInstallation(directory)
      await evidence('uninstall-timeout-before-cleanup', { pid: child.pid, processes: owned })
      if (!owned.some(record => record.pid === child.pid)) throw new Error('Cannot confirm timed-out uninstaller identity; leave processes for runner audit')
      forced = true
      timeoutCleanup = await waitForRecordedExit(owned, { force: true, timeoutMs: 10000 })
      await evidence('uninstall-timeout-forced-cleanup', timeoutCleanup)
    })
    await evidence('real-uninstaller-result', result)
    if (result.code !== 0) throw new Error('Real uninstaller failed: ' + result.code)
    const workers = await snapshotInstallation(temporaryRoot)
    await evidence('real-uninstaller-workers', workers)
    const exits = await waitForRecordedExit(workers, { timeoutMs: 120000 })
    await evidence('real-uninstaller-worker-exits', exits)
    if (exits.some(record => record.exitCode !== undefined && record.exitCode !== 0)) throw new Error('Real uninstaller worker failed')
    await waitFor('the real uninstaller to remove the installed application', async () => {
      try { await stat(join(directory, 'open-science.exe')); return }
      catch (error) { if (error.code === 'ENOENT') return true; throw error }
    }, 60000)
    const remaining = await listOperationIds()
    if (confirmedOperations.some(id => remaining.includes(id))) throw new Error('Real uninstall retained completed owned update operations')
    const after = await snapshotInstallation(temporaryRoot)
    if (after.length) throw new Error('Real uninstall retained owned installation processes')
    await evidence('real-uninstall', { status: 'PASS', operationsRemoved: confirmedOperations, remainingOperationIds: remaining, processes: after, forced: false })
  } catch (error) {
    await evidence('real-uninstall', { status: 'FAIL', error: error.stack, processes: await snapshotInstallation(temporaryRoot), remainingOperationIds: await listOperationIds(), forced, timeoutCleanup })
    throw error
  }
}
const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const third = process.env.OPEN_SCIENCE_UPGRADE_TEST_THIRD_DIRECTORY
  if (!third) throw new Error('Three signed artifacts are required for a continuous A to B to C upgrade')
  const evidenceRoot = process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY
  const first = join(evidenceRoot, 'a-to-b')
  const second = join(evidenceRoot, 'b-to-c')
  await mkdir(first, { recursive: true })
  await mkdir(second, { recursive: true })
  await writeFile(join(first, 'product-local-mcp.cjs'), await readFile(join(evidenceRoot, 'product-local-mcp.cjs')))
  process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY = first
  await runTransition({ ...options, output: join(first, 'updater-observation.json') })
  if (confirmedOperations.length !== 1) throw new Error('First upgrade did not confirm exactly one operation')
  process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY = second
  activeOperation = undefined
  downloadFault.events = []
  await runTransition({ ...options, previousDirectory: options.currentDirectory, currentDirectory: third, output: join(second, 'updater-observation.json') }, chainRoot)
  if (confirmedOperations.length !== 2 || confirmedOperations[0] === confirmedOperations[1]) throw new Error('Two distinct update operations were not confirmed')
  process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY = evidenceRoot
  await evidence('continuous-upgrade-result', { status: 'PASS', versions: ['1.0.0','1.0.1','1.0.2'], operations: confirmedOperations, root: chainRoot, sameInstallation: true, sameConfigRoot: chainEnvironment.OPEN_SCIENCE_CONFIG_ROOT, sameProfile: chainEnvironment.OPEN_SCIENCE_USER_DATA, sameProject: seededData.project.id, sameSession: seededData.session.id, sameCredential: seededData.credentialId })
  await verifyRealUninstall()
}
`
replace('const invokedAsScript =', extra + '\nconst invokedAsScript =')
await writeFile(target, text)
console.log('Prepared continuous signed A to B to C upgrade harness with correlated receipts.')
