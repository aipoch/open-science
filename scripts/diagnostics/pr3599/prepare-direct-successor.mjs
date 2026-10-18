// Focused signed acceptance: the installer-started B remains alive until it installs C.
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = resolve(process.argv[2] || '.')
execFileSync(process.execPath, [fileURLToPath(new URL('./prepare-handoff-chain.mjs', import.meta.url)), source], { stdio: 'inherit' })
const target = join(source, 'scripts/pr3599-upgrade-certification.mjs')
let text = await readFile(target, 'utf8')
const replace = (before, after) => {
  if (text.split(before).length !== 2) throw new Error('Unexpected direct-successor boundary: ' + before.slice(0, 100))
  text = text.replace(before, () => after)
}
replace("import { dump, load } from 'js-yaml'", "import { dump, load } from 'js-yaml'\nimport { startIsolatedUpdateSource } from './pr3599-isolated-update-source.mjs'")
replace("import { createServer } from 'node:http'", "import { createServer } from 'node:http'\nimport { pipeline } from 'node:stream/promises'")
replace('      let range\n      if (rangeHeader) {', String.raw`      if (rangeHeader?.includes(',')) {
        let ranges
        try {
          if (!rangeHeader.startsWith('bytes=')) throw new Error('Invalid range unit')
          ranges = rangeHeader.slice(6).split(',').map(part => parseSingleRange('bytes=' + part.trim(), size))
          if (ranges.length > 1000 || ranges.some(range => !range)) throw new Error('Invalid multipart range')
        } catch {
          response.writeHead(416, { 'Content-Range': 'bytes */' + size }).end()
          return
        }
        const boundary = 'upgrade-fixture-' + randomUUID()
        const headers = ranges.map(({ start, end }) => Buffer.from('--' + boundary + '\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ' + start + '-' + end + '/' + size + '\r\n\r\n'))
        const ending = Buffer.from('--' + boundary + '--\r\n')
        const bytes = ranges.reduce((total, { start, end }) => total + end - start + 1, 0)
        const length = headers.reduce((total, header) => total + header.length + 2, bytes + ending.length)
        if (transfersBody && pathname === currentInstallerRoute) {
          metrics.rangeRequests += 1
          metrics.downloadedInstallerBytes += bytes
        }
        response.writeHead(206, { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Type': 'multipart/byteranges; boundary=' + boundary, 'Content-Length': length })
        if (!transfersBody) { response.end(); return }
        async function* body() {
          for (const [index, range] of ranges.entries()) {
            yield headers[index]
            yield* createReadStream(path, range)
            yield Buffer.from('\r\n')
          }
          yield ending
        }
        await pipeline(body(), response)
        return
      }
      let range
      if (rangeHeader) {`)
replace('    const installerBytes = (await stat(currentInstaller)).size', String.raw`    let previousBlockmapCacheVerified = false
    const blockmapCache = join(updaterCache, 'current.blockmap')
    try {
      const cached = await readFile(blockmapCache)
      const expected = await readFile(previousBlockmap)
      if (JSON.stringify(JSON.parse(gunzipSync(cached))) !== JSON.stringify(JSON.parse(gunzipSync(expected)))) throw new Error('Existing old blockmap cache differs from the signed previous package')
      previousBlockmapCacheVerified = true
      await evidence('previous-blockmap-cache', { path: blockmapCache, verified: true, cachedSha256: createHash('sha256').update(cached).digest('hex'), packageSha256: createHash('sha256').update(expected).digest('hex'), comparison: 'decompressed JSON content; cache read only' })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const installerBytes = (await stat(currentInstaller)).size`)
replace('        previousInstallerCacheVerified: true', '        previousInstallerCacheVerified: true,\n        previousBlockmapCacheVerified')
replace('    observation.blockmapRequests < 2 ||', '    observation.blockmapRequests < (observation.previousBlockmapCacheVerified === true ? 1 : 2) ||')
replace('const startAssetServer = async ({ assets, currentInstallerRoute }) => {', `let sharedAssetServer
const startAssetServer = async ({ assets, currentInstallerRoute }) => {
  if (sharedAssetServer) { sharedAssetServer.publish(assets, currentInstallerRoute); return sharedAssetServer }`)
replace("    metrics,\n    url: `http://127.0.0.1:${address.port}`,", `    metrics,
    publish(assets, route) {
      byRoute.clear()
      for (const asset of assets) byRoute.set(asset.route, asset.path)
      currentInstallerRoute = route
      for (const key of Object.keys(metrics)) metrics[key] = 0
    },
    url: \`http://127.0.0.1:\${address.port}\`,`)
