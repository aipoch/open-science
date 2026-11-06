/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  readDesktopSqliteVersion,
  seedLegacyDatabase,
  verifyDatabaseMigrationLedger,
  verifyLegacyProjectPreserved,
  writeDatabaseMigrationCertification
} from './database-migration-ledger-smoke.mjs'
import { authenticatePackagedAppEndpoint } from './packaged-web-service-auth.mjs'
import { createMacSmokeProcessCleanup } from './mac-smoke-process-cleanup.mjs'
import { collectSmokeDiagnostics } from './package-smoke-diagnostics.mjs'

const ARTIFACT_PATTERN = /^aipoch-open-science-(.+)-mac-(?:arm64|x64)(?:-runtime)?\.(dmg|zip)$/
const SMOKE_ROOT_PREFIX = 'open-science-macos-package-smoke-'
const STARTUP_TIMEOUT_MS = 60_000

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const findArtifact = async (directory, extension, role = 'ordinary') => {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(`.${extension}`) &&
        (extension !== 'zip' || /-runtime\.zip$/.test(entry.name) === (role === 'runtime'))
    )
    .map((entry) => join(directory, entry.name))
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one macOS ${extension} in ${directory}; found ${matches.length}.`
    )
  }
  return matches[0]
}

const artifactVersion = (artifact) => {
  const match = basename(artifact).match(ARTIFACT_PATTERN)
  if (!match) throw new Error(`Cannot derive the app version from macOS artifact: ${artifact}`)
  return match[1]
}

const findAppBundle = async (directory) => {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => join(directory, entry.name))
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one .app in ${directory}; found ${matches.length}.`)
  }
  return matches[0]
}

const parsePackagedAppEndpoint = (output) => {
  const match = output.match(
    /Open-Science Web:\s+(http:\/\/127\.0\.0\.1:\d+\/(?:\?token=[A-Za-z0-9_-]+)?)/
  )
  if (!match) return undefined
  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  return {
    endpoint: url.origin,
    ...(token ? { auth: `token=${encodeURIComponent(token)}` } : {})
  }
}

const waitFor = async (description, check, timeoutMs = STARTUP_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined)
    if (value !== undefined && value !== false) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

const runProcess = (executable, args, options = {}) =>
  new Promise((resolveProcess, rejectProcess) => {
    const started = Date.now()
    console.log(`macOS smoke command: ${basename(executable)} ${args[0] ?? ''} started`)
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'pipe'
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.once('error', rejectProcess)
    child.once('exit', (code) => {
      console.log(
        `macOS smoke command: ${basename(executable)} exited ${code}; elapsedMs=${Date.now() - started}`
      )
      // Electron's detached crashpad process can inherit these descriptors after the app exits.
      // Close our readers at the direct child's exit so the successful smoke does not stay alive
      // waiting for an unrelated crash reporter to close its copy of the pipe.
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (code === 0) resolveProcess({ stdout, stderr })
      else
        rejectProcess(new Error(`${basename(executable)} exited with ${code}.\n${stdout}${stderr}`))
    })
  })

const installDmgApp = async (dmg, mount, installedRoot, run = runProcess) => {
  await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg])
  try {
    const source = await findAppBundle(mount)
    const installed = join(installedRoot, basename(source))
    // Test drag-install semantics, not execution from the compressed read-only image (TN2206).
    await run('/usr/bin/ditto', [source, installed])
    return installed
  } finally {
    await run('/usr/bin/hdiutil', ['detach', '-force', mount])
  }
}

const terminateSpawnedProcessGroup = (child) => {
  if (!child.pid) return
  try {
    // launchAndProbe gives the packaged app a private session. Electron's macOS crashpad handler
    // can outlive its direct parent, so reap that exact test-owned group before removing the mount.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH means every process in the private group has already exited.
  }
}

