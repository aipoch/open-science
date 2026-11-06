/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { cleanupOwnedFixture } from './fixtures/mac-recovery-entry/cleanup-owned.mjs'

if (process.platform !== 'darwin')
  throw new Error('This fixture requires native macOS AppKit and code signing')
const require = createRequire(import.meta.url)
const native = require('@aipoch/process-tree-native')
const { createWrapper } = require('../build/mac-recovery-package.cjs')
const project = dirname(dirname(fileURLToPath(import.meta.url)))
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mac-recovery-wrapper-')))
const sourceArch = process.env.OPEN_SCIENCE_MAC_ENTRY_FIXTURE_SOURCE_ARCH ?? process.arch
assert.ok(['x64', 'arm64'].includes(sourceArch))
const runtimeRoot = join(root, 'runtimes')
const stateRoot = join(root, 'installations')
const wrapper = join(root, 'Applications/Open-Science.app')
const receipt = join(root, 'runtime-proof.json')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const runtime = join(runtimeRoot, digest(wrapper), 'Open-Science.app')
const state = join(stateRoot, digest(runtime))
const eventsPath = join(state, 'mac-entry-events.ndjson')
const owned = new Map()
const evidence = {
  root,
  wrapper,
  runtime,
  state,
  sourceVersion: '1.0.8',
  targetVersion: '1.0.9',
  sourceArchitecture: sourceArch,
  targetArchitecture: process.arch,
  scenarios: []
}
const run = (command, args) =>
  execFileSync(command, args, { timeout: 120_000, stdio: 'pipe', encoding: 'utf8' })
