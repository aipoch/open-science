import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  assertInterruptedStage,
  assertNativePause,
  validateBoundHandoff,
  createInterruptionScenario
} from './mac-update-interruption-scenarios.mjs'
const expected = {
  appBundle: '/fixture/source.app',
  profile: '/fixture/profile',
  configRoot: '/fixture/data',
  targetVersion: '2.0.0'
}
const request = {
  operationId: 'operation-id',
  applicationPath: expected.appBundle,
  targetVersion: '2.0.0',
  installerSha512: 'digest',
  profilePath: expected.profile,
  startupOptions: { profilePath: expected.profile, configRoot: expected.configRoot },
  installerPath: '/fixture/handoff/update.zip',
  targetManifest: { version: '2.0.0' }
}
const bytes = Buffer.from(JSON.stringify(request))
const record = {
  schema: 1,
  channel: 'mac-electron-updater',
  phase: 'preparing',
  installationRoot: expected.appBundle,
  targetVersion: '2.0.0',
  operationId: request.operationId,
  installerSha512: request.installerSha512,
  handoffDirectory: '/fixture/handoff',
  requestSha256: createHash('sha256').update(bytes).digest('hex')
}

test('observed admission must bind original installation, target, request and profile', () => {
  assert.equal(
    validateBoundHandoff(record, bytes, expected).request.operationId,
    request.operationId
  )
  for (const changed of [
    { installationRoot: '/another.app' },
    { targetVersion: '3.0.0' },
    { requestSha256: 'wrong' },
    { operationId: 'another-operation' },
    { installerSha512: 'wrong' },
    { handoffDirectory: '/unrelated' },
    { channel: 'windows-nsis' }
  ]) {
    assert.throws(() => validateBoundHandoff({ ...record, ...changed }, bytes, expected))
  }
  assert.throws(() =>
    validateBoundHandoff(record, bytes, { ...expected, profile: '/other-profile' })
  )
})

test('preparing marker alone cannot establish a before-install interruption', () => {
  const evidence = {
    ownerStopped: true,
    originalTargetBound: true,
    phase: 'preparing',
    sourceUnchanged: true,
    writerStarted: false
  }
  assert.doesNotThrow(() => assertInterruptedStage('before-install', evidence))
  for (const changed of [
    { ownerStopped: false },
    { originalTargetBound: false },
    { phase: 'handoff' },
    { sourceUnchanged: false },
    { writerStarted: true }
  ])
    assert.throws(() => assertInterruptedStage('before-install', { ...evidence, ...changed }))
})

test('handoff or a missing executable alone cannot claim actual replacement interruption', () => {
  const base = {
    ownerStopped: true,
    originalTargetBound: true,
    phase: 'handoff',
    mainMissing: true
  }
  assert.throws(() => assertInterruptedStage('replacing', base))
  assert.doesNotThrow(() =>
    assertInterruptedStage('replacing', { ...base, writerStopped: true, replacementObserved: true })
  )
})

test('a launched target cannot satisfy installed-before-launch interruption', () => {
  const base = {
    ownerStopped: true,
    originalTargetBound: true,
    writerStopped: true,
    targetInstalled: true,
    targetStarted: false
  }
  assert.doesNotThrow(() => assertInterruptedStage('before-target-launch', base))
  assert.throws(() =>
    assertInterruptedStage('before-target-launch', { ...base, targetStarted: true })
  )
  assert.throws(() =>
    assertInterruptedStage('before-target-launch', { ...base, targetInstalled: false })
  )
})

test('native boundaries have distinct drivers and reject stale or wrong-operation pause receipts', () => {
  for (const id of ['M09', 'M10'])
    assert.equal(typeof createInterruptionScenario(id, {}).apply, 'function')
  assert.throws(() => createInterruptionScenario('unknown', {}), /not implemented/)
  const expected = {
    stage: 'native-recovery-runtime-absent',
    operationId: 'current',
    startedAt: 10
  }
  const event = {
    phase: 'native-fault-paused',
    atStage: expected.stage,
    operationId: 'current',
    pid: 100,
    time: 11
  }
  assert.doesNotThrow(() => assertNativePause(event, expected))
  for (const changed of [
    { atStage: 'native-recovery-installed' },
    { operationId: 'old' },
    { time: 9 },
    { phase: 'native-recovery-runtime-absent' }
  ])
    assert.throws(() => assertNativePause({ ...event, ...changed }, expected))
})

