#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { openSync, closeSync } from 'node:fs'
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  stat,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'
import { captureSource, validateVersions } from './source.mjs'
import { buildPair, runCommand, verifyArtifacts } from './build.mjs'
import { SCENARIOS, startUpdateServer } from './server.mjs'
import { readJsonLines, writeReport } from './report.mjs'
import { installRunSignalHandlers } from './lifecycle.mjs'
import { prepareValidationKeychain } from './keychain.mjs'
import { createUpdaterOnlyArtifact, invalidateDownloadedArtifact } from './artifact-fault.mjs'

const exec = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const marker = '.local-update-validation-owner.json'
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const record = async (path, event) =>
  appendFile(path, `${JSON.stringify({ schema: 1, at: new Date().toISOString(), ...event })}\n`)
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}
export async function ownedRun(input) {
  const path = resolve(input)
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('Run directory must use its canonical absolute path, without symlinks.')
  const owner = await json(join(path, marker))
  if (owner.schema !== 1 || owner.root !== path || !/^[0-9a-f-]{36}$/.test(owner.runId))
    throw new Error('Ownership receipt does not match this directory.')
  return { path, owner }
}

export async function prepare({
  workspace = repository,
  parent = join(homedir(), 'Library', 'Caches', 'Open-Science-local-update-validation'),
  versionA = '0.0.1',
  versionB = '0.0.2'
} = {}) {
  validateVersions(versionA, versionB)
  if (process.platform !== 'darwin')
    throw new Error('This first validation entry supports macOS only.')
  await mkdir(parent, { recursive: true })
  parent = await realpath(parent)
  const workspaceRoot = await realpath(workspace)
  // Capturing a run inside the workspace would recursively include the run itself.
  if (inside(workspaceRoot, parent))
    throw new Error('Run parent must be outside the source workspace.')
  const runId = randomUUID()
  const root = join(parent, runId)
  await mkdir(root, { mode: 0o700 })
  await writeFile(
    join(root, marker),
    JSON.stringify(
      { schema: 1, runId, root, workspace: workspaceRoot, createdAt: new Date().toISOString() },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  )
  console.log(`Run directory: ${root}`)
  try {
    const source = await captureSource(workspaceRoot, join(root, 'source'))
    await buildPair(root, { versionA, versionB, snapshotId: source.snapshotId })
    await writeReport(root)
    return root
  } catch (error) {
    await record(join(root, 'facility-events.jsonl'), {
      type: 'preparation-failed',
      error: error.stack ?? error.message
    })
    await writeReport(root)
    throw new Error(
      `Preparation failed. No application was launched. Evidence retained at ${root}`,
      { cause: error }
    )
  }
}

async function compileFixture(root) {
  const directory = join(root, 'builds', 'a')
  const output = join(directory, '.scratch', 'fixture.cjs')
  const require = createRequire(join(directory, 'package.json'))
  await require('esbuild').build({
    absWorkingDir: directory,
    entryPoints: ['scripts/local-update-validation/fixture.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    define: {
      'import.meta.dirname': JSON.stringify(directory),
      'import.meta.url': JSON.stringify(new URL(`file://${output}`).href)
    }
  })
  return output
}

async function portAvailable(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function observeSourceHealth(config, type, fields = {}) {
  if (!config.feedUrl) return // Unit observers without an update source only inspect task processes.
  const origin = new URL(config.feedUrl).origin
  const response = await fetch(`${origin}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3000)
  })
  if (!response.ok || !(await response.json()).ready)
    throw new Error('The update source did not survive the application lifecycle.')
  await record(join(config.runRoot, 'observations.jsonl'), { type, origin, ready: true, ...fields })
}

export async function observe(config, seen = new Set()) {
  const events = await readJsonLines(config.eventsPath)
  if (config.targetApplicationPath && !seen.has('target-started-observed')) {
    const ps = (await exec('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 }))
      .stdout
    const target = ps
      .split('\n')
      .find((line) => line.includes(`${config.targetApplicationPath}/Contents/`))
    if (target) {
      await record(join(config.runRoot, 'observations.jsonl'), {
        type: 'target-started-observed',
        pid: Number(target.trim().split(/\s+/, 1)[0]),
        app: config.targetApplicationPath
      })
      seen.add('target-started-observed')
    }
  }
  for (const [index, event] of events.entries()) {
    if (event.runId !== config.runId || event.scenario !== config.scenario || seen.has(index))
      continue
    if (event.type === 'runtime-stopped' && !processExists(event.pid)) {
      await record(join(config.runRoot, 'observations.jsonl'), {
        type: 'runtime-exit-observed',
        pid: event.pid,
        generation: event.generation
      })
      await observeSourceHealth(config, 'source-health-after-runtime-stop', {
        pid: event.pid,
        generation: event.generation
      })
      seen.add(index)
    } else if (
      event.type === 'runtime-recovered' &&
      processExists(event.pid) &&
      Number.isSafeInteger(event.port) &&
      (await portAvailable(event.port))
    ) {
      await record(join(config.runRoot, 'observations.jsonl'), {
        type: 'runtime-recovery-observed',
        pid: event.pid,
        generation: event.generation,
        port: event.port
      })
      seen.add(index)
    }
  }
  for (const [index, event] of events.entries()) {
    if (
      event.runId === config.runId &&
      event.scenario === config.scenario &&
      event.type === 'application-quit' &&
      !seen.has(`source-quit/${index}`)
    ) {
      await observeSourceHealth(config, 'source-health-after-application-quit', { pid: event.pid })
      seen.add(`source-quit/${index}`)
    }
  }
  if (config.scenario === 'shutdown-failure') {
    const faults = await readJsonLines(join(config.runRoot, 'server-events.jsonl'))
    const fault = faults.find(
      (event) => event.type === 'fault-triggered' && event.fault === 'shutdown-failure'
    )
    if (fault) {
      const original = await lstat(fault.lockPath)
      let owned
      try {
        owned = await lstat(fault.linkPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (
        !seen.has('shutdown-fault-observed') &&
        owned &&
        original.dev === fault.dev &&
        original.ino === fault.ino &&
        owned.dev === fault.dev &&
        owned.ino === fault.ino &&
        original.nlink === 2 &&
        owned.nlink === 2
      ) {
        await record(join(config.runRoot, 'observations.jsonl'), {
          type: 'shutdown-fault-observed',
          dev: fault.dev,
          ino: fault.ino,
          nlink: 2
        })
        seen.add('shutdown-fault-observed')
        console.log(
          'Observed source-owned shutdown lock fault. Trigger installation in A after download completes.'
        )
      }
      if (
        !owned &&
        seen.has('shutdown-fault-observed') &&
        !seen.has('shutdown-fault-release-observed') &&
        original.dev === fault.dev &&
        original.ino === fault.ino &&
        original.nlink === 1 &&
        faults.some((event) => event.type === 'fault-released' && event.reason === 'user-request')
      ) {
        await record(join(config.runRoot, 'observations.jsonl'), {
          type: 'shutdown-fault-release-observed',
          dev: fault.dev,
          ino: fault.ino,
          nlink: 1
        })
        seen.add('shutdown-fault-release-observed')
        console.log('Observed fault link released; use recovery in A.')
      }
    }
  }
  if (
    /^cache-(corrupt|delete)-(entry|reveal)$/.test(config.scenario) &&
    !seen.has('artifact-invalidated')
  ) {
    const verified = events.findLast((event) => event.type === 'download-verified')
    const trigger = config.scenario.endsWith('-entry')
      ? 'runtime-recovered'
      : 'manual-artifact-verified'
    if (verified && events.some((event) => event.type === trigger)) {
      const mutation = config.scenario.includes('-delete-') ? 'delete' : 'corrupt'
      const proof = await invalidateDownloadedArtifact(config, verified, mutation)
      await record(join(config.runRoot, 'observations.jsonl'), {
        type: 'fault-triggered',
        fault: config.scenario,
        trigger,
        ...proof
      })
      seen.add('artifact-invalidated')
      console.log(
        `Observed real cache ${mutation} after ${trigger}; now ${config.scenario.endsWith('-entry') ? 'open manual instructions' : 'click Show in Finder'} in A.`
      )
    }
  }
  const fixture = await json(join(config.runRoot, 'fixture-manifest.json'))
  const taskPath = join(fixture.workspace, 'task.pid')
  let task
  try {
    task = {
      pid: Number((await readFile(taskPath, 'utf8')).trim()),
      mtimeMs: (await stat(taskPath)).mtimeMs
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (task && Number.isSafeInteger(task.pid) && task.pid > 0) {
    const key = `${task.pid}/${task.mtimeMs}`
    if (processExists(task.pid) && !seen.has(`task-running/${key}`)) {
      await record(join(config.runRoot, 'observations.jsonl'), {
        type: 'task-running-observed',
        ...task
      })
      seen.add(`task-running/${key}`)
      console.log(`Observed local task running (pid ${task.pid}).`)
    }
    if (
      !processExists(task.pid) &&
      seen.has(`task-running/${key}`) &&
      !seen.has(`task-exit/${key}`)
    ) {
      await record(join(config.runRoot, 'observations.jsonl'), {
        type: 'task-exit-observed',
        ...task
      })
      seen.add(`task-exit/${key}`)
      console.log(
        `Observed local task exited (pid ${task.pid}); installation may now be retried in A.`
      )
    }
    const recovery = events.findLast(
      (event) => event.type === 'runtime-recovered' && event.runId === config.runId
    )
    if (
      recovery &&
      !processExists(task.pid) &&
      seen.has(`task-exit/${key}`) &&
      !seen.has(`task-not-restarted/${key}`)
    ) {
      try {
        const write = join(fixture.workspace, 'recovery-write.txt')
        if (
          (await stat(write)).mtimeMs > Date.parse(recovery.at) &&
          (await readFile(write, 'utf8')) === 'LOCAL_UPDATE_RECOVERY_WRITE\n'
        ) {
          await record(join(config.runRoot, 'observations.jsonl'), {
            type: 'task-not-restarted',
            ...task,
            recoveryGeneration: recovery.generation
          })
          seen.add(`task-not-restarted/${key}`)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  return seen
}

export async function runScenario(
  input,
  scenario = 'boundary',
  { stageOnly = false, staged } = {}
) {
  if (process.platform !== 'darwin') throw new Error('Only native macOS runs are supported.')
  if (!SCENARIOS.includes(scenario))
    throw new Error(`Unknown scenario: ${scenario}. Choose ${SCENARIOS.join(', ')}`)
  const { path: root, owner } = await ownedRun(input)
  const build = await json(join(root, 'build.json'))
  await verifyArtifacts(build)
  const runRoot = staged ? resolve(staged) : join(root, 'scenarios', `${scenario}-${randomUUID()}`)
  if (!inside(join(root, 'scenarios'), runRoot) || runRoot === join(root, 'scenarios'))
    throw new Error('Staged scenario must belong to this owned run.')
  if (!staged) await mkdir(runRoot, { recursive: true, mode: 0o700 })
  for (const name of [
    'config',
    'data',
    'electron-profile',
    'update-cache',
    'apps',
    'home',
    'source-resources'
  ])
    if (!staged) await mkdir(join(runRoot, name))
  const config = staged
    ? await json(join(runRoot, 'local-update.json'))
    : {
        schema: 1,
        runId: randomUUID(),
        suiteRunId: owner.runId,
        scenario,
        runRoot,
        homeRoot: join(runRoot, 'home'),
        ...(build.credentialMode === 'sandbox' ? { credentialMode: 'sandbox' } : {}),
        keychainPath: join(
          runRoot,
          'home',
          'Library',
          'Keychains',
          'local-update-validation.keychain-db'
        ),
        configRoot: join(runRoot, 'config'),
        dataRoot: join(runRoot, 'data'),
        userDataRoot: join(runRoot, 'electron-profile'),
        updateCacheRoot: join(runRoot, 'update-cache'),
        eventsPath: join(runRoot, 'app-events.jsonl'),
        targetApplicationPath: build.b.app,
        installBehavior:
          scenario === 'handoff-failure' ||
          scenario.startsWith('manual-') ||
          scenario.startsWith('cache-')
            ? 'fail'
            : 'boundary'
      }
  if (
    config.runRoot !== runRoot ||
    config.suiteRunId !== owner.runId ||
    config.scenario !== scenario
  )
    throw new Error('Staged scenario identity does not match its suite.')
  if (staged) {
    try {
      await lstat(join(runRoot, 'launch.json'))
      throw new Error(
        'A staged scenario may be launched only once; stage a fresh scenario instead.'
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const configPath = join(runRoot, 'local-update.json')
  const logPath = join(runRoot, 'application.log')
  let service
  let launched = false
  let facilityError
  let end
  const finished = new Promise((resolve) => {
    end = resolve
  })
  const fail = (error) => {
    facilityError ??= error
    end()
  }
  const abort = new AbortController()
  const stop = () => {
    abort.abort()
    end()
  }
  const checkPreparation = () => {
    if (!launched) abort.signal.throwIfAborted()
  }
  const removeSignalHandlers = installRunSignalHandlers(stop)
  let timer
  let observing = Promise.resolve()
  try {
    const app = join(runRoot, 'apps', 'Open-Science.app')
    const fixture = await compileFixture(root)
    if (!staged) {
      await cp(build.a.app, app, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false
      })
      checkPreparation()
      // Provision fixed data offline before native credential access. stage never starts A.
      await writeFile(configPath, JSON.stringify(config, null, 2))
      await runCommand(process.execPath, [fixture, configPath], {
        cwd: join(root, 'builds', 'a'),
        logPath: join(runRoot, 'fixture.log')
      })
      checkPreparation()
    }
    if (stageOnly) {
      console.log(`Scenario staged without launching A: ${runRoot}`)
      console.log(
        'Provision only in a dedicated disposable macOS login account/VM. The runner never changes Keychain lists.'
      )
      return runRoot
    }
    const keychain =
      config.credentialMode === 'sandbox'
        ? {
            isolated: true,
            mode: 'local-update-credential-sandbox',
            productionCredentialAcceptance: false
          }
        : prepareValidationKeychain(config)
    await writeFile(join(runRoot, 'keychain-verification.json'), JSON.stringify(keychain, null, 2))
    checkPreparation()
    const servedArtifact =
      scenario === 'manual-non-standalone'
        ? await createUpdaterOnlyArtifact(
            join(runRoot, 'source-resources'),
            build.versionB,
            build.arch,
            build.snapshotId
          )
        : { ...build.b, snapshotId: build.snapshotId }
    config.servedArtifact = servedArtifact
    const target = servedArtifact.files.find((file) => file.name.endsWith('.zip'))
    config.targetArtifact = {
      version: build.versionB,
      arch: build.arch,
      size: target.size,
      sha512: target.sha512
    }
    service = await startUpdateServer({
      artifact: servedArtifact,
      versionA: build.versionA,
      versionB: build.versionB,
      scenario,
      shutdownFault: {
        runRoot,
        configRoot: config.configRoot,
        resourceRoot: join(runRoot, 'source-resources')
      },
      eventsPath: join(runRoot, 'server-events.jsonl'),
      onFailure: fail
    })
    checkPreparation()
    config.repairUrl = service.repairUrl
    config.feedUrl = `${service.origin}/`
    config.manifestUrl = `${service.origin}/version.json`
    await writeFile(configPath, JSON.stringify(config, null, 2))
    checkPreparation()
    // Ready probe precedes A startup. An unavailable source cannot fall back to the official CDN.
    const health = await fetch(`${service.origin}/health`, { signal: AbortSignal.timeout(3000) })
    if (!health.ok || !(await health.json()).ready || facilityError)
      throw facilityError ?? new Error('Local update service did not become ready.')
    await observeSourceHealth(config, 'source-health-before-launch')
    checkPreparation()
    const appEnv = { ...process.env }
    for (const key of Object.keys(appEnv))
      if (key.startsWith('OPEN_SCIENCE_') || key === 'ELECTRON_RUN_AS_NODE') delete appEnv[key]
    Object.assign(appEnv, {
      HOME: config.homeRoot,
      OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CONFIG: configPath,
      OPEN_SCIENCE_CONFIG_ROOT: config.configRoot,
      OPEN_SCIENCE_USER_DATA: config.userDataRoot
    })
    const fd = openSync(logPath, 'a', 0o600)
    try {
      checkPreparation()
      const child = spawn(join(app, 'Contents', 'MacOS', 'Open-Science'), [], {
        env: appEnv,
        cwd: runRoot,
        detached: true,
        stdio: ['ignore', fd, fd]
      })
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
      launched = true
      await record(join(runRoot, 'observations.jsonl'), {
        type: 'initial-application-launched',
        pid: child.pid,
        version: build.versionA
      })
      await writeFile(
        join(runRoot, 'launch.json'),
        JSON.stringify(
          {
            pid: child.pid,
            app,
            launchedAt: new Date().toISOString(),
            role: 'A',
            version: build.versionA
          },
          null,
          2
        )
      )
      // No exit listener stops the HTTP source: source lifetime is owned solely by this runner.
    } finally {
      closeSync(fd)
    }
    console.log(
      `A opened for ${scenario}. Use the application's update UI. Source: ${service.origin}`
    )
    console.log(
      `Evidence: ${runRoot}\nCtrl-C ends observation and closes only the update source. A remains under your control.`
    )
    if (service.repairUrl)
      console.log(
        `After A refuses shutdown, release the source-owned fault link at ${service.repairUrl}, then click recovery in A.`
      )
    const seen = new Set()
    timer = setInterval(() => {
      observing = observing
        .then(async () => {
          await observe(config, seen)
          await writeReport(root)
        })
        .catch(fail)
    }, 1500)
    await finished
    clearInterval(timer)
    await observing
    await observe(config, seen)
    // Read-only verification of the same seeded data, including a user-created recovery write.
    await runCommand(process.execPath, [fixture, '--verify', configPath], {
      detached: true,
      cwd: join(root, 'builds', 'a'),
      logPath: join(runRoot, 'fixture.log')
    })
  } catch (error) {
    if (abort.signal.aborted && !launched && error.name === 'AbortError') {
      await record(join(runRoot, 'observations.jsonl'), {
        type: 'preparation-aborted',
        applicationLaunched: false
      })
      console.log('Scenario preparation aborted; A was not started.')
    } else facilityError ??= error
  } finally {
    try {
      clearInterval(timer)
      if (service) {
        try {
          await service.close()
          const port = Number(new URL(service.origin).port)
          if (await portAvailable(port))
            facilityError ??= new Error('Update source port remained occupied after close.')
          else
            await record(join(runRoot, 'observations.jsonl'), {
              type: 'source-port-released',
              origin: service.origin,
              port
            })
        } catch (error) {
          facilityError ??= error
        }
      }
      if (facilityError) {
        await record(join(runRoot, 'observations.jsonl'), {
          type: 'facility-failure',
          error: facilityError.stack ?? facilityError.message,
          applicationLaunched: launched
        })
        await record(join(root, 'facility-events.jsonl'), {
          type: 'scenario-facility-failed',
          directory: runRoot,
          error: facilityError.message
        })
      }
      await writeReport(root)
    } finally {
      removeSignalHandlers()
    }
  }
  if (facilityError)
    throw new Error(
      `Validation facility failed. Application ${launched ? 'was left running' : 'was not started'}. See ${runRoot}`,
      { cause: facilityError }
    )
  console.log(
    `Report: ${join(root, 'summary.md')}\nNative installation, B startup and post-update data remain unverified.`
  )
  return root
}

export async function cleanRun(input) {
  const { path: root } = await ownedRun(input)
  // Refuse deletion whenever ANY process still refers to the run. Never stop that process for cleanup.
  const ps = (await exec('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 32 * 1024 * 1024 }))
    .stdout
  const references = ps.split('\n').filter((line) => {
    const pid = Number(line.trim().split(/\s+/, 1)[0])
    return pid !== process.pid && line.includes(root)
  })
  const lsof = await exec('/usr/sbin/lsof', ['-n', '-Fpn'], { maxBuffer: 64 * 1024 * 1024 }).catch(
    (error) => {
      if (error.code === 1 && error.stdout) return error
      throw new Error(`Cannot prove resources are unused; retaining ${root}`, { cause: error })
    }
  )
  let pid
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    if (line.startsWith('n') && pid !== process.pid && inside(root, line.slice(1)))
      references.push(`open file, pid ${pid}: ${line.slice(1)}`)
  }
  if (references.length)
    throw new Error(
      `Run is still in use; retained without stopping any process:\n${references.slice(0, 12).join('\n')}`
    )
  // Keep ownership and path checks immediately adjacent to the destructive operation.
  await ownedRun(root)
  await rm(root, { recursive: true })
  console.log(`Removed owned, unused run: ${root}`)
}

export async function observeFinder(input, staged) {
  const { path: root, owner } = await ownedRun(input)
  const runRoot = resolve(staged)
  if (!inside(join(root, 'scenarios'), runRoot) || runRoot === join(root, 'scenarios'))
    throw new Error('Finder evidence must belong to this owned run.')
  const config = await json(join(runRoot, 'local-update.json'))
  if (config.runRoot !== runRoot || config.suiteRunId !== owner.runId)
    throw new Error('Invalid staged scenario ownership.')
  const events = await readJsonLines(config.eventsPath)
  const reveal = events.findLast(
    (event) => event.type === 'manual-file-reveal-invoked' && event.runId === config.runId
  )
  if (!reveal)
    throw new Error('A must invoke its actual file reveal before selection can be observed.')
  const script = `tell application "Finder"
    if (count of selection) is not 1 then error "Expected one selected installer"
    return POSIX path of ((item 1 of selection) as alias)
  end tell`
  const { stdout } = await exec('/usr/bin/osascript', ['-e', script], { timeout: 10_000 })
  if (stdout.trim() !== reveal.path)
    throw new Error('Finder selected file does not match the recorded verified installer.')
  await record(join(runRoot, 'observations.jsonl'), {
    type: 'native-finder-selection',
    path: reveal.path,
    observer: 'osascript-Finder-selection'
  })
  await writeReport(root)
  console.log(`Observed Finder selecting the exact verified artifact: ${reveal.path}`)
}

function options(args) {
  const result = { positionals: [] }
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) result.positionals.push(args[i])
    else {
      const name = args[i].slice(2)
      if (
        !['a', 'b', 'scenario', 'parent', 'staged'].includes(name) ||
        !args[i + 1] ||
        args[i + 1].startsWith('--')
      )
        throw new Error(`Invalid option ${args[i]}`)
      result[name] = args[++i]
    }
  }
  return result
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      `macOS local update validation (external development tool)\n\nnode scripts/local-update-validation/index.mjs start [--a 0.0.1 --b 0.0.2] [--scenario boundary] [--parent /absolute/outside/workspace]\nnode scripts/local-update-validation/index.mjs prepare [--a ... --b ...]\nnode scripts/local-update-validation/index.mjs run <run-directory> --scenario <name>\nnode scripts/local-update-validation/index.mjs stage <run-directory> --scenario <name>\nnode scripts/local-update-validation/index.mjs run <run-directory> --scenario <name> --staged <staged-directory>\nnode scripts/local-update-validation/index.mjs observe-finder <run-directory> --staged <staged-directory>\nnode scripts/local-update-validation/index.mjs report <run-directory>\nnode scripts/local-update-validation/index.mjs clean <run-directory>\n\nScenarios: ${SCENARIOS.join(', ')}\nBuilds require native macOS, Node/npm, Xcode command-line tools, and network access for pinned resources.\nEvery scenario gets fresh data and an A bundle. End with Ctrl-C; quit A yourself in the application before clean.`
    )
    return
  }
  const command = args[0] ?? 'start'
  const opts = options(args.slice(1))
  if (['start', 'prepare'].includes(command)) {
    const root = await prepare({ versionA: opts.a, versionB: opts.b, parent: opts.parent })
    if (command === 'start') await runScenario(root, opts.scenario)
  } else if (['run', 'stage'].includes(command)) {
    if (!opts.positionals[0]) throw new Error('Run directory is required.')
    await runScenario(opts.positionals[0], opts.scenario, {
      stageOnly: command === 'stage',
      staged: opts.staged
    })
  } else if (command === 'observe-finder') {
    if (!opts.positionals[0] || !opts.staged)
      throw new Error('Run directory and --staged are required.')
    await observeFinder(opts.positionals[0], opts.staged)
  } else if (['report', 'clean'].includes(command)) {
    if (!opts.positionals[0]) throw new Error('Run directory is required.')
    if (command === 'clean') await cleanRun(opts.positionals[0])
    else {
      const { path } = await ownedRun(opts.positionals[0])
      console.log(JSON.stringify(await writeReport(path), null, 2))
    }
  } else throw new Error(`Unknown command: ${command}. Use --help.`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
