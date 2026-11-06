/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const wrappers = new Map()
const contexts = new Map()
const preparations = new Map()
const routes = new WeakMap()
const RUNTIME_ID = 'com.aipoch.open-science'
const TEAM_ID = '87G9WFU9H3'
const WRAPPER_ID = `${RUNTIME_ID}.launcher`

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options })
}
function plist(file, command) {
  return run('/usr/libexec/PlistBuddy', ['-c', command, file]).trim()
}
function sha512(file) {
  return createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}
function copyNativeShim(resources) {
  const target = path.join(resources, 'node_modules/@aipoch/process-tree-native')
  fs.mkdirSync(path.join(target, 'build/Release'), { recursive: true })
  for (const file of ['package.json', 'index.cjs'])
    fs.copyFileSync(
      path.join(__dirname, '../packages/process-tree-native', file),
      path.join(target, file)
    )
}

// Public Target.build routing is per target AND architecture. No global DMG configuration mutation
// or staging path shared by concurrent arm64/x64 builds; ZIP/feed continue to package the runtime.
function routeDmgTarget(target, arch, wrapper) {
  let route = routes.get(target)
  if (!route) {
    route = { original: target.build.bind(target), byArch: new Map() }
    routes.set(target, route)
    target.build = async (app, requestedArch) => {
      const selected = route.byArch.get(requestedArch)
      const destination = typeof selected === 'function' ? await selected() : selected
      return route.original(destination ?? app, requestedArch)
    }
  }
  route.byArch.set(arch, wrapper)
}

async function createWrapper(options) {
  const {
    runtime,
    wrapper,
    arch,
    identity,
    keychain,
    fixture = false,
    faultInjection = false
  } = options
  const resources = path.join(wrapper, 'Contents/Resources')
  const executable = path.join(wrapper, 'Contents/MacOS/Open-Science')
  if (fs.existsSync(wrapper))
    throw new Error('The architecture-specific recovery wrapper already exists')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.mkdirSync(resources, { recursive: true })
  const sourceInfo = path.join(runtime, 'Contents/Info.plist')
  const version = plist(sourceInfo, 'Print :CFBundleShortVersionString')
  if (plist(sourceInfo, 'Print :CFBundleIdentifier') !== RUNTIME_ID && !fixture)
    throw new Error('The runtime has an unexpected bundle identifier')
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', runtime])
  const seed = path.join(resources, 'runtime-seed.zip')
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', runtime, seed])
  const designated = require('node:child_process').spawnSync(
    '/usr/bin/codesign',
    ['-d', '-r-', runtime],
    { encoding: 'utf8' }
  )
  if (designated.status !== 0)
    throw new Error('The signed runtime designated requirement is unavailable')
  const requirement = fixture
    ? `identifier "${plist(sourceInfo, 'Print :CFBundleIdentifier')}"`
    : identity !== '-'
      ? `identifier "${RUNTIME_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`
      : `${designated.stdout}\n${designated.stderr}`
          .split(/\r?\n/)
          .find((line) => line.startsWith('designated => '))
          ?.slice('designated => '.length)
  if (!requirement) throw new Error('The runtime designated requirement is missing')
  const config = {
    schema: 1,
    faultInjection: fixture || faultInjection,
    runtimeBundleIdentifier: plist(sourceInfo, 'Print :CFBundleIdentifier'),
    runtimeRequirement: requirement,
    seedVersion: version,
    seedSha512: sha512(seed)
  }
  fs.writeFileSync(path.join(resources, 'mac-recovery-entry.json'), JSON.stringify(config))
  fs.copyFileSync(sourceInfo, path.join(wrapper, 'Contents/Info.plist'))
  const info = path.join(wrapper, 'Contents/Info.plist')
  plist(
    info,
    `Set :CFBundleIdentifier ${fixture ? config.runtimeBundleIdentifier + '.launcher' : WRAPPER_ID}`
  )
  plist(info, 'Set :CFBundleExecutable Open-Science')
  try {
    plist(info, 'Delete :LSUIElement')
  } catch {
    /* Ordinary native entry owns the fixed Dock icon. */
  }
  for (const file of ['icon.icns', 'Assets.car']) {
    const source = path.join(runtime, 'Contents/Resources', file)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(resources, file))
  }
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, '../src/main/update/mac-recovery-control-entry.ts')],
    outfile: path.join(resources, 'mac-recovery-control.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['@aipoch/process-tree-native'],
    logLevel: 'silent'
  })
  copyNativeShim(resources)
  require('./mac-recovery-localizations.cjs')(resources)
  const definitions = fixture
    ? ['-DOPEN_SCIENCE_MAC_ENTRY_TESTING=1', '-DOPEN_SCIENCE_MAC_ENTRY_FAULT_INJECTION=1']
    : identity === '-'
      ? ['-DOPEN_SCIENCE_MAC_ENTRY_ADHOC=1']
      : []
  if (faultInjection && !fixture) definitions.push('-DOPEN_SCIENCE_MAC_ENTRY_FAULT_INJECTION=1')
  run('/usr/bin/xcrun', [
    'clang',
    '-fobjc-arc',
    '-Wno-deprecated-declarations',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-arch',
    arch === 'x64' ? 'x86_64' : arch,
    '-mmacosx-version-min=12.0',
    ...definitions,
    '-framework',
    'AppKit',
    '-framework',
    'Security',
    '-lsqlite3',
    path.join(__dirname, 'mac-recovery-launcher.m'),
    '-o',
    executable
  ])
  const sign = ['--force', '--options', 'runtime', '--sign', identity]
  if (keychain) sign.push('--keychain', keychain)
  if (identity !== '-') sign.push('--timestamp')
  // Preserve the reviewed addon signature; the outer resource seal covers the copied bytes.
  run('/usr/bin/codesign', [...sign, wrapper])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', wrapper])
  return { wrapper, runtime, arch, version }
}