const assertPackagedResources = async (appBundle) => {
  const resources = join(appBundle, 'Contents', 'Resources')
  const paths = [
    join(appBundle, 'Contents', 'MacOS', 'Open-Science'),
    join(resources, 'app.asar'),
    join(resources, 'backend', 'resources', 'micromamba'),
    // electron-builder compiles build/icon.icon into the adaptive catalog and also emits an ICNS
    // fallback for macOS releases that predate Icon Composer.
    join(resources, 'Assets.car'),
    join(resources, 'icon.icns'),
    join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@aipoch',
      'process-tree-native',
      'build',
      'Release',
      'process_tree_native.node'
    )
  ]
  for (const path of paths) await access(path)
  const prismaRoot = join(resources, 'backend', 'resources', 'prisma-client')
  const engines = await readdir(prismaRoot).catch(() => [])
  const nativeEngines = engines.filter(
    (name) => name.includes('query_engine-') && name.endsWith('.node')
  )
  if (nativeEngines.length !== 1) {
    throw new Error(`Packaged macOS must contain exactly one Prisma engine in ${prismaRoot}.`)
  }
  if (!/^libquery_engine-darwin(?:-arm64)?\.dylib\.node$/.test(nativeEngines[0])) {
    throw new Error(`Packaged macOS Prisma engine is incompatible: ${nativeEngines[0]}.`)
  }
  return { executable: paths[0], micromamba: paths[2], processTreeNative: paths[5] }
}

const packagedLaunchArguments = (userDataRoot) => [
  `--user-data-dir=${userDataRoot}`,
  '--open-science-headless',
  '--serve=0'
]

const readSmokeService = async (output, configRoot) => {
  const logged = await authenticatePackagedAppEndpoint(output, [configRoot])
  if (logged) return logged
  // A stable entry writes runtime stdout to its own private log. Read the actual live service
  // contract instead of requiring the runtime to inherit the launcher's stdout descriptors.
  const state = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
  if (
    !Number.isSafeInteger(state.pid) ||
    !Number.isInteger(state.port) ||
    state.port < 1 ||
    state.port > 65535
  )
    return undefined
  process.kill(state.pid, 0)
  return authenticatePackagedAppEndpoint(`Open-Science Web: http://127.0.0.1:${state.port}/`, [
    configRoot
  ])
}
const findRuntimePid = async (executable, run = runProcess) => {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm='])
  const matches = stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match && match[2] === executable ? [Number(match[1])] : []
  })
  if (matches.length !== 1)
    throw new Error(`Expected one live smoke runtime at ${executable}; found ${matches.length}`)
  return matches[0]
}
const launchAndProbe = async ({
  executable,
  expectedVersion,
  env,
  userDataRoot,
  runtimeExecutable
}) => {
  const started = Date.now()
  let runtimeCleanup
  let ownershipError
  if (runtimeExecutable) {
    if (
      !env.OPEN_SCIENCE_MAC_RUNTIME_ROOT ||
      !runtimeExecutable.startsWith(env.OPEN_SCIENCE_MAC_RUNTIME_ROOT + '/')
    )
      throw new Error('Wrapper smoke runtime must be inside its isolated runtime root')
    const native = createRequire(import.meta.url)('@aipoch/process-tree-native')
    runtimeCleanup = createMacSmokeProcessCleanup(native, resolve(runtimeExecutable, '../../..'))
  }
  const observer = runtimeCleanup
    ? setInterval(() => {
        try {
          runtimeCleanup.capture()
        } catch (error) {
          ownershipError ||= error
        }
      }, 100)
    : undefined
  const child = spawn(executable, packagedLaunchArguments(userDataRoot), {
    detached: true,
    env: { ...env, OPEN_SCIENCE_E2E_NATIVE_SHELL_CERTIFICATION: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += `\n${chunk}`))
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code) => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolveExit(code)
    })
  })

  try {
    const service = await Promise.race([
      waitFor('the packaged macOS web service', async () =>
        runtimeExecutable
          ? readSmokeService(output, env.OPEN_SCIENCE_E2E_STORAGE_ROOT)
          : authenticatePackagedAppEndpoint(output, [env.OPEN_SCIENCE_E2E_STORAGE_ROOT])
      ).catch((error) => {
        // Startup that neither turns healthy nor exits must still surface the captured app output
        // so the underlying reason reaches the job log.
        throw new Error(`${error.message}\n${output}`)
      }),
      exit.then((code) => {
        throw new Error(`Packaged macOS app exited before becoming healthy (${code}).\n${output}`)
      })
    ])
    runtimeCleanup?.capture()
    if (ownershipError) throw ownershipError
    const desktopPid = runtimeExecutable ? await findRuntimePid(runtimeExecutable) : child.pid
    console.log(`macOS smoke: endpoint ready; elapsedMs=${Date.now() - started}`)
    const response = await fetch(`${service.endpoint}/api/bootstrap?${service.auth}`, {
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`Packaged macOS bootstrap returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    if (
      bootstrap.appName !== 'Open-Science' ||
      bootstrap.appVersion !== expectedVersion ||
      bootstrap.platform !== 'darwin' ||
      bootstrap.configRoot !== env.OPEN_SCIENCE_E2E_STORAGE_ROOT
    ) {
      throw new Error(`Unexpected packaged macOS bootstrap: ${JSON.stringify(bootstrap)}`)
    }
    const shellCertification = JSON.parse(
      await readFile(
        join(env.OPEN_SCIENCE_E2E_STORAGE_ROOT, 'native-shell-certification.json'),
        'utf8'
      )
    )
    if (shellCertification.status !== 'passed') {
      throw new Error('Packaged macOS native shell lifecycle certification failed.')
    }
    console.log(
      `macOS smoke: bootstrap and native shell verified; elapsedMs=${Date.now() - started}`
    )
    const shutdown = await fetch(`${service.endpoint}/api/shutdown?${service.auth}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000)
    })
    await shutdown.text()
    if (shutdown.status !== 202) {
      throw new Error(`Packaged macOS shutdown returned ${shutdown.status}.`)
    }
    const shutdownStarted = Date.now()
    const exitCode = await Promise.race([
      exit,
      delay(60_000).then(() => {
        throw new Error('Packaged macOS app did not exit after shutdown.')
      })
    ])
    if (observer) clearInterval(observer)
    if (runtimeCleanup) await runtimeCleanup.reap()
    else terminateSpawnedProcessGroup(child)
    if (exitCode !== 0) throw new Error(`Packaged macOS app exited with ${exitCode}.\n${output}`)
    console.log(
      `macOS smoke: clean exit; shutdownMs=${Date.now() - shutdownStarted}; elapsedMs=${Date.now() - started}`
    )
    return await readDesktopSqliteVersion(env.OPEN_SCIENCE_E2E_STORAGE_ROOT, desktopPid)
  } catch (error) {
    let diagnostics
    try {
      diagnostics = await collectSmokeDiagnostics({
        configRoot: env.OPEN_SCIENCE_E2E_STORAGE_ROOT,
        pid: child.pid,
        desktop: true
      })
    } catch (cause) {
      diagnostics = `Smoke diagnostics unavailable: ${cause.message}`
    }
    if (observer) clearInterval(observer)
    let cleanupError
    try {
      if (runtimeCleanup) await runtimeCleanup.reap()
    } catch (cause) {
      cleanupError = cause
    }
    child.kill('SIGKILL')
    if (!runtimeCleanup) terminateSpawnedProcessGroup(child)
    if (cleanupError) {
      const unresolved = new Error(
        `${error.message}\n${diagnostics}\nSmoke cleanup failed: ${cleanupError.message}`,
        { cause: cleanupError }
      )
      unresolved.preserveSmokeRoot = true
      throw unresolved
    }
    throw new Error(`${error.message}\n${diagnostics}`, { cause: error })
  } finally {
    if (observer) clearInterval(observer)
  }
}