replace('    const updateConfigPath =', '    sharedAssetServer = assetServer\n    const updateConfigPath =')
replace("    await writeFile(updateConfigPath, updateConfig.source, 'utf8')", "    if (!reuseRoot) await writeFile(updateConfigPath, updateConfig.source, 'utf8')")
replace('reuseRoot ? await launchAndProbe({ installDirectory, expectedVersion: previousVersion, env, legacyConfigRoots })', 'reuseRoot ? chainEnvironment.OPEN_SCIENCE_CONFIG_ROOT')
replace("    await verifyNormalReopen(installDirectory, previousConfigRoot, currentVersion, env)\n    await verifyUpdateObservations()\n    const currentConfigRoot = await launchAndProbe({\n      installDirectory,\n      expectedVersion: currentVersion,\n      env,\n      legacyConfigRoots: [previousConfigRoot]\n    })\n    await profileGuard.verifyCycle('current', currentConfigRoot)", `    await verifyDirectObservations()
    await profileGuard.verifyCycle('current', previousConfigRoot)
    if (currentVersion === '1.0.1') {
      directSuccessor = await readOperationLaunchIdentity(installDirectory)
      firstOperationSnapshot = await readOperationSnapshot(activeOperation.operationId)
      await evidence('retained-automatic-b', { ...directSuccessor, request: activeOperation, firstOperationSnapshot, restarted: false })
      return // Keep B, its profile/state, and its update feed alive for the second transition.
    }`)
replace("  if (!prefix && expectedVersion === '1.0.2') {\n    await verifyMigrationRelaunch(ready, installDirectory, configRoot, expectedVersion)\n    return\n  }", `  const launch = await readOperationLaunchIdentity(installDirectory)
  await evidence('automatic-successor-launch-identity', launch)
  if (!prefix && expectedVersion === '1.0.1') {
    directBackendIdentity = ready.processes.find(process => process.pid === ready.state.pid)
    if (!directBackendIdentity) throw new Error('Automatic B backend identity was not captured')
    return
  }`)
replace("@{pid=$current.ProcessId;path=$current.ExecutablePath;started=$record.started;operationId=$operation}", "@{pid=$current.ProcessId;path=$current.ExecutablePath;started=$record.started;operationId=$operation;commandLine=$current.CommandLine;parentPid=$current.ParentProcessId}")
replace("  const child = spawn(executable, ['--serve=0'], {\n    env,\n    windowsHide: false\n  })", `  const retained = expectedVersion === '1.0.2'
  if (retained) await assertRetainedB(dirname(executable), 'before-second-update')
  const child = retained ? { pid: directSuccessor.pid } : spawn(executable, ['--serve=0'], { env, windowsHide: false })`)
replace('  const exit = observeChildExit(child)', '  const exit = retained ? new Promise(() => {}) : observeChildExit(child)')
replace('        authenticatePackagedAppEndpoint(output(), configRoots)', '        retained ? authenticateRetainedEndpoint(configRoots[0]) : authenticatePackagedAppEndpoint(output(), configRoots)')
replace("    await desktopButton(dirname(executable), 'open-update',", `    if (retained) {
      await desktopButton(dirname(executable), 'second-settings', '^Settings$', true)
      await desktopButton(dirname(executable), 'second-general', '^General$', true)
      await desktopButton(dirname(executable), 'second-check-now', '^Check now$', true)
    }
    await desktopButton(dirname(executable), 'open-update',`)
replace("    await desktopButton(dirname(executable), 'open-update', '^New version: Update [(]v' + expectedVersion.replaceAll('.', '[.]') + '[)]$', true)", "    await desktopButton(dirname(executable), 'open-update', retained ? '^Update to ' + expectedVersion.replaceAll('.', '[.]') + '$' : '^New version: Update [(]v' + expectedVersion.replaceAll('.', '[.]') + '[)]$', true)")
replace('    await exerciseDownloadFaults({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable), expectedVersion)', "    await evidence('focused-scope', { downloadFaultMatrixRepeated: false, retainedAutomaticSuccessor: retained })")
replace("    if (process.env.OPEN_SCIENCE_UPGRADE_TEST_BASELINE === 'pr') await verifyOccupiedInstallation({ endpoint, auth, protocolVersion: bootstrap.rpcProtocolVersion }, dirname(executable), env)", '')
replace('    const closed = waitForShutdownExit(exit, child, diagnosticOutput)', `    const closed = retained ? waitForRecordedExit([directSuccessor], { timeoutMs: 180000 }).then(async records => {
      await evidence('retained-b-process-handle-exit', records)
      if (records.length !== 1 || records[0].forced || records[0].exitCode !== 0) throw new Error('B did not produce a normal zero exit on its recorded process handle')
      return records[0].exitCode
    }) : waitForShutdownExit(exit, child, diagnosticOutput)
    void closed.catch(() => undefined)`)
replace("    const beforeOperation = await listOperationIds()", "    if (retained) await assertRetainedB(dirname(executable), 'immediately-before-second-apply')\n    const beforeOperation = await listOperationIds()")
replace("    await evidence('persistence-order', inspectPersistenceOrder(stdout))", "    await evidence('persistence-order', retained ? { status: 'NOT_RETESTED', reason: 'Automatically launched B has no harness stdout pipe; original product file logs are retained. This focused test asserts actual preserved data.' } : inspectPersistenceOrder(stdout))")
replace("    await evidence('update-failure-forced-cleanup', await waitForRecordedExit(failedProcesses, { force: true, timeoutMs: 10000 }))", "    await evidence('update-failure-retained-scene', { processes: failedProcesses, forced: false })")
replace("      await evidence('failure-only-forced-cleanup', await waitForRecordedExit(identities, { force: true, timeoutMs: 10000 }))", "      await evidence('failure-retained-scene', { identities, forced: false })")
replace('  activeOperation = undefined', '  // Retain the first operation identity until the new product request is captured.')
replace('  await verifyRealUninstall()', `  await verifyFirstOperationUnchanged()
  const residual = await snapshotInstallation(join(chainRoot, 'app'))
  await evidence('direct-successor-result', { status: 'PASS', operations: confirmedOperations, b: directSuccessor, sameBVerifiedAtApply: true, residual, forced: false })
  if (residual.length) throw new Error('Direct successor acceptance retained owned processes')`)
