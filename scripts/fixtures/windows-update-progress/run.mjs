/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executable JavaScript fixture. */
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./', import.meta.url))
const root = path.join(repository, 'tmp', 'windows-update-progress-' + Date.now())
const application = path.join(root, 'installation', 'application.exe')
const scenario = process.argv[2] ?? 'success'
assert(
  [
    'success',
    'installer-failure',
    'cancel',
    'unconfirmed',
    'late-ready',
    'wrong-receipt',
    'observer-gap'
  ].includes(scenario)
)
if (scenario === 'observer-gap') assert(process.env.OPEN_SCIENCE_PROGRESS_OBSERVER)
const helperPath = path.join(
  repository,
  'build/windows-update-progress/build/Release/open-science-update-progress.exe'
)
const evidence = [],
  children = []
let ready, appPid, installerPid
let handoffObserverExit
const mark = (name) => fs.writeFile(path.join(root, name), '')
const waitFile = async (name, absent = false) => {
  const deadline = Date.now() + 30_000
  while (true) {
    const exists = await fs.access(path.join(root, name)).then(
      () => true,
      () => false
    )
    if (exists !== absent) return
    if (Date.now() > deadline) throw Error('Timed out: ' + name)
    await delay(25)
  }
}
const inspect = (pid) =>
  execFileSync(application, ['inspect', String(pid)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  }).trim()
