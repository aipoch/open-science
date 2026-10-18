import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
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
    // This direct launcher does not run the shared fixture's locale setup.
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en')
    const additionalWindow = application.waitForEvent('window')
    await application.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const { join, sep } = process.getBuiltinModule('node:path')
      const { realpathSync } = process.getBuiltinModule('node:fs')
      const mainRoot = realpathSync(join(app.getAppPath(), 'out', 'main'))
      const require = createRequire(join(app.getAppPath(), 'package.json'))
      const factory = Object.values(require.cache).find(
        (entry) =>
          typeof entry?.filename === 'string' &&
          entry.filename.startsWith(mainRoot + sep) &&
          typeof entry.exports?.createMainWindow === 'function'
      )
      if (!factory) throw new Error('Built main-window factory missing')
      factory.exports.createMainWindow()
    })
    const secondPage = await additionalWindow
    await expect
      .poll(() => secondPage.evaluate(() => window.api?.desktopRuntime?.getState()))
      .toMatchObject({ phase: 'connected' })
    await test.step('isolates one failed window and restores its authoritative state', async () => {
      // Inject only the native send failure; use the real app, backend, connection and renderer APIs.
      await application.evaluate(({ BrowserWindow, dialog }) => {
        dialog.showErrorBox = (_title, content): void => {
          ;(globalThis as typeof globalThis & { desktopEventError?: string }).desktopEventError =
            content
        }
        const state = globalThis as typeof globalThis & { desktopEventFaultTriggered?: boolean }
        state.desktopEventFaultTriggered = false
        const contents = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0].webContents
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
            () =>
              (globalThis as typeof globalThis & { desktopEventError?: string }).desktopEventError
          )
        }),
        contentType: 'application/json'
      })
      expect(result).toEqual({ connected: true })
      await expect.poll(() => secondPage.evaluate(() => document.documentElement.lang)).toBe('de')
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()), { timeout: 20_000 })
        .toMatchObject({ phase: 'connected' })
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de')
      await page.evaluate(() => window.api.settings.getSettings())
      await expect
        .poll(() => secondPage.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'connected' })
      await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en')
    })
    await test.step('isolates buffered replay failure while another window recovers', async () => {
      await application.evaluate(({ BrowserWindow, ipcMain }) => {
        type Probe = {
          acknowledgements: number
          sawBufferedEvent: boolean
          armed: boolean
          failed: boolean
          release(): void
        }
        const probe: Probe = {
          acknowledgements: 0,
          sawBufferedEvent: false,
          armed: false,
          failed: false,
          release: () => undefined
        }
        ;(globalThis as typeof globalThis & { replayProbe: Probe }).replayProbe = probe
        const barrier = new Promise<void>((resolve) => {
          probe.release = resolve
        })
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => Promise<unknown>
        >
        const acknowledge = handlers.get('desktop-runtime:reconciled')!
        handlers.set('desktop-runtime:reconciled', async (...args) => {
          probe.acknowledgements++
          await barrier
          return acknowledge(...args)
        })
        const contents = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0].webContents
        const send = contents.send.bind(contents)
        contents.send = (channel, ...args): void => {
          if (channel === 'settings:changed' && probe.armed) {
            probe.armed = false
            probe.failed = true
            contents.send = send
            throw new Error('Controlled buffered replay delivery failure')
          }
          send(channel, ...args)
        }
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
          )!
        pipe.destroy()
      })
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { replayProbe: { acknowledgements: number } })
                .replayProbe.acknowledgements
          )
        )
        .toBe(2)
      await application.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & { replayProbe: { sawBufferedEvent: boolean } }
        ).replayProbe
        type Pipe = {
          readable?: boolean
          writable?: boolean
          _handle?: { constructor: { name: string } }
          on(name: string, callback: (chunk: Buffer) => void): void
          off(name: string, callback: (chunk: Buffer) => void): void
        }
        const pipe = (process as NodeJS.Process & { _getActiveHandles(): Pipe[] })
          ._getActiveHandles()
          .find(
            (handle) =>
              handle.readable && handle.writable && handle._handle?.constructor.name === 'Pipe'
          )!
        const listener = (chunk: Buffer): void => {
          if (chunk.includes(Buffer.from('"closePreference":"quit"'))) {
            probe.sawBufferedEvent = true
            pipe.off('data', listener)
          }
        }
        pipe.on('data', listener)
      })
      const web = JSON.parse(
        await readFile(join(roots.storageRoot, 'web-service.json'), 'utf8')
      ) as {
        port: number
      }
      const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
      const changed = await fetch(
        `http://127.0.0.1:${web.port}/rpc/settings:set-close-preference`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-open-science-client': 'recovery-event-fixture'
          },
          body: JSON.stringify({ protocolVersion: 1, args: [{ preference: 'quit' }] })
        }
      )
      expect(changed.ok).toBe(true)
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { replayProbe: { sawBufferedEvent: boolean } })
                .replayProbe.sawBufferedEvent
          )
        )
        .toBe(true)
      await application.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & { replayProbe: { armed: boolean; release(): void } }
        ).replayProbe
        probe.armed = true
        probe.release()
      })
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { replayProbe: { failed: boolean } }).replayProbe
                .failed
          )
        )
        .toBe(true)
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'disconnected' })
      await expect
        .poll(() => secondPage.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'connected' })
      expect(
        (await secondPage.evaluate(() => window.api.settings.getSettings())).closePreference
      ).toBe('quit')
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'connected' })
      expect((await page.evaluate(() => window.api.settings.getSettings())).closePreference).toBe(
        'quit'
      )
    })
    await test.step('routes native upload progress to the recovered document', async () => {
      // New document progress must reach its owner and never the other live window.
      for (const current of [page, secondPage])
        await current.evaluate(() => {
          const probe = window as typeof window & { recoveredTransfers: string[] }
          probe.recoveredTransfers = []
          window.api.uploads.onTransferProgress?.((progress) => {
            probe.recoveredTransfers.push(progress.transferId)
          })
        })
      const sourcePath = join(root, 'recovered-upload.txt')
      await writeFile(sourcePath, Buffer.alloc(256 * 1024, 'a'))
      await page.evaluate(() => {
        const input = document.createElement('input')
        input.type = 'file'
        input.id = 'recovered-file'
        document.body.append(input)
      })
      await page.locator('#recovered-file').setInputFiles(sourcePath)
      const transferId = await page.evaluate(async () => {
        const input = document.querySelector<HTMLInputElement>('#recovered-file')!
        const file = input.files![0]
        const transferId = crypto.randomUUID()
        if (!window.api.uploads.stageLocalFile) throw new Error('Native upload API missing')
        const attachment = await window.api.uploads.stageLocalFile(file, {
          transferId,
          name: file.name,
          size: file.size,
          mimeType: file.type
        })
        if (!attachment) throw new Error('Native upload did not claim a real local File')
        input.remove()
        return transferId
      })
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { recoveredTransfers: string[] }).recoveredTransfers
          )
        )
        .toContain(transferId)
      await secondPage.evaluate(() => window.api.settings.getSettings())
      expect(
        await secondPage.evaluate(
          () => (window as typeof window & { recoveredTransfers: string[] }).recoveredTransfers
        )
      ).toEqual([])
    })
    await test.step('allows recovery after canceling Quit while renderer acknowledgements are pending', async () => {
      // Hold real renderer ACKs during a new recovery, then cancel an actual Quit attempt.
      await application.evaluate(({ ipcMain, dialog }) => {
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => Promise<unknown>
        >
        const original = handlers.get('desktop-runtime:reconciled')!
        const probe = { acknowledgements: 0, confirmations: 0, release: (): void => undefined }
        const gate = new Promise<void>((resolve) => {
          probe.release = resolve
        })
        ;(globalThis as typeof globalThis & { quitRace: typeof probe }).quitRace = probe
        handlers.set('desktop-runtime:reconciled', async (...args) => {
          probe.acknowledgements++
          await gate
          return original(...args)
        })
        dialog.showMessageBox = (async () => {
          probe.confirmations++
          handlers.set('desktop-runtime:reconciled', original)
          return { response: 0, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
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
            (entry) =>
              entry.readable && entry.writable && entry._handle?.constructor.name === 'Pipe'
          )
        if (!pipe) throw new Error('Recovery race pipe missing')
        pipe.destroy()
      })
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { quitRace: { acknowledgements: number } })
                .quitRace.acknowledgements
          )
        )
        .toBe(2)
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'reconciling' })
      // Recovery hides its buttons while reconciling; native Quit remains available.
      await application.evaluate(({ app }) => app.quit())
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'disconnected', closing: false })
      expect(
        await application.evaluate(
          () =>
            (globalThis as typeof globalThis & { quitRace: { confirmations: number } }).quitRace
              .confirmations
        )
      ).toBe(1)
      await application.evaluate(() =>
        (globalThis as typeof globalThis & { quitRace: { release(): void } }).quitRace.release()
      )
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      for (const current of [page, secondPage]) {
        await expect
          .poll(() => current.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'connected', closing: false })
        await current.evaluate(() => window.api.settings.getSettings())
      }
    })
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
