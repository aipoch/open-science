/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_EXECUTABLE = 'open-science.exe'
const CONFIG_DIRECTORY = '.open-science'
const PROCESS_TIMEOUT_MS = 120_000
const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 60_000
const HTTP_REQUEST_TIMEOUT_MS = 15_000
const TERMINATION_TIMEOUT_MS = 10_000
const SMOKE_ROOT_PREFIX = 'open-science-installer-smoke-'
const UPGRADE_SENTINEL_PREFIX = 'installer-smoke-upgrade-sentinel-'
const UPGRADE_SENTINEL_CONTENT = 'previous-version-profile-preserved\n'

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const pathExists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const findSetupInstaller = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && /-win-x64-setup\.exe$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one Windows setup executable in ${directory}; found ${candidates.length}.`
    )
  }
  return candidates[0]
}

const installerVersion = (installer) => {
  const match = basename(installer).match(/^aipoch-open-science-(.+)-win-x64-setup\.exe$/i)
  if (!match) throw new Error(`Cannot derive the app version from installer: ${installer}`)
  return match[1]
}

const buildSmokePlan = ({ currentInstaller, previousInstaller }) => [
  ...(previousInstaller ? [{ installer: previousInstaller, phase: 'previous' }] : []),
  { installer: currentInstaller, phase: 'current' }
]

const executeSmokePlan = async (plan, runCycle) => {
  for (const cycle of plan) await runCycle(cycle)
}

const fetchWithTimeout = (
  input,
  init = {},
  timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch
) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })

const requestPackagedAppShutdown = async (endpoint, auth, fetchImpl = fetchWithTimeout) => {
  const response = await fetchImpl(`${endpoint}/api/shutdown?${auth}`, { method: 'POST' })
  // Drain the response before waiting for Electron to exit. Leaving an Undici response body unread
  // keeps its HTTP connection active, while the app's quit path waits for the web server to close.
  // Waiting for exit first would therefore deadlock the smoke harness against the app under test.
  const body = await response.text()
  if (response.status !== 202) {
    throw new Error(
      `Installed app shutdown returned HTTP ${response.status}.${body ? ` ${body}` : ''}`
    )
  }
}

const parsePackagedAppEndpoint = (output) => {
  const match = output.match(
    /Open Science Web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/
  )
  if (!match) return undefined

  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  if (!token) return undefined
  return {
    endpoint: url.origin,
    auth: `token=${encodeURIComponent(token)}`
  }
}

const readPackagedAppConfigRoot = async (
  bootstrap,
  expectedVersion,
  { auth, legacyConfigRoots = [], readToken = readFile } = {}
) => {
  if (
    bootstrap.appName !== 'Open Science' ||
    bootstrap.appVersion !== expectedVersion ||
    bootstrap.platform !== 'win32'
  ) {
    throw new Error(`Unexpected installed app bootstrap: ${JSON.stringify(bootstrap)}`)
  }
  if (bootstrap.configRoot !== undefined) {
    if (typeof bootstrap.configRoot !== 'string' || !win32.isAbsolute(bootstrap.configRoot)) {
      throw new Error('Installed app did not report an absolute Windows config root.')
    }
    return bootstrap.configRoot
  }

  const candidates = [
    ...new Map(
      legacyConfigRoots
        .filter((candidate) => typeof candidate === 'string' && win32.isAbsolute(candidate))
        .map((candidate) => [win32.resolve(candidate).toLowerCase(), candidate])
    ).values()
  ]
  if (candidates.length === 0) {
    throw new Error('Installed app did not report an absolute Windows config root.')
  }
  const endpointToken = auth ? new URLSearchParams(auth).get('token') : undefined
  if (!endpointToken) {
    throw new Error('Cannot authenticate the legacy installed app config root without its token.')
  }
  // Older packaged builds do not report configRoot. Electron has ignored the child USERPROFILE in
  // hosted runs, but retain the isolated profile as a compatibility candidate. The endpoint token
  // authenticates whichever directory the previous app actually used instead of trusting either.
  for (const candidate of candidates) {
    try {
      const storedToken = (await readToken(win32.join(candidate, 'web-token'), 'utf8')).trim()
      if (storedToken === endpointToken) return candidate
    } catch {
      // Try the next authenticated candidate.
    }
  }
  throw new Error('Cannot authenticate the legacy installed app config root from its token file.')
}

const terminateProcessTree = async (
  child,
  timeoutMs = TERMINATION_TIMEOUT_MS,
  spawnProcess = spawn
) => {
  if (!child.pid) return
  const killDirectly = () => {
    try {
      child.kill()
    } catch {
      // Best effort: the process may already have exited between the timeout and fallback.
    }
  }
  let terminator
  try {
    terminator = spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    killDirectly()
    return
  }
  await new Promise((resolveTermination) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveTermination()
    }
    const timer = setTimeout(() => {
      try {
        terminator.kill()
      } catch {
        // The taskkill process may have exited without delivering its event yet.
      }
      terminator.unref?.()
      killDirectly()
      finish()
    }, timeoutMs)
    terminator.once('error', () => {
      killDirectly()
      finish()
    })
    terminator.once('exit', (code) => {
      if (code !== 0 && code !== null) killDirectly()
      finish()
    })
  })
}

const runProcess = (executable, args, options = {}, terminate = terminateProcessTree) =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectProcess(error)
      else resolveProcess({ code, stdout, stderr })
    }

    const timer = setTimeout(() => {
      timedOut = true
      const finishTimeout = () => {
        finish(
          new Error(
            `${basename(executable)} timed out after ${options.timeoutMs ?? PROCESS_TIMEOUT_MS}ms.`
          )
        )
      }
      void Promise.resolve()
        .then(() => terminate(child))
        .then(finishTimeout, finishTimeout)
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS)

    child.once('error', (error) => {
      if (!timedOut) finish(error)
    })
    child.once('exit', (code) => {
      if (timedOut) return
      if (code !== 0 && !options.allowNonZero) {
        finish(
          new Error(
            `${basename(executable)} exited with ${code}.\n${stdout}${stderr ? `\n${stderr}` : ''}`
          )
        )
        return
      }
      finish(undefined, code)
    })
  })

const waitFor = async (description, check, timeoutMs = STARTUP_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== undefined && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(
    `Timed out waiting for ${description}.${lastError instanceof Error ? ` ${lastError.message}` : ''}`
  )
}

const observeChildExit = (child) =>
  new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })

const waitForShutdownExit = (
  exit,
  child,
  output,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  terminate = terminateProcessTree
) =>
  new Promise((resolveExit, rejectExit) => {
    let settled = false
    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectExit(error)
      else resolveExit(code)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void terminate(child).finally(() => {
        rejectExit(new Error(`Installed app did not exit after shutdown.\n${output()}`))
      })
    }, timeoutMs)
    exit.then(
      (code) => finish(undefined, code),
      (error) => finish(error)
    )
  })

const packagedResourcePaths = (installDirectory) => [
  join(installDirectory, APP_EXECUTABLE),
  join(installDirectory, 'resources', 'app.asar'),
  join(installDirectory, 'resources', 'micromamba.exe'),
  join(
    installDirectory,
    'resources',
    'node_modules',
    '.prisma',
    'client',
    'query_engine-windows.dll.node'
  )
]

const windowsProfileEnvironment = (profileDirectory, baseEnvironment = process.env) => {
  const temporaryDirectory = join(profileDirectory, 'Temp')
  return {
    ...baseEnvironment,
    HOME: profileDirectory,
    USERPROFILE: profileDirectory,
    APPDATA: join(profileDirectory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(profileDirectory, 'AppData', 'Local'),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory
  }
}

const assertPackagedResources = async (installDirectory) => {
  for (const path of packagedResourcePaths(installDirectory)) {
    if (!(await pathExists(path))) throw new Error(`Packaged Windows resource is missing: ${path}`)
  }
}

const upgradeSentinelPath = (configRoot, sentinelName) => join(configRoot, sentinelName)

const writeUpgradeSentinel = async (configRoot, sentinelName) => {
  await mkdir(configRoot, { recursive: true })
  await writeFile(upgradeSentinelPath(configRoot, sentinelName), UPGRADE_SENTINEL_CONTENT, {
    encoding: 'utf8',
    flag: 'wx'
  })
}

const assertUpgradeProfilePreserved = async (configRoot, sentinelName) => {
  let content
  try {
    content = await readFile(upgradeSentinelPath(configRoot, sentinelName), 'utf8')
  } catch {
    throw new Error('The Windows upgrade did not preserve the previous application profile.')
  }
  if (content !== UPGRADE_SENTINEL_CONTENT) {
    throw new Error('The Windows upgrade did not preserve the previous application profile.')
  }
}

const createUpgradeProfileGuard = (
  enabled,
  sentinelName = `${UPGRADE_SENTINEL_PREFIX}${randomUUID()}`
) => {
  let previousConfigRoot
  let sentinelCreated = false

  const verifyCycle = async (phase, configRoot) => {
    if (!enabled) return
    if (phase === 'previous') {
      previousConfigRoot = configRoot
      await writeUpgradeSentinel(configRoot, sentinelName)
      sentinelCreated = true
      return
    }
    if (!previousConfigRoot) {
      throw new Error('The Windows upgrade did not report the previous application config root.')
    }
    if (resolve(previousConfigRoot).toLowerCase() !== resolve(configRoot).toLowerCase()) {
      throw new Error(
        `The Windows upgrade config root changed from ${previousConfigRoot} to ${configRoot}.`
      )
    }
    await assertUpgradeProfilePreserved(configRoot, sentinelName)
  }

  const cleanup = async (primaryError) => {
    if (!sentinelCreated || !previousConfigRoot) return
    try {
      await rm(upgradeSentinelPath(previousConfigRoot, sentinelName), { force: true })
      sentinelCreated = false
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      console.warn(`Windows upgrade sentinel cleanup also failed: ${message}`)
    }
  }

  return { cleanup, verifyCycle }
}

const launchAndProbe = async ({ installDirectory, expectedVersion, env, legacyConfigRoots }) => {
  const executable = join(installDirectory, APP_EXECUTABLE)

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
  const exit = observeChildExit(child)

  try {
    const { endpoint, auth } = await Promise.race([
      waitFor('the installed app web service', async () => {
        return parsePackagedAppEndpoint(output())
      }),
      exit.then((code) => {
        throw new Error(`Installed app exited before becoming healthy (${code}).\n${output()}`)
      })
    ])
    const response = await fetchWithTimeout(`${endpoint}/api/bootstrap?${auth}`)
    if (!response.ok)
      throw new Error(`Installed app health probe returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    const configRoot = await readPackagedAppConfigRoot(bootstrap, expectedVersion, {
      auth,
      legacyConfigRoots
    })

    await requestPackagedAppShutdown(endpoint, auth)
    const exitCode = await waitForShutdownExit(exit, child, output)
    if (exitCode !== 0) throw new Error(`Installed app exited with ${exitCode}.\n${output()}`)
    return configRoot
  } catch (error) {
    await terminateProcessTree(child)
    const processOutput = output().trim()
    if (error instanceof Error && processOutput && !error.message.includes(processOutput)) {
      error.message += `\n${processOutput}`
    }
    throw error
  }
}

