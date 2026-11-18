import { expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { runWithCleanup, test } from '../fixtures/electron-app'
import {
  captureFixtureProcess,
  cleanupFixtureProcess,
  observeFixtureService
} from '../fixtures/local-service-cleanup'
import { inspectInstallationProcessesAsync } from '../../src/main/update/installation-occupancy'
import {
  installationStateDirectory,
  type InstallationRuntime
} from '../../src/main/update/installation-protection'

const enabled = process.env.OPEN_SCIENCE_UPDATE_OCCUPANCY_CERT === '1'
test.skip(!enabled, 'Enabled by packaged update certification.')

test('certifies real packaged update occupancy and recovery', async ({ app }, testInfo) => {
  test.setTimeout(240_000)
  const executable = process.env.OPEN_SCIENCE_E2E_EXECUTABLE
  expect(executable, 'Certification requires the candidate packaged executable.').toBeTruthy()
  const brand = await app.captureBrandState()
  expect(brand.packaged).toBe(true)
  await app.completeOnboarding()
  const initial = await app.page.evaluate(() => window.api.update.recheck())
  const manualNightly = initial.applyKind === 'installer'
  if (manualNightly) {
    // Ad-hoc macOS nightlies intentionally have no in-place updater. A stable candidate
    // selecting this fallback must fail certification rather than silently lose IPC coverage.
    expect(process.platform).toBe('darwin')
    expect(initial.current).toMatch(/-nightly\./)
  } else expect(initial.applyKind).toBe('restart')
  await testInfo.attach('update-occupancy-coverage', {
    body: JSON.stringify({
      mode: manualNightly ? 'manual-nightly-reader-leases' : 'updater-recheck'
    }),
    contentType: 'application/json'
  })
  const resources =
    process.platform === 'darwin'
      ? join(dirname(executable!), '..', 'Resources')
      : join(dirname(executable!), 'resources')
  const installationRoot = await realpath(
    process.platform === 'darwin' ? join(resources, '..', '..') : dirname(resources)
  )
  const inspectNightlyReaders = async (): Promise<{
    occupants: number[]
    registered: number[]
  }> => {
    const configRoot = join(dirname(brand.profile), 'storage')
    const runtime = await observeFixtureService(configRoot)
    expect(runtime, 'The packaged backend must be live.').toBeDefined()
    const directory = installationStateDirectory({
      installationRoot,
      stateRoot: join(configRoot, 'installation-state')
    })
    const occupants = await inspectInstallationProcessesAsync(installationRoot)
    const registrations = await Promise.all(
      (await readdir(directory))
        .filter((name) => /^[\da-f-]{36}\.json$/.test(name))
        .map(async (name) => ({
          name,
          identity: JSON.parse(await readFile(join(directory, name), 'utf8')) as InstallationRuntime
        }))
    )
    const readers = registrations.filter(
      ({ identity }) =>
        identity.role === 'helper' &&
        identity.configRoot === configRoot &&
        identity.owner?.pid === runtime!.pid &&
        identity.owner.generation === runtime!.generation &&
        identity.owner.configRoot === configRoot
    )
    expect(readers, 'A clean packaged startup must register its detached log reader.').toHaveLength(
      1
    )
    expect(occupants).toContain(runtime!.pid)
    for (const { name, identity } of readers) {
      expect(occupants).toContain(identity.pid)
      const probe = new DatabaseSync(join(directory, name.replace(/\.json$/, '.sqlite')))
      try {
        let lockError: unknown
        try {
          probe.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
        } catch (error) {
          lockError = error
        }
        expect([5, 6]).toContain((lockError as { errcode?: number } | undefined)?.errcode)
      } finally {
        probe.close()
      }
    }
    return { occupants, registered: registrations.map(({ identity }) => identity.pid) }
  }
  const recheck = async (): Promise<void> => {
    if (manualNightly) {
      await inspectNightlyReaders()
      return
    }
    const status = await app.page.evaluate(() => window.api.update.recheck())
    expect(status.reason).toBeUndefined()
    expect(status.error).toBeUndefined()
    expect(status.recovery?.canRetryInstall).toBe(true)
  }
  // No IPC overrides. Manual Mac nightlies validate the real reader lease/native occupancy;
  // in-place candidates also exercise the candidate's complete update admission path.
  await recheck()
  const node = join(resources, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const foreign = spawn(node, ['-e', "process.stdout.write('ready');process.stdin.resume()"], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot }
  })
  const captured = captureFixtureProcess(foreign)
  await runWithCleanup(
    async () => {
      await once(foreign.stdout!, 'data')
      const status = manualNightly
        ? await inspectNightlyReaders()
        : await app.page.evaluate(() => window.api.update.recheck())
      if ('occupants' in status) {
        expect(status.occupants).toContain(foreign.pid)
        expect(status.registered).not.toContain(foreign.pid)
      } else
        expect(status).toMatchObject({
          reason: 'installation-busy',
          recovery: {
            detail: 'foreign-process',
            canRetryInstall: false,
            blockingProcesses: expect.arrayContaining([
              expect.objectContaining({ pid: foreign.pid })
            ])
          }
        })
      await testInfo.attach(
        manualNightly ? 'foreign-process-unregistered' : 'foreign-process-blocked',
        {
          body: JSON.stringify(status),
          contentType: 'application/json'
        }
      )
      const exited = once(foreign, 'exit')
      foreign.stdin!.end()
      await exited
      if (manualNightly)
        expect((await inspectNightlyReaders()).occupants).not.toContain(foreign.pid)
      await recheck()
      await app.restart()
      await recheck()
      await testInfo.attach('update-occupancy-recovered', {
        body: await app.page.screenshot(),
        contentType: 'image/png'
      })
    },
    () => cleanupFixtureProcess(captured)
  )
})
