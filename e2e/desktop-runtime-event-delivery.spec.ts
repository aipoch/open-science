import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchEnvironment, launchOpenScience } from './fixtures/electron-app'

// Playwright requires a destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test('keeps real desktop RPC connected when a window rejects event delivery', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-event-delivery-'))
  const roots = {
    storageRoot: join(root, 'storage'),
    userDataRoot: join(root, 'profile'),
    fakeAgentBinRoot: join(root, 'bin'),
    fakeRemoteItRoot: join(root, 'remote'),
    fakeRemoteItState: join(root, 'remote-state.json')
  }
  await mkdir(roots.storageRoot)
  const application = await launchOpenScience(
    roots,
    false,
    false,
    roots.fakeRemoteItRoot,
    'hidden',
    false
  )
  try {
    const page = await application.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60000 })
      .toMatchObject({ phase: 'ready' })
    // Inject only the native send failure; use the real app, backend, connection and renderer APIs.
    await application.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showErrorBox = (_title, content): void => {
        ;(globalThis as typeof globalThis & { desktopEventError?: string }).desktopEventError =
          content
      }
      const state = globalThis as typeof globalThis & { desktopEventFaultTriggered?: boolean }
      state.desktopEventFaultTriggered = false
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const original = contents.send.bind(contents)
      contents.send = (channel, ...args): void => {
        if (channel === 'locale:changed') {
          state.desktopEventFaultTriggered = true
          contents.send = original
          throw new Error('Controlled window delivery failure')
        }
        original(channel, ...args)
      }
    })
    const result = await page.evaluate(async () => {
      try {
        await window.api.locale.setPreference({ preference: 'de' })
        await window.api.settings.getSettings()
        return { connected: true }
      } catch (error) {
        return { connected: false, message: String(error) }
      }
    })
    expect(
      await application.evaluate(
        () =>
          (globalThis as typeof globalThis & { desktopEventFaultTriggered?: boolean })
            .desktopEventFaultTriggered
      )
    ).toBe(true)
    await testInfo.attach('real-electron-event-delivery', {
      body: JSON.stringify({
        result,
        desktopError: await application.evaluate(
          () => (globalThis as typeof globalThis & { desktopEventError?: string }).desktopEventError
        )
      }),
      contentType: 'application/json'
    })
    expect(result).toEqual({ connected: true })
  } finally {
    // Stop only the backend registered beneath this test's unique storage root.
    const stopping = promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
      env: {
        ...launchEnvironment(roots.storageRoot),
        OPEN_SCIENCE_USER_DATA: roots.userDataRoot
      },
      timeout: 30000
    }).then(
      () => true,
      () => false
    )
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await application.close().catch(() => undefined)
    const stopped = await stopping
    expect(stopped, `Test backend cleanup failed; retained evidence at ${root}`).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
