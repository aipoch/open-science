/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { access, chmod, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const APPIMAGE_PATTERN = /^aipoch-open-science-(.+)-linux-x86_64\.AppImage$/
const SMOKE_ROOT_PREFIX = 'open-science-linux-package-smoke-'
const STARTUP_TIMEOUT_MS = 60_000

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const findOne = async (directory, pattern, description) => {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name))
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description} in ${directory}; found ${matches.length}.`)
  }
  return matches[0]
}

const appImageVersion = (path) => {
  const match = basename(path).match(APPIMAGE_PATTERN)
  if (!match) throw new Error(`Cannot derive the app version from AppImage: ${path}`)
  return match[1]
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

const pathExists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
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

const packagedResourcePaths = (
  executable,
  resourceRoot = join(dirname(executable), 'resources')
) => {
  return [executable, join(resourceRoot, 'app.asar'), join(resourceRoot, 'micromamba')]
}

const findResourceRoot = async (executable, resolvedExecutable = executable) => {
  const bundleRoot = dirname(executable)
  const candidates = [
    join(dirname(resolvedExecutable), 'resources'),
    join(bundleRoot, 'resources'),
    join(bundleRoot, 'usr', 'lib', 'open-science', 'resources'),
    join(bundleRoot, 'usr', 'lib', 'Open Science', 'resources')
  ]
  for (const candidate of [...new Set(candidates)]) {
    if (await pathExists(join(candidate, 'app.asar'))) return candidate
  }
  throw new Error(`Packaged Linux app.asar was not found for ${executable}.`)
}

const assertPackagedResources = async (
  executable,
  resourceRoot = join(dirname(executable), 'resources')
) => {
  for (const path of packagedResourcePaths(executable, resourceRoot)) {
    if (!(await pathExists(path))) throw new Error(`Packaged Linux resource is missing: ${path}`)
  }
  const prismaRoot = join(resourceRoot, 'node_modules', '.prisma', 'client')
  const engines = await readdir(prismaRoot).catch(() => [])
  if (!engines.some((name) => /query_engine-.+\.so\.node$/.test(name))) {
    throw new Error(`Packaged Linux Prisma engine is missing from ${prismaRoot}.`)
  }
}

const launchAndProbe = async ({ executable, expectedVersion, env }) => {
  const child = spawn(executable, ['--open-science-headless', '--serve=0', '--no-sandbox'], {
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
      waitFor('the packaged Linux web service', async () => parsePackagedAppEndpoint(output)),
      exit.then((code) => {
        throw new Error(`Packaged Linux app exited before becoming healthy (${code}).\n${output}`)
      })
    ])
    const response = await fetch(`${service.endpoint}/api/bootstrap?${service.auth}`, {
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`Packaged Linux bootstrap returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    if (
      bootstrap.appName !== 'Open Science' ||
      bootstrap.appVersion !== expectedVersion ||
      bootstrap.platform !== 'linux'
    ) {
      throw new Error(`Unexpected packaged Linux bootstrap: ${JSON.stringify(bootstrap)}`)
    }
    const shutdown = await fetch(`${service.endpoint}/api/shutdown?${service.auth}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000)
    })
    await shutdown.text()
    if (shutdown.status !== 202)
      throw new Error(`Packaged Linux shutdown returned ${shutdown.status}.`)
    const exitCode = await Promise.race([
      exit,
      delay(60_000).then(() => {
        throw new Error('Packaged Linux app did not exit after shutdown.')
      })
    ])
    if (exitCode !== 0) throw new Error(`Packaged Linux app exited with ${exitCode}.\n${output}`)
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

const smokeExecutable = async ({ executable, expectedVersion, env }) => {
  const resolvedExecutable = await realpath(executable)
  const resourceRoot = await findResourceRoot(executable, resolvedExecutable)
  await assertPackagedResources(resolvedExecutable, resourceRoot)
  await runProcess(join(resourceRoot, 'micromamba'), ['--version'], { env })
  await launchAndProbe({ executable, expectedVersion, env })
}

const parseArguments = (argv) => {
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const artifactDirectory = valueFor('--artifact-dir')
  const installedExecutable = valueFor('--installed-executable')
  if (!artifactDirectory || !installedExecutable) {
    throw new Error(
      'Usage: --artifact-dir <path> --installed-executable <path-to-installed-open-science>'
    )
  }
  return {
    artifactDirectory: resolve(artifactDirectory),
    installedExecutable: resolve(installedExecutable)
  }
}

const main = async () => {
  if (process.platform !== 'linux') throw new Error('Linux package smoke requires Linux.')
  const options = parseArguments(process.argv.slice(2))
  const appImage = await findOne(options.artifactDirectory, APPIMAGE_PATTERN, 'Linux AppImage')
  const expectedVersion = appImageVersion(appImage)
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    OPEN_SCIENCE_STORAGE_ROOT: join(root, 'storage')
  }

  try {
    await smokeExecutable({
      executable: options.installedExecutable,
      expectedVersion,
      env
    })
    await chmod(appImage, 0o755)
    await runProcess(appImage, ['--appimage-extract'], { cwd: root, env })
    await smokeExecutable({
      executable: join(root, 'squashfs-root', 'AppRun'),
      expectedVersion,
      env
    })
    console.log('Linux deb install and AppImage launch smoke completed successfully.')
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
  appImageVersion,
  assertPackagedResources,
  findOne,
  findResourceRoot,
  packagedResourcePaths,
  parseArguments,
  parsePackagedAppEndpoint
}
