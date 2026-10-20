import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchEnvironment, launchOpenScience } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'

test('reacquires a mounted managed image capability after recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-preview-recovery-'))
  const roots = {
    storageRoot: join(root, 'storage'),
    userDataRoot: join(root, 'profile'),
    fakeAgentBinRoot: join(root, 'bin'),
    fakeRemoteItRoot: join(root, 'remote'),
    fakeRemoteItState: join(root, 'remote.json')
  }
  await mkdir(roots.storageRoot)
  const app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
  try {
    const page = await app.firstWindow()
    await expect
      .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), { timeout: 60_000 })
      .toMatchObject({ phase: 'ready' })
    await page.evaluate(() => window.api.settings.markOnboardingComplete())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await createProjectViaUi(page, 'Preview recovery')
    await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
    await page.evaluate(async () => {
      const project = (await window.api.projects.list()).find(
        (entry) => entry.name === 'Preview recovery'
      )!
      const sessionId = 'preview-recovery-session'
      await window.api.sessions.saveSession({
        id: sessionId,
        projectId: project.id,
        cwd: (await window.api.storage.getInfo()).dataRoot,
        title: 'Preview fixture',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        messages: []
      })
      const chunk = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        ),
        (char) => char.charCodeAt(0)
      )
      const transferId = crypto.randomUUID()
      await window.api.uploads.beginTransfer({
        transferId,
        name: 'recovery-preview.png',
        mimeType: 'image/png',
        size: chunk.length
      })
      await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
      const attachment = await window.api.uploads.finishTransfer({ transferId })
      await window.api.uploads.finalizeSession({
        projectId: project.id,
        sessionId,
        attachments: [attachment]
      })
    })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const image = page.getByRole('img', { name: 'Preview of recovery-preview.png' })
    await expect(image).toBeVisible()
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    const previous = await image.getAttribute('src')
    const composer = page.getByRole('textbox', { name: 'Ask anything' })
    await composer.click()
    await expect(composer).toBeFocused()
    await app.evaluate(() => {
      const pipe = (
        process as NodeJS.Process & {
          _getActiveHandles(): {
            readable?: boolean
            writable?: boolean
            _handle?: { constructor: { name: string } }
            destroy(): void
          }[]
        }
      )
        ._getActiveHandles()
        .find(
          (handle) =>
            handle.readable && handle.writable && handle._handle?.constructor.name === 'Pipe'
        )
      if (!pipe) throw new Error('Desktop pipe missing')
      pipe.destroy()
    })
    await expect(page.getByRole('button', { name: 'Quit', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
      .toMatchObject({ phase: 'connected' })
    await expect(image).toBeVisible()
    await expect.poll(() => image.getAttribute('src')).not.toBe(previous)
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await expect(composer).toBeFocused()
    // Exercise the current native Menu callback and its renderer event after attachment replacement.
    const beforeZoom = await page.evaluate(() => window.devicePixelRatio)
    await page.evaluate(() => {
      const probe = window as typeof window & { recoveryScale?: number }
      window.api.window.onInterfaceScaleShortcut?.((scale) => {
        probe.recoveryScale = scale
      })
    })
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((entry) => entry.submenu?.items ?? [])
        .find((entry) => /zoom in/i.test(entry.label))
      if (!item) throw new Error('Native Zoom In menu missing')
      const window = BrowserWindow.getAllWindows()[0]
      Reflect.apply(item.click, item, [item, window, {}])
    })
    await expect
      .poll(() =>
        page.evaluate(() => (window as typeof window & { recoveryScale?: number }).recoveryScale)
      )
      .toBeGreaterThan(1)
    await expect
      .poll(() => page.evaluate(() => window.devicePixelRatio))
      .toBeGreaterThan(beforeZoom)
    // Observe the real native availability callback without changing platform support or permissions.
    await app.evaluate(({ Notification }) => {
      const original = Notification.isSupported.bind(Notification)
      const probe = globalThis as typeof globalThis & { recoveryNotificationChecks: number }
      probe.recoveryNotificationChecks = 0
      Notification.isSupported = (): boolean => {
        probe.recoveryNotificationChecks++
        return original()
      }
    })
    const notification = await page.evaluate(async () => {
      const api = window.api.notifications
      if (!api.getDesktopAvailability || !api.sendTest)
        throw new Error('Desktop notification methods missing after recovery')
      return { availability: await api.getDesktopAvailability(), result: await api.sendTest() }
    })
    expect(['supported', 'unavailable']).toContain(notification.availability)
    expect(['shown', 'unconfirmed', 'unavailable', 'failed']).toContain(notification.result)
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { recoveryNotificationChecks: number })
            .recoveryNotificationChecks
      )
    ).toBeGreaterThan(0)
    console.info('Post-recovery native notification owner result:', JSON.stringify(notification))
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
      env: { ...launchEnvironment(roots.storageRoot), OPEN_SCIENCE_USER_DATA: roots.userDataRoot },
      timeout: 30_000
    }).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