const readWrapperConfiguration = async (appBundle) => {
  try {
    const resources = join(appBundle, 'Contents/Resources')
    const config = JSON.parse(await readFile(join(resources, 'mac-recovery-entry.json'), 'utf8'))
    const seed = await readFile(join(resources, 'runtime-seed.zip'))
    if (
      config.schema !== 1 ||
      config.runtimeBundleIdentifier !== 'com.aipoch.open-science' ||
      typeof config.seedVersion !== 'string' ||
      !config.runtimeRequirement ||
      createHash('sha512').update(seed).digest('base64') !== config.seedSha512
    )
      throw new Error('Invalid stable entry configuration or runtime seed')
    for (const file of [
      'mac-recovery-control.cjs',
      'icon.icns',
      'Assets.car',
      // The stable entry seals only the JS shim. Recovery pairs target Node with the native
      // addon from that same verified target, so a Rosetta source cannot load its own x64 addon.
      'node_modules/@aipoch/process-tree-native/package.json',
      'node_modules/@aipoch/process-tree-native/index.cjs'
    ])
      await access(join(resources, file))
    return config
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await access(join(appBundle, 'Contents/Resources/mac-recovery-entry.json'))
      } catch (missing) {
        if (missing.code === 'ENOENT') return undefined
        throw missing
      }
    }
    throw error
  }
}
const smokeAppBundle = async ({
  appBundle,
  expectedVersion,
  env,
  gatekeeper,
  userDataRoot,
  storageRoot,
  expectLegacyProject = true,
  launches = 1
}) => {
  console.log(
    `macOS smoke: ${appBundle}; profile=${storageRoot}; Gatekeeper=${gatekeeper}; launches=${launches}`
  )
  await runProcess(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appBundle],
    {
      env
    }
  )
  if (gatekeeper) {
    await runProcess(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=4', appBundle],
      {
        env
      }
    )
  }
  const wrapper = await readWrapperConfiguration(appBundle)
  let checkedBundle = appBundle
  let runtimeExecutable
  let inspection
  const launchEnv = { ...env }
  if (wrapper) {
    if (wrapper.seedVersion !== expectedVersion)
      throw new Error('Ordinary entry seed version differs from its release')
    inspection = await mkdtemp(join(env.OPEN_SCIENCE_MAC_RUNTIME_ROOT, 'seed-inspection-'))
    await runProcess(
      '/usr/bin/ditto',
      ['-x', '-k', join(appBundle, 'Contents/Resources/runtime-seed.zip'), inspection],
      { env }
    )
    checkedBundle = await findAppBundle(inspection)
    await runProcess('/usr/bin/codesign', ['--verify', '--deep', '--strict', checkedBundle], {
      env
    })
    if (gatekeeper)
      await runProcess(
        '/usr/sbin/spctl',
        ['--assess', '--type', 'execute', '--verbose=4', checkedBundle],
        { env }
      )
    const canonical = await realpath(appBundle)
    const key = createHash('sha256').update(canonical).digest('hex')
    runtimeExecutable = join(
      env.OPEN_SCIENCE_MAC_RUNTIME_ROOT,
      key,
      'Open-Science.app/Contents/MacOS/Open-Science'
    )
  }
  const {
    executable: inspectedExecutable,
    micromamba,
    processTreeNative
  } = await assertPackagedResources(checkedBundle)
  await runProcess(micromamba, ['--version'], { env })
  await runProcess(
    inspectedExecutable,
    [
      '-e',
      'const binding=require(process.env.OPEN_SCIENCE_PROCESS_TREE_NATIVE);const table=binding.listDarwinProcesses();const self=binding.getDarwinProcess(process.pid);if(!table?.complete||!self||self.pid!==process.pid)process.exit(1)'
    ],
    {
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        OPEN_SCIENCE_PROCESS_TREE_NATIVE: processTreeNative
      }
    }
  )
  // The ordinary app is the stable entry. Runtime-only archives are separately launched below as
  // an internal payload smoke, never reported as an ordinary-entry or update-acceptance result.
  const executable = wrapper ? join(appBundle, 'Contents/MacOS/Open-Science') : inspectedExecutable
  const sqliteVersions = []
  for (let launch = 0; launch < launches; launch += 1) {
    console.log(`macOS smoke: launch ${launch + 1}/${launches}`)
    sqliteVersions.push(
      await launchAndProbe({
        executable,
        expectedVersion,
        env: launchEnv,
        userDataRoot,
        runtimeExecutable
      })
    )
  }
  if (runtimeExecutable) await assertPackagedResources(join(runtimeExecutable, '../../..'))
  if (inspection) await rm(inspection, { recursive: true, force: true })
  await verifyDatabaseMigrationLedger(storageRoot)
  if (expectLegacyProject) await verifyLegacyProjectPreserved(storageRoot)
  return sqliteVersions
}