const installAndProbe = async ({ installer, installDirectory, phase, env, legacyConfigRoots }) => {
  console.log(`Smoke testing ${phase} installer: ${basename(installer)}`)
  await runProcess(installer, ['/S', `/D=${installDirectory}`], { env })
  await assertPackagedResources(installDirectory)
  await runProcess(join(installDirectory, 'resources', 'micromamba.exe'), ['--version'], { env })
  return launchAndProbe({
    installDirectory,
    expectedVersion: installerVersion(installer),
    env,
    legacyConfigRoots
  })
}

const findUninstaller = async (installDirectory) => {
  const names = await readdir(installDirectory)
  const uninstallers = names.filter((name) => /^Uninstall .+\.exe$/i.test(name))
  if (uninstallers.length !== 1) {
    throw new Error(`Expected one Windows uninstaller; found ${uninstallers.length}.`)
  }
  return join(installDirectory, uninstallers[0])
}

const uninstallAndVerify = async (installDirectory, env) => {
  const uninstaller = await findUninstaller(installDirectory)
  const installedPaths = [...packagedResourcePaths(installDirectory), uninstaller]
  const result = await runProcess(uninstaller, ['/S', '/KEEP_APP_DATA'], {
    allowNonZero: true,
    env
  })
  await waitFor('the installed application files to be removed', async () => {
    const pathsRemain = (await Promise.all(installedPaths.map(pathExists))).some(Boolean)
    if (pathsRemain) return undefined
    if (!(await pathExists(installDirectory))) return true
    return (await readdir(installDirectory)).length === 0 || undefined
  })
  if (result.code !== 0) {
    console.warn(`Uninstaller reported ${result.code} after removing the application files.`)
  }
}