replace("  const options = parseArguments(process.argv.slice(2))\n  const third", "  const options = parseArguments(process.argv.slice(2))\n  const third") // Guard the intended main boundary.
replace("  process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY = first\n  await runTransition", `  const routedSource = await startIsolatedUpdateSource({ runProcess, evidence, directory: evidenceRoot, getSource: () => sharedAssetServer?.url })
  try {
  process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY = first
  await runTransition`)
replace("  if (residual.length) throw new Error('Direct successor acceptance retained owned processes')\n}", `  if (residual.length) throw new Error('Direct successor acceptance retained owned processes')
  } finally {
    process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY = evidenceRoot
    await routedSource.close()
    if (sharedAssetServer) await sharedAssetServer.close()
  }
}`)
// The shared source is closed only by main, including failure paths.
replace('  if (assetServer) await cleanup(() => assetServer.close())', '')
const extra = String.raw`
let directSuccessor
let directBackendIdentity
let firstOperationSnapshot
async function authenticateRetainedEndpoint(configRoot) {
  const state = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
  const records = await snapshotInstallation(dirname(directSuccessor.path))
  const backend = records.find(record => sameRecordedProcess(record, directBackendIdentity))
  if (!backend || backend.parent !== directSuccessor.pid || state.pid !== backend.pid || state.appVersion !== '1.0.1' || !samePath(state.configRoot, configRoot) || state.attached) throw new Error('Retained B endpoint does not belong to its recorded backend')
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('Retained B published an invalid endpoint port')
  const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
  if (token.length < 32) throw new Error('Retained B authentication file is unavailable')
  await evidence('retained-b-authenticated-endpoint', { state, backend, main: directSuccessor, source: 'actual published profile files and exact live backend identity; no stdout synthesis or app launch' })
  return { endpoint: 'http://127.0.0.1:' + state.port, auth: 'token=' + encodeURIComponent(token) }
}
async function readOperationSnapshot(id) {
  const directory = join(operationRoot(), id)
  const files = {}
  for (const name of ['request.json', ...['accepted','installing','installed','ready','closed'].map(stage => stage + '.receipt')]) {
    const bytes = await readFile(join(directory, name))
    files[name] = { content: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  return { id, files }
}
async function verifyFirstOperationUnchanged() {
  const after = await readOperationSnapshot(firstOperationSnapshot.id)
  await evidence('first-operation-after-second-upgrade', after)
  if (JSON.stringify(after) !== JSON.stringify(firstOperationSnapshot)) throw new Error('Second update altered the first request or receipts')
}
async function assertRetainedB(directory, stage) {
  const current = await readOperationLaunchIdentity(directory)
  await evidence(stage + '-b-identity', { initial: directSuccessor, current, at: new Date().toISOString() })
  for (const key of ['pid','started','path','commandLine','operationId']) {
    if (current[key] !== directSuccessor[key]) throw new Error('Automatically launched B identity changed: ' + key)
  }
  await verifyFirstOperationUnchanged()
}
async function verifyDirectObservations() {
  if (composerDraft.seed?.status !== 'PASS' || !composerDraft.restored.length || composerDraft.restored.some(draft => draft.status !== 'PASS')) throw new Error('Actual keyboard draft preservation did not pass')
  const directory = process.env.OPEN_SCIENCE_UPGRADE_TEST_EVIDENCE_DIRECTORY
  const rows = (await readFile(join(directory, 'whole-handoff-window-timeline.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
  const samples = rows.filter(row => Array.isArray(row.windows))
  const errors = rows.filter(row => row.observerError)
  const gaps = samples.filter(row => !row.windows.length)
  const result = { samples: samples.length, errors, gaps, successorPid: samples.at(-1)?.successorPid, composerDraft, status: errors.length || gaps.length || !samples.length ? 'FAIL' : 'PASS' }
  await evidence('direct-update-observations', result)
  if (result.status !== 'PASS') throw new Error('Direct update window observation failed')
}
`
replace('const invokedAsScript =', extra + '\nconst invokedAsScript =')
await copyFile(fileURLToPath(new URL('./isolated-update-source.mjs', import.meta.url)), join(source, 'scripts/pr3599-isolated-update-source.mjs'))
await copyFile(fileURLToPath(new URL('./user-update-proxy.ps1', import.meta.url)), join(source, 'scripts/user-update-proxy.ps1'))
await writeFile(target, text)
console.log('Prepared direct automatic-successor acceptance; B is never respawned between upgrades.')