const parseArguments = (argv) => {
  const index = argv.indexOf('--artifact-dir')
  const artifactDirectory = index === -1 ? undefined : argv[index + 1]
  if (!artifactDirectory) {
    throw new Error('Usage: --artifact-dir <path> [--gatekeeper]')
  }
  return {
    artifactDirectory: resolve(artifactDirectory),
    gatekeeper: argv.includes('--gatekeeper')
  }
}

const main = async () => {
  if (process.platform !== 'darwin') throw new Error('macOS package smoke requires macOS.')
  const options = parseArguments(process.argv.slice(2))
  const [dmg, zip, runtimeZip] = await Promise.all([
    findArtifact(options.artifactDirectory, 'dmg'),
    findArtifact(options.artifactDirectory, 'zip'),
    findArtifact(options.artifactDirectory, 'zip', 'runtime')
  ])
  const expectedVersion = artifactVersion(dmg)
  if (artifactVersion(zip) !== expectedVersion || artifactVersion(runtimeZip) !== expectedVersion) {
    throw new Error('macOS DMG and ZIP versions do not match.')
  }

  const root = await realpath(
    await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  )
  const mount = join(root, 'dmg-mount')
  const extracted = join(root, 'zip-extracted')
  const storageRoot = join(root, 'legacy storage 数据')
  const freshStorageRoot = join(root, 'fresh storage 数据')
  const userDataRoot = join(root, 'legacy Electron profile 数据')
  const freshUserDataRoot = join(root, 'fresh Electron profile 数据')
  const env = {
    ...process.env,
    OPEN_SCIENCE_E2E_STORAGE_ROOT: storageRoot,
    OPEN_SCIENCE_MAC_RUNTIME_ROOT: join(root, 'runtimes'),
    OPEN_SCIENCE_INSTALLATION_STATE_ROOT: join(root, 'installations')
  }

  let preserveRoot = false
  try {
    const sqliteVersions = []
    await Promise.all([
      mkdir(mount),
      mkdir(extracted),
      mkdir(storageRoot),
      mkdir(freshStorageRoot),
      mkdir(env.OPEN_SCIENCE_MAC_RUNTIME_ROOT)
    ])
    await seedLegacyDatabase(storageRoot)
    if (options.gatekeeper) {
      await runProcess(
        '/usr/sbin/spctl',
        [
          '--assess',
          '--type',
          'open',
          '--context',
          'context:primary-signature',
          '--verbose=4',
          dmg
        ],
        { env }
      )
    }
    const installedApp = await installDmgApp(dmg, mount, join(root, 'dmg-installed'))
    sqliteVersions.push(
      ...(await smokeAppBundle({
        appBundle: installedApp,
        expectedVersion,
        env,
        gatekeeper: options.gatekeeper,
        userDataRoot,
        storageRoot
      }))
    )

    await runProcess('/usr/bin/ditto', ['-x', '-k', zip, extracted], { env })
    const zipAppBundle = await findAppBundle(extracted)
    sqliteVersions.push(
      ...(await smokeAppBundle({
        appBundle: zipAppBundle,
        expectedVersion,
        env,
        gatekeeper: options.gatekeeper,
        userDataRoot,
        storageRoot
      }))
    )
    sqliteVersions.push(
      ...(await smokeAppBundle({
        appBundle: zipAppBundle,
        expectedVersion,
        env: { ...env, OPEN_SCIENCE_E2E_STORAGE_ROOT: freshStorageRoot },
        gatekeeper: false,
        userDataRoot: freshUserDataRoot,
        storageRoot: freshStorageRoot,
        expectLegacyProject: false,
        launches: 2
      }))
    )
    const payloadRoot = join(root, 'runtime-payload')
    await mkdir(payloadRoot)
    await runProcess('/usr/bin/ditto', ['-x', '-k', runtimeZip, payloadRoot], { env })
    const payload = await findAppBundle(payloadRoot)
    if (await readWrapperConfiguration(payload))
      throw new Error('Squirrel payload ZIP must contain the runtime, not the ordinary entry')
    sqliteVersions.push(
      ...(await smokeAppBundle({
        appBundle: payload,
        expectedVersion,
        env,
        gatekeeper: options.gatekeeper,
        userDataRoot,
        storageRoot
      }))
    )
    await writeDatabaseMigrationCertification({
      output: join(options.artifactDirectory, 'database-migration-certification.json'),
      sqliteVersions,
      checks: {
        freshInstall: 'passed',
        legacyAdoption: 'passed',
        reopen: 'passed',
        specialPath: 'passed'
      }
    })
    console.log('macOS DMG and ZIP launch smoke completed successfully.')
  } catch (error) {
    preserveRoot = error.preserveSmokeRoot === true
    throw error
  } finally {
    if (preserveRoot)
      console.error(`Smoke process cleanup was not proven; preserved isolated root: ${root}`)
    else await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  void main().then(
    () => {
      // Prisma/fetch or a detached Electron crash reporter may retain a libuv handle after every
      // asserted launch has shut down. Flush the success line, then end this finite smoke command.
      process.stdout.write('', () => process.exit(0))
    },
    (error) => {
      console.error(error)
      process.stderr.write('', () => process.exit(1))
    }
  )
}

export {
  authenticatePackagedAppEndpoint,
  artifactVersion,
  assertPackagedResources,
  findAppBundle,
  findArtifact,
  findRuntimePid,
  readWrapperConfiguration,
  readSmokeService,
  installDmgApp,
  launchAndProbe,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint
}
