import { expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { runWithCleanup, test } from '../fixtures/electron-app'
import { captureFixtureProcess, cleanupFixtureProcess } from '../fixtures/local-service-cleanup'

const enabled = process.env.OPEN_SCIENCE_UPDATE_OCCUPANCY_CERT === '1'
test.skip(!enabled, 'Enabled by packaged update certification.')

test('certifies real packaged update occupancy and recovery', async ({ app }, testInfo) => {
  test.setTimeout(240_000)
  const executable = process.env.OPEN_SCIENCE_E2E_EXECUTABLE
  expect(executable, 'Certification requires the candidate packaged executable.').toBeTruthy()
  expect((await app.captureBrandState()).packaged).toBe(true)
  await app.completeOnboarding()
  const recheck = async (): Promise<void> => {
    const status = await app.page.evaluate(() => window.api.update.recheck())
    expect(status.reason).toBeUndefined()
    expect(status.error).toBeUndefined()
    expect(status.recovery?.canRetryInstall).toBe(true)
  }
  // No IPC overrides: exercise the candidate updater, live runtime registration and native scan.
  await recheck()
  const resources =
    process.platform === 'darwin'
      ? join(dirname(executable!), '..', 'Resources')
      : join(dirname(executable!), 'resources')
  const node = join(resources, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const foreign = spawn(node, ['-e', "process.stdout.write('ready');process.stdin.resume()"], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot }
  })
  const captured = captureFixtureProcess(foreign)
  await runWithCleanup(
    async () => {
      await once(foreign.stdout!, 'data')
      const status = await app.page.evaluate(() => window.api.update.recheck())
      expect(status).toMatchObject({
        reason: 'installation-busy',
        recovery: {
          detail: 'foreign-process',
          canRetryInstall: false,
          blockingProcesses: expect.arrayContaining([expect.objectContaining({ pid: foreign.pid })])
        }
      })
      await testInfo.attach('foreign-process-blocked', {
        body: JSON.stringify(status),
        contentType: 'application/json'
      })
      const exited = once(foreign, 'exit')
      foreign.stdin!.end()
      await exited
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
