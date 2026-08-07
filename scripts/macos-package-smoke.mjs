/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ARTIFACT_PATTERN = /^aipoch-open-science-(.+)-mac-(?:arm64|x64)\.(dmg|zip)$/
const SMOKE_ROOT_PREFIX = 'open-science-macos-package-smoke-'
const STARTUP_TIMEOUT_MS = 60_000

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const findArtifact = async (directory, extension) => {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(`.${extension}`))
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
    /Open Science Web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/
  )
  if (!match) return undefined
  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  return token ? { endpoint: url.origin, auth: `token=${encodeURIComponent(token)}` } : undefined
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
      if (code === 0) resolveProcess({ stdout, stderr })
      else
        rejectProcess(new Error(`${basename(executable)} exited with ${code}.\n${stdout}${stderr}`))
    })
  })

const assertPackagedResources = async (appBundle) => {
  const resources = join(appBundle, 'Contents', 'Resources')
  const paths = [
    join(appBundle, 'Contents', 'MacOS', 'Open Science'),
    join(resources, 'app.asar'),
    join(resources, 'micromamba'),
    // electron-builder compiles build/icon.icon into the adaptive catalog and also emits an ICNS
    // fallback for macOS releases that predate Icon Composer.
    join(resources, 'Assets.car'),
    join(resources, 'icon.icns')
  ]
  for (const path of paths) await access(path)
  return { executable: paths[0], micromamba: paths[2] }
}

const packagedLaunchArguments = (userDataRoot) => [
  `--user-data-dir=${userDataRoot}`,
  '--open-science-headless',
  '--serve=0'
]

const launchAndProbe = async ({ executable, expectedVersion, env, userDataRoot }) => {
  const child = spawn(executable, packagedLaunchArguments(userDataRoot), {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += `\n${chunk}`))
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })

  try {
    const service = await Promise.race([
      waitFor('the packaged macOS web service', async () => parsePackagedAppEndpoint(output)),
      exit.then((code) => {
        throw new Error(`Packaged macOS app exited before becoming healthy (${code}).\n${output}`)
      })
    ])
    const response = await fetch(`${service.endpoint}/api/bootstrap?${service.auth}`, {
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`Packaged macOS bootstrap returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    if (
      bootstrap.appName !== 'Open Science' ||
      bootstrap.appVersion !== expectedVersion ||
      bootstrap.platform !== 'darwin'
    ) {
      throw new Error(`Unexpected packaged macOS bootstrap: ${JSON.stringify(bootstrap)}`)
    }
    const shutdown = await fetch(`${service.endpoint}/api/shutdown?${service.auth}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000)
    })
    await shutdown.text()
    if (shutdown.status !== 202) {
      throw new Error(`Packaged macOS shutdown returned ${shutdown.status}.`)
    }
    const exitCode = await Promise.race([
      exit,
      delay(60_000).then(() => {
        throw new Error('Packaged macOS app did not exit after shutdown.')
      })
    ])
    if (exitCode !== 0) throw new Error(`Packaged macOS app exited with ${exitCode}.\n${output}`)
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

const smokeAppBundle = async ({ appBundle, expectedVersion, env, gatekeeper, userDataRoot }) => {
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
  const { executable, micromamba } = await assertPackagedResources(appBundle)
  await runProcess(micromamba, ['--version'], { env })
  await launchAndProbe({ executable, expectedVersion, env, userDataRoot })
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
  const [dmg, zip] = await Promise.all([
    findArtifact(options.artifactDirectory, 'dmg'),
    findArtifact(options.artifactDirectory, 'zip')
  ])
  const expectedVersion = artifactVersion(dmg)
  if (artifactVersion(zip) !== expectedVersion) {
    throw new Error('macOS DMG and ZIP versions do not match.')
  }

  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const mount = join(root, 'dmg-mount')
  const extracted = join(root, 'zip-extracted')
  const storageRoot = join(root, 'storage')
  const userDataRoot = join(root, 'electron-profile')
  const env = {
    ...process.env,
    OPEN_SCIENCE_E2E_STORAGE_ROOT: storageRoot
  }

  try {
    await Promise.all([mkdir(mount), mkdir(extracted), mkdir(storageRoot)])
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
    await runProcess('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mount,
      dmg
    ])
    try {
      await smokeAppBundle({
        appBundle: await findAppBundle(mount),
        expectedVersion,
        env,
        gatekeeper: false,
        userDataRoot
      })
    } finally {
      await runProcess('/usr/bin/hdiutil', ['detach', '-force', mount])
    }

    await runProcess('/usr/bin/ditto', ['-x', '-k', zip, extracted], { env })
    await smokeAppBundle({
      appBundle: await findAppBundle(extracted),
      expectedVersion,
      env,
      gatekeeper: options.gatekeeper,
      userDataRoot
    })
    console.log('macOS DMG and ZIP launch smoke completed successfully.')
  } finally {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
  }
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
  artifactVersion,
  assertPackagedResources,
  findAppBundle,
  findArtifact,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint
}
