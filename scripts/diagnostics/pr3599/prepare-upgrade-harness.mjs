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
const probe = smoke.slice(probeStart, probeEnd).replace('    await terminateProcessTree(child)', `    const records = await snapshotInstallation(installDirectory)
    let windows
    try { windows = await readRecordedWindows(records) } catch (error) { windows = { captureError: error.message } }
    await writeFile(join(process.env.PR3599_EVIDENCE_DIR, 'initial-startup-failure.json'), JSON.stringify({ error: error.message, records, windows }, null, 2))
    const cleanup = await waitForRecordedExit(records, { force: true, timeoutMs: 10000 })
    await writeFile(join(process.env.PR3599_EVIDENCE_DIR, 'initial-startup-forced-cleanup.json'), JSON.stringify(cleanup, null, 2))`)
smoke = smoke.slice(0, probeStart) + probe + smoke.slice(probeEnd)
smoke = "import { snapshotInstallation, readRecordedWindows, waitForRecordedExit } from './pr3599-owned-processes.mjs'\n" + smoke
await writeFile(join(source, 'scripts/pr3599-installer-smoke.mjs'), smoke)
let text = await readFile(original, 'utf8')
const replace = (before, after) => {
  if (text.split(before).length !== 2) throw new Error(`Unexpected harness boundary: ${before.slice(0, 100)}`)
  text = text.replace(before, after)
}
replace("import { basename, join, resolve, win32 } from 'node:path'", "import { basename, dirname, join, resolve, win32 } from 'node:path'")
replace("import { randomUUID } from 'node:crypto'", "import { createHash, randomUUID } from 'node:crypto'")
replace("from './windows-installer-smoke.mjs'", "from './pr3599-installer-smoke.mjs'")
replace("const child = spawn(executable, ['--open-science-headless', '--serve=0'], {\n    env,\n    windowsHide: true\n  })", "const child = spawn(executable, ['--serve=0'], {\n    env,\n    windowsHide: false\n  })")
replace('  cleanupSmokeRoot,', '')
replace('channel, fetchImpl = fetch }) => {', 'channel, args = [], fetchImpl = fetch }) => {')
replace('JSON.stringify({ protocolVersion, args: [] })', 'JSON.stringify({ protocolVersion, args })')
replace("const UPDATE_TIMEOUT_MS = 180_000", "import { snapshotInstallation, waitForRecordedExit, closeRecordedWindow, readRecordedWindows } from './pr3599-owned-processes.mjs'\nconst UPDATE_TIMEOUT_MS = 180_000")
replace('    const checked = await withTimeout(', '    await seedUpgradeData({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable))\n    const checked = await withTimeout(')
replace('    await onDownloaded()', "    await onDownloaded()\n    if (process.env.PR3599_BASELINE === 'pr') await verifyOccupiedInstallation({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable), env)")
replace('  const env = windowsProfileEnvironment(profileDirectory)', "  const env = { ...windowsProfileEnvironment(profileDirectory), OPEN_SCIENCE_WEB_PORT: '0' }\n  await writeFile(options.output + '.root.json', JSON.stringify({ root, installDirectory, profileDirectory, independentHarnessPid: process.pid, independentHarnessExecutable: process.execPath }, null, 2))")
replace('    const closed = waitForShutdownExit(exit, child, diagnosticOutput)', "    const ownedBeforeUpdate = await snapshotInstallation(dirname(executable))\n    rememberedProcesses.push(...ownedBeforeUpdate)\n    await evidence('old-processes-before-update', ownedBeforeUpdate)\n    const closed = waitForShutdownExit(exit, child, diagnosticOutput)")
replace('    const installerResult = await installerExit', "    await evidence('old-app-output', { pid: child.pid, stdout: redactPackagedAppOutput(stdout), stderr: redactPackagedAppOutput(stderr), exitCode })\n    await evidence('old-processes-normal-exit', await waitForRecordedExit(ownedBeforeUpdate))\n    const installerResult = await installerExit")
replace('    installerObserver.abort(', "    await evidence('old-app-failure-output', { pid: child.pid, stdout: redactPackagedAppOutput(stdout), stderr: redactPackagedAppOutput(stderr), error: error.message })\n    installerObserver.abort(")
replace("    await runProcess('taskkill.exe', ['/IM', 'open-science.exe', '/T', '/F'], {\n      allowNonZero: true,\n      env,\n      timeoutMs: 10_000\n    })", '    await verifyAndStopSuccessor(installDirectory, previousConfigRoot, currentVersion)')
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
replace('  if (installed) await cleanup(() => uninstallAndVerify(installDirectory, env))', "  if (installed && !primaryError && !cleanupErrors.length) await cleanup(() => uninstallAndVerify(installDirectory, env))")
replace('  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))', "  await evidence('final-state', { root, independentHarnessPid: process.pid, primaryError: primaryError?.message, cleanupErrors: cleanupErrors.map((e) => e.message), processes: await snapshotInstallation(installDirectory), directoryRetained: true })")
const helpers = String.raw`
const rememberedProcesses = []
let seededData
async function verifyOccupiedInstallation(connection, installDirectory, env) {
  const executable = join(installDirectory, 'resources/node-runtime/node.exe')
  const blocker = spawn(executable, ['-e', 'process.stdin.once("data",()=>process.exit(0));console.log("owned-lock-ready")'], { env, windowsHide: true })
  const exited = new Promise((resolve, reject) => { blocker.once('exit', resolve); blocker.once('error', reject) })
  try {
    await withTimeout(new Promise((resolve, reject) => { blocker.stdout.once('data', resolve); blocker.once('error', reject) }), 'owned installation lock readiness', 15000)
    const records = await snapshotInstallation(installDirectory)
    rememberedProcesses.push(...records)
    const result = await invokeWebRpc({ ...connection, channel: 'update:apply' })
    await evidence('occupied-installation-blocked', { blockerPid: blocker.pid, processes: records, result })
    if (result.reason !== 'installation-busy' || result.recovery?.installation !== 'unchanged' || result.recovery?.runtime !== 'running') throw new Error('Occupied installation was not safely blocked')
    if (blocker.exitCode !== null) throw new Error('Product terminated the independent installation occupant')
    const response = await fetchWithTimeout(connection.endpoint + '/api/bootstrap?' + connection.auth)
    if (!response.ok) throw new Error('Product became unavailable after refusing occupied installation')
  } finally {
    blocker.stdin.end('release\n')
    const code = await withTimeout(exited, 'owned lock fixture normal exit', 15000)
    await evidence('occupied-installation-release', { pid: blocker.pid, exitCode: code, forced: false })
    if (code !== 0) throw new Error('Installation lock fixture did not exit normally')
  }
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
  await rpc('settings:add-custom-server', { id: 'pr3599-upgrade', name: 'pr3599-upgrade', displayName: 'PR3599 local upgrade MCP', transport: 'stdio', command: join(installDirectory, 'resources/node-runtime/node.exe'), args: [fixture, marker], envCredentialIds: { PR3599_TEST_SECRET: credential.createdCredential.id } })
  await rpc('settings:set-custom-server-enabled', { id: 'pr3599-upgrade', enabled: true })
  await rpc('settings:retry-custom-server', { id: 'pr3599-upgrade' })
  const mcp = await waitFor('the real pre-upgrade MCP with its synthetic credential', async () => {
    const events = (await readFile(marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    const started = events.filter((event) => event.event === 'started').at(-1)
    const processes = await snapshotInstallation(installDirectory)
    if (started?.credentialMatched && processes.some((p) => p.pid === started.pid)) return started
  }, UPDATE_TIMEOUT_MS)
  seededData = { project, session, credentialId: credential.createdCredential.id, marker, mcp }
  await evidence('seeded-product-data', seededData)
}
async function evidence(name, value) {
  const directory = process.env.PR3599_EVIDENCE_DIR
  if (!directory) throw new Error('Missing PR3599_EVIDENCE_DIR')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2))
}
async function verifyAndStopSuccessor(installDirectory, configRoot, expectedVersion) {
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
  await evidence('automatic-successor-ready', { state: ready.state, processes: ready.processes, version: ready.bootstrap.appVersion, platform: ready.bootstrap.platform })
  const hashes = {}
  for (const relative of ['open-science.exe', 'resources/node-runtime/node.exe', 'resources/app.asar']) {
    hashes[relative] = createHash('sha256').update(await readFile(join(installDirectory, relative))).digest('hex')
  }
  await evidence('installed-candidate-hashes', hashes)
  const rpc = (channel, ...args) => invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel, args })
  const project = await rpc('projects:get', seededData.project.id)
  if (project?.name !== seededData.project.name || project?.description !== seededData.project.description) throw new Error('Upgrade did not preserve the project')
  const session = await rpc('sessions:load-one', { projectId: project.id, sessionId: seededData.session.id })
  if (session?.title !== seededData.session.title || session?.messages?.[0]?.content !== seededData.session.messages[0].content) throw new Error('Upgrade did not preserve the synthetic session transcript')
  const settings = await rpc('settings:get-settings')
  if (settings.closePreference !== 'quit') throw new Error('Upgrade did not preserve the close preference')
  await rpc('settings:retry-custom-server', { id: 'pr3599-upgrade' })
  const reconnected = await waitFor('the updated MCP resolving the preserved synthetic credential', async () => {
    const events = (await readFile(seededData.marker, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    const latest = events.filter((event) => event.event === 'started').at(-1)
    const processes = await snapshotInstallation(installDirectory)
    if (latest?.pid !== seededData.mcp.pid && latest?.credentialMatched && processes.some((p) => p.pid === latest.pid)) return { latest, processes }
  }, UPDATE_TIMEOUT_MS)
  ready.processes = reconnected.processes
  rememberedProcesses.push(...ready.processes)
  await evidence('preserved-project-and-credential', { project, session, credentialId: seededData.credentialId, mcp: reconnected.latest })
  await invokeWebRpc({ endpoint: ready.endpoint, auth: ready.auth, protocolVersion: ready.bootstrap.rpcProtocolVersion, channel: 'settings:set-close-preference', args: [{ preference: 'quit' }] })
  const closeRequest = await waitFor('the updated product window to accept normal close', () => closeRecordedWindow(ready.processes), UPDATE_TIMEOUT_MS)
  await evidence('automatic-successor-close-request', closeRequest)
  await evidence('automatic-successor-normal-exit', await waitForRecordedExit(ready.processes))
}
`
replace('const invokedAsScript =', helpers + '\nconst invokedAsScript =')
if (text.includes("'/IM'")) throw new Error('Global image-name termination remains')
await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'owned-processes.mjs'), join(source, 'scripts/pr3599-owned-processes.mjs'))
await writeFile(join(source, 'scripts/pr3599-upgrade-certification.mjs'), text)
console.log('Prepared candidate-bound upgrade harness with scoped cleanup and normal successor shutdown.')

