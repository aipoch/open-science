/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { dump, load } from 'js-yaml'
import { _electron as electron } from 'playwright'

import {
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  findSetupInstaller,
  installerVersion,
  installAndProbe,
  launchAndProbe,
  runProcess,
  uninstallAndVerify,
  waitFor,
  windowsProfileEnvironment
} from './windows-installer-smoke.mjs'

const UPDATE_TIMEOUT_MS = 180_000
const SMOKE_ROOT_PREFIX = 'open-science-installer-smoke-updater-'

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
    output: resolve(output)
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
  const config = {
    ...parsed,
    provider: 'generic',
    url,
    channel: 'latest',
    useMultipleRangeRequest: false
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
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
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

const runElectronUpdater = async ({ executable, env, expectedVersion }) => {
  const application = await electron.launch({ executablePath: executable, env, timeout: 60_000 })
  try {
    const page = await application.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean(globalThis.window?.api?.update), undefined, {
      timeout: 60_000
    })
    const checked = await withTimeout(
      page.evaluate(() => globalThis.window.api.update.check()),
      'electron-updater check'
    )
    if (checked.state !== 'available' || checked.latest !== expectedVersion) {
      throw new Error(`Unexpected updater check result: ${JSON.stringify(checked)}`)
    }
    const downloaded = await withTimeout(
      page.evaluate(() => globalThis.window.api.update.download()),
      'electron-updater differential download'
    )
    if (downloaded.state !== 'ready' || downloaded.applyKind !== 'restart') {
      throw new Error(`Unexpected updater download result: ${JSON.stringify(downloaded)}`)
    }

    const closed = withTimeout(application.waitForEvent('close'), 'electron-updater restart')
    await page.evaluate(() => {
      void globalThis.window.api.update.apply()
    })
    await closed
  } catch (error) {
    await application.close().catch(() => {})
    throw error
  }
}

const executableVersion = async (executable, env) => {
  const result = await runProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::Out.Write((Get-Item -LiteralPath $args[0]).VersionInfo.ProductVersion)',
      executable
    ],
    { allowNonZero: true, env, timeoutMs: 10_000 }
  )
  if (result.code !== 0) return undefined
  return result.stdout.trim()
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
  const env = windowsProfileEnvironment(profileDirectory)
  const legacyConfigRoots = [
    win32.join(homedir(), '.open-science'),
    win32.join(profileDirectory, '.open-science')
  ]
  const profileGuard = createUpgradeProfileGuard(true, `updater-${randomUUID()}`)
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true })
  ])

  let installed = false
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

    await runElectronUpdater({
      executable: join(installDirectory, 'open-science.exe'),
      env,
      expectedVersion: currentVersion
    })
    const installerBytes = (await stat(currentInstaller)).size
    observation = assertDifferentialObservation({
      schemaVersion: 1,
      mode: 'electron-updater-differential',
      previousVersion,
      currentVersion,
      installerBytes,
      ...assetServer.metrics,
      versionedFeed: true,
      previousInstallerCacheVerified: true
    })

    await waitFor(
      `installed version ${currentVersion}`,
      async () =>
        (await executableVersion(join(installDirectory, 'open-science.exe'), env))?.startsWith(
          currentVersion
        ),
      UPDATE_TIMEOUT_MS
    )
    await runProcess('taskkill.exe', ['/IM', 'open-science.exe', '/T', '/F'], {
      allowNonZero: true,
      env,
      timeoutMs: 10_000
    })
    const currentConfigRoot = await launchAndProbe({
      installDirectory,
      expectedVersion: currentVersion,
      env
    })
    await profileGuard.verifyCycle('current', currentConfigRoot)
    await writeFile(options.output, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')
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
    }
  }
  await cleanup(() =>
    runProcess('taskkill.exe', ['/IM', 'open-science.exe', '/T', '/F'], {
      allowNonZero: true,
      env,
      timeoutMs: 10_000
    })
  )
  if (assetServer) await cleanup(() => assetServer.close())
  await cleanup(() => profileGuard.cleanup(primaryError))
  if (installed) await cleanup(() => uninstallAndVerify(installDirectory, env))
  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))
  if (primaryError) throw primaryError
  if (cleanupErrors[0]) throw cleanupErrors[0]
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
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  parseArguments,
  parseSingleRange,
  rewriteFeedPaths
}
