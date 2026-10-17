// Generate an instrumented copy of the candidate's existing real NSIS updater harness.
// Product binaries and the original harness remain unchanged. No preload or fake provider is added.
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const source = resolve(process.argv[2] || '.')
const original = join(source, 'scripts/windows-updater-certification.mjs')
let text = await readFile(original, 'utf8')
const replace = (before, after) => {
  if (text.split(before).length !== 2) throw new Error(`Unexpected harness boundary: ${before.slice(0, 100)}`)
  text = text.replace(before, after)
}
replace("import { basename, join, resolve, win32 } from 'node:path'", "import { basename, dirname, join, resolve, win32 } from 'node:path'")
replace("import { randomUUID } from 'node:crypto'", "import { createHash, randomUUID } from 'node:crypto'")
replace('  cleanupSmokeRoot,', '  requestPackagedAppShutdown,')
replace("const UPDATE_TIMEOUT_MS = 180_000", "import { snapshotInstallation, waitForRecordedExit } from './pr3599-owned-processes.mjs'\nconst UPDATE_TIMEOUT_MS = 180_000")
replace('  const env = windowsProfileEnvironment(profileDirectory)', "  const env = { ...windowsProfileEnvironment(profileDirectory), OPEN_SCIENCE_WEB_PORT: '0' }\n  await writeFile(options.output + '.root.json', JSON.stringify({ root, installDirectory, profileDirectory }, null, 2))")
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
replace('  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))', "  await evidence('final-state', { root, primaryError: primaryError?.message, cleanupErrors: cleanupErrors.map((e) => e.message), processes: await snapshotInstallation(installDirectory), directoryRetained: true })")
const helpers = String.raw`
const rememberedProcesses = []
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
  await requestPackagedAppShutdown(ready.endpoint, ready.auth)
  await evidence('automatic-successor-normal-exit', await waitForRecordedExit(ready.processes))
}
`
replace('const invokedAsScript =', helpers + '\nconst invokedAsScript =')
if (text.includes("'/IM'")) throw new Error('Global image-name termination remains')
await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'owned-processes.mjs'), join(source, 'scripts/pr3599-owned-processes.mjs'))
await writeFile(join(source, 'scripts/pr3599-upgrade-certification.mjs'), text)
console.log('Prepared candidate-bound upgrade harness with scoped cleanup and normal successor shutdown.')