const parseArguments = (argv) => {
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const installerDirectory = valueFor('--installer-dir')
  if (!installerDirectory)
    throw new Error('Usage: --installer-dir <path> [--previous-installer-dir <path>]')
  return {
    installerDirectory: resolve(installerDirectory),
    previousInstallerDirectory: valueFor('--previous-installer-dir')
      ? resolve(valueFor('--previous-installer-dir'))
      : undefined
  }
}

const removeSmokeRoot = async (root) => {
  if (!basename(root).startsWith(SMOKE_ROOT_PREFIX)) {
    throw new Error(`Refusing to remove unexpected smoke root: ${root}`)
  }
  await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 500 })
}

const cleanupSmokeRoot = async (root, primaryError, remove = removeSmokeRoot) => {
  try {
    await remove(root)
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    console.warn(`Windows installer smoke cleanup also failed: ${message}`)
  }
}

const main = async () => {
  if (process.platform !== 'win32') throw new Error('Windows installer smoke requires Windows.')
  const options = parseArguments(process.argv.slice(2))
  const currentInstaller = await findSetupInstaller(options.installerDirectory)
  const previousInstaller = options.previousInstallerDirectory
    ? await findSetupInstaller(options.previousInstallerDirectory)
    : undefined
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const installDirectory = join(root, 'app')
  const profileDirectory = join(root, 'profile')
  const legacyConfigRoots = [
    win32.join(homedir(), CONFIG_DIRECTORY),
    win32.join(profileDirectory, CONFIG_DIRECTORY)
  ]
  const env = windowsProfileEnvironment(profileDirectory)
  const upgradeProfileGuard = createUpgradeProfileGuard(Boolean(previousInstaller))
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true })
  ])

  let primaryError
  try {
    await executeSmokePlan(
      buildSmokePlan({ currentInstaller, previousInstaller }),
      async (cycle) => {
        const configRoot = await installAndProbe({
          ...cycle,
          installDirectory,
          env,
          legacyConfigRoots: cycle.phase === 'previous' ? legacyConfigRoots : undefined
        })
        await upgradeProfileGuard.verifyCycle(cycle.phase, configRoot)
      }
    )
    await uninstallAndVerify(installDirectory, env)
    console.log('Windows installer smoke completed successfully.')
  } catch (error) {
    primaryError = error
  }

  let sentinelCleanupError
  try {
    await upgradeProfileGuard.cleanup(primaryError)
  } catch (error) {
    sentinelCleanupError = error
  }
  await cleanupSmokeRoot(root, primaryError ?? sentinelCleanupError)
  if (primaryError) throw primaryError
  if (sentinelCleanupError) throw sentinelCleanupError
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
  assertUpgradeProfilePreserved,
  buildSmokePlan,
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  executeSmokePlan,
  fetchWithTimeout,
  findSetupInstaller,
  installerVersion,
  packagedResourcePaths,
  parsePackagedAppEndpoint,
  readPackagedAppConfigRoot,
  requestPackagedAppShutdown,
  runProcess,
  terminateProcessTree,
  waitForShutdownExit,
  windowsProfileEnvironment,
  writeUpgradeSentinel
}