const events = () =>
  fs.existsSync(eventsPath)
    ? fs
        .readFileSync(eventsPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
async function until(predicate, description, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = predicate()
    if (result) return result
    await pause(20)
  }
  const controlLog = join(state, 'mac-entry-control.log')
  throw new Error(
    `Timed out: ${description}; events=${JSON.stringify(events())}; control=${fs.existsSync(controlLog) ? fs.readFileSync(controlLog, 'utf8') : ''}`
  )
}
function retain(pid) {
  const identity = native.getDarwinProcess(pid)
  if (identity) {
    const executablePath = native.getDarwinProcessExecutable(pid, identity.uniqueId)
    if (executablePath?.startsWith(root + '/'))
      owned.set(pid, { uniqueId: identity.uniqueId, executablePath })
  }
}
function stop(pid, signal = 15) {
  const process = owned.get(pid)
  if (process) native.signalDarwinProcess(pid, process.uniqueId, signal, process.executablePath)
}
function buildRuntime(name, version) {
  const bundle = join(root, name, 'Open-Science.app')
  const resources = join(bundle, 'Contents/Resources')
  const executable = join(bundle, 'Contents/MacOS/Open-Science')
  fs.mkdirSync(dirname(executable), { recursive: true })
  fs.mkdirSync(join(resources, 'node-runtime'), { recursive: true })
  fs.writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Open-Science</string><key>CFBundleIdentifier</key><string>com.aipoch.fixture.runtime.${process.pid}</string>
<key>CFBundleName</key><string>Open-Science</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSUIElement</key><true/>
</dict></plist>`
  )
  run('/usr/bin/xcrun', [
    'clang',
    '-fobjc-arc',
    '-Wno-deprecated-declarations',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-arch',
    (name === 'source' ? sourceArch : process.arch) === 'x64' ? 'x86_64' : 'arm64',
    `-DPROBE_VERSION=${JSON.stringify(version)}`,
    '-framework',
    'AppKit',
    join(project, 'scripts/fixtures/mac-recovery-entry/runtime-probe.m'),
    '-o',
    executable
  ])
  const node = join(resources, 'node-runtime/node')
  const nodeSource = process.env.OPEN_SCIENCE_MAC_ENTRY_FIXTURE_NODE ?? process.execPath
  if (run('/usr/bin/otool', ['-L', nodeSource]).includes('@rpath/libnode.'))
    throw new Error(
      'Set OPEN_SCIENCE_MAC_ENTRY_FIXTURE_NODE to the staged standalone runtime Node, not a shared Homebrew launcher'
    )
  fs.copyFileSync(nodeSource, node, fs.constants.COPYFILE_FICLONE)
  run('/usr/bin/codesign', ['--force', '--sign', '-', node])
  const addon = join(
    resources,
    'app.asar.unpacked/node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node'
  )
  fs.mkdirSync(dirname(addon), { recursive: true })
  fs.copyFileSync(
    join(project, 'packages/process-tree-native/build/Release/process_tree_native.node'),
    addon
  )
  run('/usr/bin/codesign', ['--force', '--sign', '-', addon])
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle])
  return bundle
}
async function launch(extra = {}, args = []) {
  const settings = {
    OPEN_SCIENCE_MAC_RUNTIME_ROOT: runtimeRoot,
    OPEN_SCIENCE_INSTALLATION_STATE_ROOT: stateRoot,
    OPEN_SCIENCE_MAC_ENTRY_FIXTURE_RECEIPT: receipt,
    OPEN_SCIENCE_MAC_ENTRY_FIXTURE_NO_DIALOG: '1',
    ...extra
  }
  const parameters = ['-n', wrapper]
  for (const [key, value] of Object.entries(settings)) parameters.push('--env', `${key}=${value}`)
  if (args.length) parameters.push('--args', ...args)
  const open = spawn('/usr/bin/open', parameters, { stdio: 'pipe' })
  await new Promise((resolve, reject) => {
    open.once('error', reject)
    open.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`LaunchServices exit ${code}`))
    )
  })
}
function pending(targetZip) {
  const operationId = randomUUID()
  const handoffDirectory = join(root, 'handoffs', operationId)
  fs.mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 })
  const installerPath = join(handoffDirectory, 'update.zip')
  fs.copyFileSync(targetZip, installerPath, fs.constants.COPYFILE_FICLONE)
  const installerSha512 = createHash('sha512')
    .update(fs.readFileSync(installerPath))
    .digest('base64')
  const startupOptions = {
    configRoot: join(root, 'config'),
    dataRoot: join(root, 'research'),
    profilePath: join(root, 'profile'),
    port: 0,
    host: '127.0.0.1',
    credentialStore: 'file'
  }
  for (const directory of [
    startupOptions.configRoot,
    startupOptions.dataRoot,
    startupOptions.profilePath
  ])
    fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    join(startupOptions.dataRoot, 'scientific-result.txt'),
    'preserved scientific result'
  )
  const request = {
    schema: 1,
    channel: 'mac-electron-updater',
    operationId,
    applicationPath: runtime,
    installerPath,
    installerUrl: 'http://127.0.0.1:1/unavailable-original-target.zip',
    installerSha512,
    targetVersion: '1.0.9',
    profilePath: startupOptions.profilePath,
    startupOptions,
    targetManifest: { version: '1.0.9', files: {} }
  }
  const bytes = JSON.stringify(request)
  fs.writeFileSync(join(handoffDirectory, 'request.json'), bytes, { mode: 0o600 })
  const marker = {
    schema: 1,
    channel: 'mac-electron-updater',
    operationId,
    installationRoot: runtime,
    handoffDirectory,
    targetVersion: request.targetVersion,
    installerSha512,
    requestSha256: digest(bytes),
    phase: 'handoff'
  }
  fs.writeFileSync(join(state, 'windows-update-in-progress.json'), JSON.stringify(marker), {
    mode: 0o600
  })
  return { request, marker }
}
async function observeTarget(name, operationId) {
  const proof = await until(
    () => fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')),
    `${name}: target native window`
  )
  assert.equal(proof.version, '1.0.9')
  assert.equal(proof.bundlePath, runtime)
  assert.equal(proof.launcherBundle, wrapper)
  assert.equal(proof.data, 'preserved scientific result')
  assert.equal(proof.windowVisible, true)
  assert.equal(proof.activationPolicy, 1) // Accessory runtime cannot offer a runtime-path Dock tile.
  assert.ok(
    proof.applications.some((app) => app.bundlePath === runtime && app.activationPolicy === 1)
  )
  assert.ok(
    proof.applications.some((app) => app.bundlePath === wrapper && app.activationPolicy === 0)
  )
  const launched = events().findLast(
    (entry) => entry.phase === 'native-launch-submitted' && entry.operationId === operationId
  )
  assert.ok(launched)
  retain(launched.pid)
  retain(proof.runtimePid)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', wrapper])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', runtime])
  evidence.scenarios.push({
    name,
    operationId,
    proof,
    phases: events().filter((entry) => entry.operationId === operationId)
  })
  fs.rmSync(join(state, 'windows-update-in-progress.json')) // Fixture-only cleanup after observed target; not a product success receipt.
  await pause(800)
  stop(launched.pid)
  fs.rmSync(receipt)
}
try {
  const source = buildRuntime('source', '1.0.8')
  const target = buildRuntime('target', '1.0.9')
  const targetZip = join(root, 'target-runtime.zip')
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', target, targetZip])
  await createWrapper({
    runtime: source,
    wrapper,
    identity: '-',
    arch: sourceArch,
    fixture: true
  })
  await launch({}, ['--profile', 'original profile argument'])
  const initial = await until(
    () => fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt, 'utf8')),
    'initial source'
  )
  assert.equal(initial.version, '1.0.8')
  assert.deepEqual(initial.arguments.slice(1), ['--profile', 'original profile argument'])
  retain(initial.ppid)
  retain(initial.runtimePid)
  evidence.scenarios.push({ name: 'first-launch-signed-seed-and-original-argv', proof: initial })
  await pause(800)
  stop(initial.ppid)
  fs.rmSync(receipt)

  let current = pending(targetZip)
  fs.rmSync(join(runtime, 'Contents/MacOS/Open-Science'))
  await launch()
  await observeTarget(
    'main-executable-missing-ordinary-entry-repairs-target',
    current.request.operationId
  )

  current = pending(targetZip)
  fs.rmSync(runtime, { recursive: true })
  const releaseFile = join(root, 'release-native-publication')
  const before = events().length
  await launch({
    OPEN_SCIENCE_MAC_ENTRY_PAUSE_AT: 'native-recovery-runtime-absent',
    OPEN_SCIENCE_MAC_ENTRY_RELEASE_FILE: releaseFile
  })
  const paused = await until(
    () =>
      events()
        .slice(before)
        .find((entry) => entry.phase === 'native-recovery-runtime-absent'),
    'actual native replacement pause'
  )
  retain(paused.pid)
  assert.equal(fs.existsSync(runtime), false)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', wrapper])
  stop(paused.pid, 9)
  await pause(100)
  await launch()
  await observeTarget(
    'whole-runtime-missing-and-recovery-writer-killed-during-replacement',
    current.request.operationId
  )

  current = pending(targetZip)
  fs.rmSync(runtime, { recursive: true })
  const lease = new DatabaseSync(join(state, 'native-update-owner.sqlite'))
  lease.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE')
  const ownerBefore = events().length
  await launch()
  await pause(300)
  assert.equal(
    events()
      .slice(ownerBefore)
      .some((entry) => entry.phase === 'native-recovery-claimed'),
    false
  )
  lease.close()
  await observeTarget('live-owner-blocks-repair-until-os-lock-release', current.request.operationId)
  current = pending(targetZip)
  fs.rmSync(runtime, { recursive: true })
  fs.writeFileSync(current.request.installerPath, 'corrupt retained package')
  const beforeCorruption = events().length
  await launch()
  const rejected = await until(
    () =>
      events()
        .slice(beforeCorruption)
        .find((entry) => entry.phase === 'recovery-original-package-unavailable'),
    'bad cache bounded rejection'
  )
  retain(rejected.pid)
  assert.equal(fs.existsSync(runtime), false)
  assert.equal(fs.existsSync(receipt), false)
  assert.equal(fs.existsSync(join(state, 'windows-update-in-progress.json')), true)
  assert.equal(
    fs.readFileSync(join(current.request.startupOptions.dataRoot, 'scientific-result.txt'), 'utf8'),
    'preserved scientific result'
  )
  evidence.scenarios.push({
    name: 'bad-cache-and-unavailable-original-source-never-falls-back-to-old-seed',
    rejected
  })
  fs.copyFileSync(targetZip, current.request.installerPath)
  await launch()
  await observeTarget(
    'original-package-restored-after-real-blocker-ordinary-entry-continues',
    current.request.operationId
  )
  const tampered = join(root, 'Tampered.app')
  run('/usr/bin/ditto', [wrapper, tampered])
  fs.writeFileSync(
    join(tampered, 'Contents/Resources/mac-recovery-entry.json'),
    JSON.stringify({ schema: 1, runtimeRequirement: 'identifier anything' })
  )
  const invalid = spawnSync(join(tampered, 'Contents/MacOS/Open-Science'), [], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, OPEN_SCIENCE_MAC_ENTRY_FIXTURE_NO_DIALOG: '1' }
  })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /entry-signature-invalid/)
  evidence.scenarios.push({
    name: 'tampered-wrapper-cannot-weaken-publisher-configuration',
    status: invalid.status,
    diagnostic: invalid.stderr.trim()
  })
  evidence.conclusion =
    'Stable signed ordinary wrapper survives missing runtime/main and a killed native recovery writer; fixed original target and profile are repaired and launched by the entry itself.'
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally {
  await cleanupOwnedFixture(root)
  fs.rmSync(root, { recursive: true, force: true })
}