async function buildSignedWrapper(context) {
  if (context.electronPlatformName !== 'darwin') return
  const arch = require('builder-util').Arch[context.arch]
  if (!['arm64', 'x64'].includes(arch))
    throw new Error('Recovery wrapper requires a supported single architecture')
  const runtime = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // Exact identity must be available when the runtime carries an official publisher signature.
  const metadata = require('node:child_process').spawnSync(
    '/usr/bin/codesign',
    ['-d', '--verbose=4', runtime],
    { encoding: 'utf8' }
  )
  const lines = `${metadata.stdout}\n${metadata.stderr}`.split(/\r?\n/)
  const team = lines
    .find((line) => line.startsWith('TeamIdentifier='))
    ?.slice('TeamIdentifier='.length)
  const authority = lines
    .find((line) => line.startsWith('Authority=Developer ID Application:'))
    ?.slice('Authority='.length)
  if (team && team !== 'not set' && team !== TEAM_ID)
    throw new Error('The runtime publisher does not match the recovery entry')
  if (team === TEAM_ID && !authority)
    throw new Error('An official runtime requires a Developer ID Application signing identity')
  const identity = team === TEAM_ID ? authority : '-'
  const signing = await context.packager.codeSigningInfo.value
  const wrapper = path.join(context.appOutDir, 'recovery-wrapper', 'Open-Science.app')
  const result = await createWrapper({
    runtime,
    wrapper,
    arch,
    identity,
    keychain: signing.keychainFile,
    faultInjection:
      identity !== '-' &&
      process.env.GITHUB_WORKFLOW === 'Mac Update Acceptance' &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.DIAGNOSTIC_MAC_FEED_URL === 'http://127.0.0.1:18761/' &&
      /^\d+\.\d+\.\d+$/.test(process.env.DIAGNOSTIC_VERSION ?? '')
  })
  wrappers.set(runtime, result)
  return result
}

function prepare(context) {
  if (context.electronPlatformName !== 'darwin') return
  const runtime = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  contexts.set(runtime, context)
  for (const target of context.targets)
    if (target.name === 'dmg')
      routeDmgTarget(target, context.arch, async () => (await ensureWrapper(context)).wrapper)
}

function ensureWrapper(context) {
  const runtime = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  let operation = preparations.get(runtime)
  if (!operation) {
    operation = buildSignedWrapper(context)
    preparations.set(runtime, operation)
  }
  return operation
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  prepare(context)
  await ensureWrapper(context)
}

async function afterAll(buildResult) {
  // electron-builder skips afterSign for ad-hoc/no-certificate builds. At this point all runtimes
  // have their final signature, so ZIP-only/--dir builds still get a correctly sealed ordinary entry.
  for (const context of contexts.values()) await ensureWrapper(context)
  const artifacts = []
  for (const entry of wrappers.values()) {
    const payload = buildResult.artifactPaths.find((file) =>
      file.endsWith(`-mac-${entry.arch}-runtime.zip`)
    )
    if (!payload) continue // --dir is a local unpacked build, not a distributable artifact build.
    const destination = payload.replace(/-runtime\.zip$/, '.zip')
    if (fs.existsSync(destination))
      throw new Error('The ordinary application ZIP would overwrite an existing artifact')
    run('/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      entry.wrapper,
      destination
    ])
    artifacts.push(destination)
  }
  return artifacts
}

module.exports = { afterSign, afterAll, prepare, createWrapper, routeDmgTarget }