const visible = (pid) => inspect(pid) === 'visible'
const waitExited = async (pid) => {
  const deadline = Date.now() + 15000
  while (inspect(pid) !== 'absent') {
    if (Date.now() > deadline) throw Error('Owned fixture process did not exit: ' + pid)
    await delay(25)
  }
}
const waitHelperEvent = async (event) => {
  const deadline = Date.now() + 15000
  while (!(await fs.readFile(ready.logPath, 'utf8')).includes(`"event":"${event}"`)) {
    if (Date.now() > deadline) throw Error('Helper did not report: ' + event)
    await delay(25)
  }
}
;(async () => {
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.dirname(application))
  await build({
    entryPoints: [path.join(repository, 'src/main/update/windows-install-progress.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Shared worktree dependencies must not select another checkout's local package build.
    alias: {
      '@aipoch/durable-files': path.join(repository, 'packages/durable-files/dist/index.js')
    },
    outfile: path.join(root, 'launcher.cjs')
  })
  execFileSync(
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    [
      '/nologo',
      '/target:winexe',
      '/reference:System.Windows.Forms.dll',
      '/out:' + application,
      path.join(fixture, 'Program.cs')
    ],
    { windowsHide: true }
  )
  await fs.copyFile(application, path.join(root, 'installer.exe'))
  const { encodeWindowsProgressConfig, startWindowsInstallProgress } = await import(
    pathToFileURL(path.join(root, 'launcher.cjs')).href
  )
  await assert.rejects(
    startWindowsInstallProgress({
      installerPath: path.join(root, 'installer.exe'),
      applicationPath: application,
      helperPath,
      appData: path.join(root, 'installation', 'cache'),
      profilePath: path.join(root, 'profile'),
      targetVersion: '1.0.2',
      startupOptions: {
        configRoot: root,
        dataRoot: root,
        profilePath: path.join(root, 'profile'),
        port: 44100,
        host: '127.0.0.1',
        credentialStore: 'os'
      },
      logDirectory: root,
      translate: (text) => text,
      log: console
    }),
    /storage must be outside the installation/
  )
  evidence.push({ phase: 'cache-inside-installation-rejected-before-launch' })
  const invalid = path.join(root, 'invalid-parent')
  await fs.mkdir(invalid)
  await fs.writeFile(
    path.join(invalid, 'config.bin'),
    encodeWindowsProgressConfig(1, [
      '00000000-0000-4000-8000-000000000001',
      process.execPath,
      application,
      path.join(root, 'installer.exe'),
      path.join(invalid, 'log.jsonl'),
      'Installing',
      'Starting',
      'Failed',
      'Close',
      'Unconfirmed'
    ])
  )
  const bad = spawn(helperPath, [path.join(invalid, 'config.bin')], {
    windowsHide: false,
    stdio: 'pipe'
  })
  let rejected = ''
  bad.stderr.on('data', (chunk) => {
    rejected += chunk
  })
  assert.equal((await once(bad, 'exit'))[0], 1)
  assert.match(rejected, /parent PID mismatch/)
  evidence.push({ phase: 'wrong-parent-rejected-before-window', code: 1, error: rejected })
  const env = {
    ...process.env,
    OPEN_SCIENCE_PROGRESS_FIXTURE: root,
    OPEN_SCIENCE_PROGRESS_MODULE: path.join(root, 'launcher.cjs'),
    OPEN_SCIENCE_PROGRESS_HELPER: helperPath,
    OPEN_SCIENCE_PROGRESS_SCENARIO: scenario
  }
  const unrelated = spawn(application, ['unrelated'], {
    env,
    windowsHide: false,
    stdio: 'pipe'
  })
  children.push(unrelated)
  const unrelatedExit = once(unrelated, 'exit')
  await waitFile('unrelated-visible')
  const parent = spawn(process.execPath, [path.join(fixture, 'parent.mjs')], {
    env,
    windowsHide: true,
    stdio: 'pipe'
  })
  children.push(parent)
  const parentExit = once(parent, 'exit')
  let parentOutput = ''
  parent.stderr.on('data', (b) => {
    parentOutput += b
  })
  await waitFile('helper-ready.json')
  ready = JSON.parse(await fs.readFile(path.join(root, 'helper-ready.json'), 'utf8'))
  if (scenario === 'cancel') {
    assert(visible(ready.pid))
    await mark('cancel-parent')
    assert.equal((await parentExit)[0], 0, parentOutput)
    await waitExited(ready.pid)
    assert.equal(
      await fs.access(path.join(ready.directory, 'closed.receipt')).then(
        () => true,
        () => false
      ),
      true
    )
    const log = await fs.readFile(ready.logPath, 'utf8')
    assert(log.includes('"event":"presentation-dismissed"'))
    assert(visible(unrelated.pid))
    await mark('close-' + unrelated.pid)
    assert.equal((await unrelatedExit)[0], 0)
    await waitExited(unrelated.pid)
    await fs.writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(
        { status: 'PASS', scenario, ready, log, evidence, remaining: [], forced: false },
        null,
        2
      )
    )
    console.log('PASS native handoff cancellation: ' + root)
    return
  }
  await waitFile('installer-ready')
  installerPid = Number(await fs.readFile(path.join(root, 'installer-ready'), 'utf8'))
  if (
    process.env.OPEN_SCIENCE_PROGRESS_OBSERVER &&
    ['success', 'observer-gap'].includes(scenario)
  ) {
    const started = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${parent.pid}).StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'")`
      ],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
    const observer = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'RemoteSigned',
        '-File',
        process.env.OPEN_SCIENCE_PROGRESS_OBSERVER,
        '-TargetPid',
        String(parent.pid),
        '-Started',
        started,
        '-HandoffAppData',
        root,
        '-Output',
        path.join(root, 'observer.jsonl')
      ],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: {
          ...process.env,
          OPEN_SCIENCE_UPDATE_OBSERVER_APPLICATION_PATH: application,
          OPEN_SCIENCE_UPDATE_OBSERVER_INSTALLER_PATH: path.join(root, 'installer.exe'),
          OPEN_SCIENCE_UPDATE_OBSERVER_PROGRESS_EXECUTABLE_PATH: helperPath,
          OPEN_SCIENCE_UPDATE_OBSERVER_PARENT_EXECUTABLE_PATH: process.execPath
        }
      }
    )
    children.push(observer)
    handoffObserverExit = once(observer, 'exit')
    let output = '',
      errors = ''
    observer.stdout.on('data', (chunk) => {
      output += chunk
    })
    observer.stderr.on('data', (chunk) => {
      errors += chunk
    })
    const deadline = Date.now() + 15000
    while (!output.includes('OPEN_SCIENCE_UPDATE_HANDOFF_OBSERVER_READY')) {
      if (observer.exitCode !== null || Date.now() > deadline)
        throw Error('Handoff observer readiness failed: ' + errors)
      await delay(25)
    }
  }
  assert(visible(ready.pid))
  evidence.push({ phase: 'before-old-exit', helper: ready.pid, visible: true })
  await mark('exit-parent')
  assert.equal((await parentExit)[0], 0, parentOutput)
  if (scenario === 'late-ready') {
    await fs.writeFile(
      path.join(ready.directory, 'unconfirmed.receipt'),
      ready.token + '\r\nunconfirmed\r\n'
    )
    await waitHelperEvent('unconfirmed')
    assert(visible(ready.pid), 'Unconfirmed presentation must remain available for late readiness')
    evidence.push({ phase: 'unconfirmed-before-late-readiness', helperVisible: true })
  }
  if (scenario === 'unconfirmed') {
    await fs.writeFile(
      path.join(ready.directory, 'unconfirmed.receipt'),
      ready.token + '\r\nunconfirmed\r\n'
    )
    const deadline = Date.now() + 15000
    while (!(await fs.readFile(ready.logPath, 'utf8')).includes('"event":"unconfirmed"')) {
      if (Date.now() > deadline) throw Error('Unconfirmed handoff was not presented')
      await delay(25)
    }
    execFileSync(application, ['close', String(ready.pid)], { windowsHide: true, timeout: 5000 })
    await waitExited(ready.pid)
    assert.notEqual(
      inspect(installerPid),
      'absent',
      'Closing presentation must not terminate installer'
    )
    await mark('release-new-process')
    await waitFile('app-started')
    appPid = Number(await fs.readFile(path.join(root, 'app-started'), 'utf8'))
    await mark('release-window')
    await waitFile('app-visible')
    await mark('release-readiness')
    await mark('close-' + appPid)
    await mark('close-' + unrelated.pid)
    assert.equal((await unrelatedExit)[0], 0)
    for (const pid of [appPid, installerPid, parent.pid, unrelated.pid]) await waitExited(pid)
    await fs.writeFile(
      path.join(root, 'result.json'),
      JSON.stringify({ status: 'PASS', scenario, remaining: [], forced: false }, null, 2)
    )
    console.log('PASS closing unconfirmed presentation leaves installer running: ' + root)
    return
  }
  if (scenario === 'observer-gap') {
    // Negative control: deliberately remove the fixture's progress UI while no successor exists.
    // The independent observer must record the gap; this is not an application acceptance run.
    await fs.writeFile(path.join(ready.directory, 'cancel'), ready.token)
    await waitExited(ready.pid)
    const deadline = Date.now() + 15000
    let gaps = []
    while (!gaps.length) {
      const samples = (await fs.readFile(path.join(root, 'observer.jsonl'), 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse)
      gaps = samples.filter((sample) => sample.windows?.length === 0)
      if (Date.now() > deadline)
        throw Error('Independent observer missed deliberately blank handoff')
      await delay(25)
    }
    await mark('release-new-process')
    await waitFile('app-started')
    appPid = Number(await fs.readFile(path.join(root, 'app-started'), 'utf8'))
    await mark('release-window')
    await waitFile('app-visible')
    await mark('release-readiness')
    assert.equal((await handoffObserverExit)[0], 0)
    await mark('close-' + appPid)
    await mark('close-' + unrelated.pid)
    assert.equal((await unrelatedExit)[0], 0)
    for (const pid of [appPid, installerPid, parent.pid, unrelated.pid]) await waitExited(pid)
    await fs.writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(
        {
          status: 'PASS',
          scenario,
          negativeControl: true,
          gapsDetected: gaps.length,
          remaining: [],
          forced: false
        },
        null,
        2
      )
    )
    console.log('PASS observer detects deliberately missing handoff UI: ' + root)
    return
  }
  assert(visible(ready.pid))
  evidence.push({ phase: 'old-exited-no-installer-window', visible: true })
  assert(visible(unrelated.pid))
  assert(visible(ready.pid))
  evidence.push({
    phase: 'unrelated-same-executable-does-not-dismiss-helper',
    unrelated: unrelated.pid,
    helperVisible: true
  })
  await mark('release-new-process')
  if (scenario === 'installer-failure') {
    const deadline = Date.now() + 15000
    let log = ''
    while (!log.includes('"event":"failed"')) {
      if (Date.now() > deadline) throw Error('Installer failure did not reach progress UI')
      log = await fs.readFile(ready.logPath, 'utf8')
      await delay(25)
    }
    assert(log.includes('Installer reported failure'))
    assert(visible(ready.pid))
    assert(!log.includes('"event":"successor-ready"'))
    execFileSync(application, ['close', String(ready.pid)], { windowsHide: true, timeout: 5000 })
    await waitExited(ready.pid)
    assert.equal(
      await fs.access(path.join(ready.directory, 'closed.receipt')).then(
        () => true,
        () => false
      ),
      true
    )
    assert(visible(unrelated.pid))
    await mark('close-' + unrelated.pid)
    assert.equal((await unrelatedExit)[0], 0)
    for (const pid of [parent.pid, installerPid, unrelated.pid]) await waitExited(pid)
    await fs.writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(
        { status: 'PASS', scenario, ready, log, evidence, remaining: [], forced: false },
        null,
        2
      )
    )
    console.log('PASS native installer failure remains visible until close: ' + root)
    return
  }
  await waitFile('app-started')
  appPid = Number(await fs.readFile(path.join(root, 'app-started'), 'utf8'))
  assert(!visible(appPid))
  assert(visible(ready.pid))
  evidence.push({
    phase: 'successor-process-started-window-not-visible',
    successor: appPid,
    helperVisible: true
  })
  await mark('release-window')
  await waitFile('app-visible')
  assert(visible(ready.pid), 'A visible successor without readiness must not dismiss progress')
  if (scenario === 'wrong-receipt') {
    await fs.writeFile(
      path.join(ready.directory, 'ready.receipt'),
      '00000000-0000-4000-8000-000000000001\r\nready\r\n'
    )
    await waitHelperEvent('unconfirmed')
    assert(visible(ready.pid), 'Another operation cannot confirm this update')
    const log = await fs.readFile(ready.logPath, 'utf8')
    assert(!log.includes('"event":"successor-ready"'))
    evidence.push({ phase: 'wrong-operation-receipt-rejected', helperVisible: true })
    await fs.unlink(path.join(ready.directory, 'ready.receipt'))
  }
  await mark('release-readiness')
  if (handoffObserverExit) {
    assert.equal((await handoffObserverExit)[0], 0)
    const samples = (await fs.readFile(path.join(root, 'observer.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse)
    assert(samples.length > 0)
    assert(samples.every((sample) => !sample.observerError && sample.windows.length > 0))
    assert(
      samples.some((sample) =>
        sample.windows.some((window) => window.pid === ready.pid && window.role === 'progress')
      ),
      'The owned helper must be observed as progress under the fixture appData'
    )
    assert.equal(samples.at(-1).successorPid, appPid)
    assert(
      samples.every((sample) => sample.windows.every((window) => window.pid !== unrelated.pid))
    )
    evidence.push({
      phase: 'independent-observer',
      samples: samples.length,
      noVisibilityGaps: true,
      progressPid: ready.pid,
      excludesUnrelated: true
    })
  }
  const limit = Date.now() + 15000
  while (
    await fs.access(path.join(ready.directory, 'closed.receipt')).then(
      () => false,
      () => true
    )
  ) {
    if (Date.now() > limit) throw Error('Helper did not close after successor readiness')
    await delay(25)
  }
  const log = await fs.readFile(ready.logPath, 'utf8')
  assert(log.includes('"event":"successor-ready"'))
  assert(visible(appPid))
  assert(visible(unrelated.pid))
  evidence.push({
    phase: 'helper-exited-after-owned-successor-ready',
    successor: appPid,
    unrelatedStillVisible: true
  })
  await mark('close-' + appPid)
  await mark('close-' + unrelated.pid)
  assert.equal((await unrelatedExit)[0], 0)
  for (const pid of [appPid, installerPid, ready.pid, parent.pid, unrelated.pid])
    await waitExited(pid)
  evidence.push({ phase: 'process-audit', remaining: [], forced: false })
  await fs.writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(
      {
        status: 'PASS',
        evidence,
        ready,
        log,
        cleanup: 'normal window closes; no force termination'
      },
      null,
      2
    )
  )
  console.log('PASS native handoff chain: ' + root)
})().catch(async (error) => {
  if (handoffObserverExit) await mark('observer.jsonl.stop')
  await mark('cancel-fixture')
  await mark('cancel-parent')
  if (ready) await fs.writeFile(path.join(ready.directory, 'cancel'), ready.token).catch(() => {})
  if (appPid) await mark('close-' + appPid)
  for (const child of children)
    if (child.exitCode === null) {
      if (child.spawnargs[0].endsWith('application.exe')) await mark('close-' + child.pid)
      else await mark('exit-parent')
    }
  const cleanup = []
  for (const pid of [
    ...children.map((child) => child.pid),
    ready?.pid,
    appPid,
    installerPid
  ].filter(Boolean)) {
    try {
      await waitExited(pid)
      cleanup.push({ pid, exited: true, forced: false })
    } catch (failure) {
      cleanup.push({ pid, exited: false, error: failure.message })
    }
  }
  await fs.writeFile(
    path.join(root, 'failure.json'),
    JSON.stringify({ error: error.stack, evidence, ready, cleanup }, null, 2)
  )
  console.error(error)
  process.exitCode = 1
})