test(
  'native driver fixture stops and kills only its verified source before ordinary-entry callback',
  {
    skip: process.platform !== 'darwin' || process.env.MAC_UPDATE_NATIVE_FIXTURES !== '1',
    timeout: 30000
  },
  async () => {
    const { spawn, execFileSync } = await import('node:child_process')
    const { once } = await import('node:events')
    const fs = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mac-interruption-driver-')))
    const appBundle = join(root, 'Source.app')
    const executable = join(appBundle, 'Contents/MacOS/probe')
    const protectedProcess = spawn('/bin/sleep', ['30'])
    let child
    let driver
    try {
      await fs.mkdir(join(appBundle, 'Contents/MacOS'), { recursive: true })
      await fs.writeFile(
        join(root, 'probe.c'),
        '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("ready"); fflush(stdout); for (;;) pause(); }\n'
      )
      execFileSync('/usr/bin/clang', [join(root, 'probe.c'), '-o', executable])
      await fs.writeFile(
        join(appBundle, 'Contents/Info.plist'),
        '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>com.aipoch.fixture.interruption</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
      )
      // Ad-hoc native driver fixture only; the acceptance runner still requires Developer ID.
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', appBundle], { stdio: 'pipe' })
      child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] })
      await once(child.stdout, 'data')
      const configRoot = join(root, 'data')
      const handoffDirectory = join(root, 'handoff')
      const state = join(
        configRoot,
        'installations',
        createHash('sha256').update(appBundle).digest('hex')
      )
      await fs.mkdir(state, { recursive: true })
      await fs.mkdir(handoffDirectory)
      let ordinaryEntryCalls = 0
      const ctx = {
        root,
        appBundle,
        executable,
        sourcePid: child.pid,
        configRoot,
        profile: join(root, 'profile'),
        targetVersion: '2.0.0',
        report: {},
        processes: async () => [],
        wait: async (label, fn, timeout) => {
          const until = Date.now() + timeout
          while (Date.now() < until) {
            if (await fn()) return
            await new Promise((done) => setTimeout(done, 10))
          }
          throw new Error(label)
        },
        run: async (command, args) => ({
          stdout: execFileSync(command, args, { encoding: 'utf8' })
        }),
        openOrdinaryEntry: async () => {
          ordinaryEntryCalls++
        }
      }
      driver = createInterruptionScenario('M08', ctx)
      await driver.beforeApply()
      const fixtureRequest = {
        ...request,
        applicationPath: appBundle,
        profilePath: ctx.profile,
        startupOptions: { profilePath: ctx.profile, configRoot },
        installerPath: join(handoffDirectory, 'update.zip')
      }
      const fixtureBytes = Buffer.from(JSON.stringify(fixtureRequest))
      const fixtureRecord = {
        ...record,
        installationRoot: appBundle,
        handoffDirectory,
        requestSha256: createHash('sha256').update(fixtureBytes).digest('hex')
      }
      const sourceExited = once(child, 'exit')
      await driver.apply(ctx, async () => {
        await fs.writeFile(join(handoffDirectory, 'request.json'), fixtureBytes)
        await fs.writeFile(
          join(state, 'windows-update-in-progress.json'),
          JSON.stringify(fixtureRecord)
        )
      })
      await sourceExited
      assert.equal(child.signalCode, 'SIGKILL')
      assert.equal(ordinaryEntryCalls, 1)
      assert.equal(ctx.report.interruption.phase, 'preparing')
      assert.equal(ctx.report.interruption.sourceUnchanged, true)
      assert.equal(protectedProcess.exitCode, null)
      assert.equal(protectedProcess.signalCode, null)
    } finally {
      await driver?.cleanup()
      for (const proc of [child, protectedProcess]) {
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          const exited = once(proc, 'exit')
          proc.kill('SIGKILL')
          await exited
        }
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)
