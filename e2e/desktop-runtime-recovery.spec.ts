import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { launchOpenScience, launchEnvironment } from './fixtures/electron-app'
import { createProjectViaUi, homeNewProjectButton } from './fixtures/project'

type RuntimeOwner = { pid: number; port: number; generation: string }

const processHasExited = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

const cleanupRecoveryFixture = async ({
  app,
  server,
  owner,
  env,
  root,
  storageRoot
}: {
  app?: ElectronApplication
  server?: ChildProcess
  owner?: RuntimeOwner
  env: NodeJS.ProcessEnv
  root: string
  storageRoot: string
}): Promise<void> => {
  try {
    const runtime =
      owner ??
      (await readFile(join(storageRoot, 'runtime-owner.json'), 'utf8')
        .then((value) => JSON.parse(value) as RuntimeOwner)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        }))
    if (app) {
      const desktop = app.process()
      await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
      if (desktop.exitCode === null && desktop.signalCode === null) desktop.kill('SIGKILL')
      await expect.poll(() => desktop.exitCode !== null || desktop.signalCode !== null).toBe(true)
    }
    try {
      // The backend belongs to this unique profile even after app.close() clears the app handle.
      await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
        env,
        timeout: 30_000
      })
    } finally {
      // Only the actual fixture-spawned child can receive a signal; never signal a discovered PID.
      if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
      if (server)
        await expect.poll(() => server.exitCode !== null || server.signalCode !== null).toBe(true)
    }
    if (runtime)
      await expect.poll(() => processHasExited(runtime.pid), { timeout: 30_000 }).toBe(true)
  } catch (error) {
    throw new Error(`Recovery fixture cleanup failed; retained evidence at ${root}`, {
      cause: error
    })
  }
  await rm(root, { recursive: true, force: true })
}

// Uses the actual Electron main process and private pipe; no application test IPC is installed.
for (const borrowed of [false, true])
  test(`manual recovery restores files and drafts with ${borrowed ? 'borrowed' : 'owned'} backend`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-recovery-with spaces-'))
    const roots = {
      storageRoot: join(root, 'storage'),
      userDataRoot: join(root, 'profile'),
      fakeAgentBinRoot: join(root, 'bin'),
      fakeRemoteItRoot: join(root, 'remote'),
      fakeRemoteItState: join(root, 'remote-state.json')
    }
    await mkdir(roots.storageRoot)
    const env = {
      ...launchEnvironment(roots.storageRoot),
      OPEN_SCIENCE_USER_DATA: roots.userDataRoot,
      ...(process.platform === 'darwin' && !process.env.OPEN_SCIENCE_E2E_EXECUTABLE
        ? {
            NODE_OPTIONS: `--require=${JSON.stringify(resolve('e2e/fixtures/mock-node-credentials.cjs'))}`
          }
        : {})
    }
    const server = borrowed
      ? spawn(process.execPath, [resolve('out/backend/index.cjs'), '--development', '--serve'], {
          env,
          stdio: 'ignore'
        })
      : undefined
    const serverExit = server
      ? new Promise<void>((resolve) => server.once('exit', () => resolve()))
      : undefined
    let app: ElectronApplication | undefined
    let owner: RuntimeOwner | undefined
    try {
      if (server)
        await expect
          .poll(
            async () => {
              try {
                const state = JSON.parse(
                  await readFile(join(roots.storageRoot, 'web-service.json'), 'utf8')
                )
                const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
                return (
                  await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, {
                    headers: { authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(1000)
                  })
                ).ok
              } catch {
                return false
              }
            },
            { timeout: 60_000 }
          )
          .toBe(true)
      app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
      const page = await app.firstWindow()
      await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
      await expect
        .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), {
          timeout: 60_000
        })
        .toMatchObject({ phase: 'ready' })
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ phase: 'connected' })
      owner = JSON.parse(
        await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
      ) as RuntimeOwner
      await page.evaluate(() => window.api.settings.markOnboardingComplete())
      await page.reload({ waitUntil: 'domcontentloaded' })
      await createProjectViaUi(page, 'Recovery file fixture')
      await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
      const seeded = await page.evaluate(
        async (imageCount) => {
          const project = (await window.api.projects.list()).find(
            (entry) => entry.name === 'Recovery file fixture'
          )!
          const image = Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
            ),
            (char) => char.charCodeAt(0)
          )
          const sessionId = 'recovery-files-session'
          await window.api.sessions.saveSession({
            id: sessionId,
            projectId: project.id,
            title: 'Recovery files',
            cwd: (await window.api.storage.getInfo()).dataRoot,
            status: 'idle',
            createdAt: 1,
            updatedAt: 1,
            messages: []
          })
          const attachments = []
          for (let index = 0; index < imageCount; index++) {
            const transferId = crypto.randomUUID()
            await window.api.uploads.beginTransfer({
              transferId,
              name: `recovery-image-${index}.png`,
              mimeType: 'image/png',
              size: image.length
            })
            await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk: image })
            attachments.push(await window.api.uploads.finishTransfer({ transferId }))
          }
          await window.api.uploads.finalizeSession({
            projectId: project.id,
            sessionId,
            attachments
          })
          return { projectId: project.id, sessionId }
        },
        borrowed ? 1 : 5
      )
      if (!borrowed)
        await app.evaluate(({ ipcMain }) => {
          type Probe = {
            release?: () => void
            active: number
            maximum: number
            starts: number
            byteLimits: number[]
          }
          const probe: Probe = { active: 0, maximum: 0, starts: 0, byteLimits: [] }
          ;(globalThis as typeof globalThis & { thumbnailProbe: Probe }).thumbnailProbe = probe
          const gate = new Promise<void>((resolve) => {
            probe.release = resolve
          })
          const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
            string,
            (event: unknown, request: { path: string; maxBytes: number }) => Promise<unknown>
          >
          const original = handlers.get('uploads:read-preview')!
          if (!original) throw new Error('Upload preview handler missing')
          handlers.set('uploads:read-preview', async (event, request) => {
            probe.active++
            probe.maximum = Math.max(probe.maximum, probe.active)
            probe.starts++
            probe.byteLimits.push(request.maxBytes)
            try {
              await gate
              return await original(event, request)
            } finally {
              probe.active--
            }
          })
        })
      const composer = page.getByRole('textbox', { name: 'Ask anything' })
      await composer.fill('Keep this unsent draft @recovery')
      await expect(
        page.getByRole('option').filter({ hasText: 'recovery-image' }).first()
      ).toBeVisible()
      if (!borrowed) {
        // One real IPC smoke covers the shared physical budget across popup instances.
        await expect
          .poll(() =>
            app!.evaluate(
              () =>
                (globalThis as typeof globalThis & { thumbnailProbe: { starts: number } })
                  .thumbnailProbe.starts
            )
          )
          .toBe(4)
        await composer.press('Escape')
        await composer.fill('Keep this unsent draft @recovery')
        await expect(page.getByRole('option').first()).toBeVisible()
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
        expect(
          await app.evaluate(() => {
            const probe = (
              globalThis as typeof globalThis & {
                thumbnailProbe: { active: number; maximum: number; starts: number }
              }
            ).thumbnailProbe
            return { active: probe.active, maximum: probe.maximum, starts: probe.starts }
          })
        ).toEqual({ active: 4, maximum: 4, starts: 4 })
        await app.evaluate(() =>
          (
            globalThis as typeof globalThis & { thumbnailProbe: { release(): void } }
          ).thumbnailProbe.release()
        )
        await expect
          .poll(() =>
            app!.evaluate(() => {
              const probe = (
                globalThis as typeof globalThis & {
                  thumbnailProbe: { active: number; starts: number }
                }
              ).thumbnailProbe
              return probe.starts > 4 && probe.active === 0
            })
          )
          .toBe(true)
        const probe = await app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                thumbnailProbe: { maximum: number; byteLimits: number[] }
              }
            ).thumbnailProbe
        )
        expect(probe.maximum).toBe(4)
        expect(probe.byteLimits.every((limit) => limit === 256 * 1024)).toBe(true)
      }
      await page.evaluate(async (request) => {
        await Promise.all([
          window.api.settings.getSettings(),
          window.api.compute.list(),
          window.api.sessions.loadOne(request)
        ])
      }, seeded)
      // Observe recovery through the real preload/IPC event boundary without external internet.
      await app.evaluate(({ ipcMain, powerMonitor }) => {
        const handlers = (
          ipcMain as typeof ipcMain & {
            _invokeHandlers: Map<string, (...args: unknown[]) => unknown>
          }
        )._invokeHandlers
        const original = handlers.get('network:check-connectivity')!
        if (!original) throw new Error('Network handler missing')
        const probe = { calls: 0 }
        ;(
          globalThis as typeof globalThis & { recoveryNetworkProbe: typeof probe }
        ).recoveryNetworkProbe = probe
        const check = (): boolean => {
          probe.calls++
          return true
        }
        handlers.set('network:check-connectivity', check)
        // Recovery re-registers the relay. Keep observing the new public IPC handler too.
        const handle = ipcMain.handle.bind(ipcMain)
        ipcMain.handle = (channel, listener) =>
          handle(channel, channel === 'network:check-connectivity' ? check : listener)
        powerMonitor.emit('resume')
      })
      await expect
        .poll(() =>
          app!.evaluate(
            () =>
              (globalThis as typeof globalThis & { recoveryNetworkProbe: { calls: number } })
                .recoveryNetworkProbe.calls
          )
        )
        .toBeGreaterThan(0)
      const networkChecksBeforeLoss = await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { recoveryNetworkProbe: { calls: number } })
            .recoveryNetworkProbe.calls
      )
      const before = owner
      // Pipe sockets in Electron main contain only the private desktop connection; stdio and the
      // inspector are excluded by writable/readable handle identity. Assert before injecting loss.
      const destroyed = await app.evaluate(() => {
        const handles = (
          process as NodeJS.Process & {
            _getActiveHandles(): {
              constructor: { name: string }
              readable?: boolean
              writable?: boolean
              _handle?: { constructor: { name: string } }
              destroy?: () => void
            }[]
          }
        )._getActiveHandles()
        const pipes = handles.filter(
          (handle) =>
            handle.constructor.name === 'Socket' &&
            handle.readable &&
            handle.writable &&
            handle._handle?.constructor.name === 'Pipe' &&
            handle !== process.stdin &&
            handle !== process.stdout &&
            handle !== process.stderr
        )
        if (pipes.length !== 1)
          throw new Error(`Expected one private desktop pipe, found ${pipes.length}.`)
        pipes[0].destroy!()
        return pipes.length
      })
      expect(destroyed).toBe(1)
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      })
      await page.getByRole('button', { name: 'Quit', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({ closing: false, phase: 'disconnected' })
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()), { timeout: 20_000 })
        .toMatchObject({ phase: 'connected' })
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).not.toBeVisible()
      await expect
        .poll(() =>
          app!.evaluate(
            () =>
              (globalThis as typeof globalThis & { recoveryNetworkProbe: { calls: number } })
                .recoveryNetworkProbe.calls
          )
        )
        .toBeGreaterThan(networkChecksBeforeLoss)
      await expect(composer).toContainText('Keep this unsent draft')
      await composer.fill('Keep this unsent draft @recovery-image-0')
      const selected = page.getByRole('option').filter({ hasText: 'recovery-image-0.png' })
      await expect(selected).toBeVisible()
      await selected.click()
      await expect(composer).toContainText('Keep this unsent draft')
      await expect(composer).toContainText('recovery-image-0.png')
      expect(
        (await page.evaluate(() => window.api.sessions.loadAll())).sessions.every(
          (entry) => entry.messages.length === 0
        )
      ).toBe(true)

      expect(
        JSON.parse(await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8'))
      ).toEqual(before)
      await page.evaluate(async () => {
        await window.api.settings.getSettings()
        await window.api.sessions.list()
        await window.api.compute.list()
      })
      const savedBeforeLoss = await page.evaluate(
        (request) => window.api.sessions.loadOne(request),
        seeded
      )
      const lostTitle = 'saved-once-response-loss-fixture'
      await app.evaluate((_electron, marker) => {
        type Pipe = {
          readable?: boolean
          writable?: boolean
          _handle?: { constructor: { name: string } }
          emit(event: string, ...args: unknown[]): boolean
          destroy(): void
        }
        const handles = (
          process as NodeJS.Process & { _getActiveHandles(): Pipe[] }
        )._getActiveHandles()
        const pipe = handles.find(
          (handle) =>
            handle.readable && handle.writable && handle._handle?.constructor.name === 'Pipe'
        )!
        if (!pipe) throw new Error('Desktop pipe missing')
        const emit = pipe.emit
        pipe.emit = function (event, ...args): boolean {
          if (
            event === 'data' &&
            Buffer.isBuffer(args[0]) &&
            args[0].includes(Buffer.from(marker))
          ) {
            pipe.emit = emit
            pipe.destroy()
            return true
          }
          return emit.call(this, event, ...args)
        }
      }, lostTitle)
      const saveOutcome = await page.evaluate(
        async ({ session, title }) => {
          try {
            await window.api.sessions.saveSession({ ...session!, title })
            return 'unexpected success'
          } catch (error) {
            return String(error)
          }
        },
        { session: savedBeforeLoss, title: lostTitle }
      )
      expect(saveOutcome).toContain('result of a submitted operation is unknown')
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click({ clickCount: 2 })
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()), { timeout: 20_000 })
        .toMatchObject({ phase: 'connected' })
      const savedAfterRecovery = await page.evaluate(
        (request) => window.api.sessions.loadOne(request),
        seeded
      )
      expect(savedAfterRecovery?.title).toBe(lostTitle)
      expect(savedAfterRecovery?.revision).toBe((savedBeforeLoss?.revision ?? 0) + 1)
      await expect(composer).toContainText('Keep this unsent draft')
      expect(
        JSON.parse(await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8'))
      ).toEqual(before)
      if (!borrowed) {
        // Cancel the single disconnected decision after quit loses its pipe, then recover.
        await app.evaluate(({ app, BrowserWindow, dialog }) => {
          const quitRecovery = { confirmations: 0, errors: [] as string[] }
          ;(globalThis as typeof globalThis & { quitRecovery: typeof quitRecovery }).quitRecovery =
            quitRecovery
          dialog.showErrorBox = (_title, message) => {
            quitRecovery.errors.push(message)
          }
          dialog.showMessageBox = async (...args: unknown[]) => {
            const disconnected = args.some(
              (arg) =>
                typeof arg === 'object' &&
                arg !== null &&
                'message' in arg &&
                arg.message === 'Quit while disconnected?'
            )
            if (disconnected) quitRecovery.confirmations += 1
            return { response: disconnected ? 0 : 1, checkboxChecked: false }
          }
          const contents = BrowserWindow.getAllWindows()[0].webContents
          const send = contents.send.bind(contents)
          contents.send = (channel, ...args): void => {
            send(channel, ...args)
            if (channel !== 'desktop-runtime:state-changed' || !args[0]?.closing) return
            contents.send = send
            const handles = (
              process as NodeJS.Process & {
                _getActiveHandles(): {
                  readable?: boolean
                  writable?: boolean
                  _handle?: { constructor: { name: string } }
                  destroy(): void
                }[]
              }
            )._getActiveHandles()
            const pipe = handles.find(
              (handle) =>
                handle.readable && handle.writable && handle._handle?.constructor.name === 'Pipe'
            )
            if (!pipe) throw new Error('Quit preparation pipe missing')
            pipe.destroy()
          }
          app.quit()
        })
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'disconnected', closing: false })
        expect(
          await app.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  quitRecovery: { confirmations: number; errors: string[] }
                }
              ).quitRecovery
          )
        ).toEqual({ confirmations: 1, errors: [] })
        await expect(page.getByRole('button', { name: 'Stay', exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'connected', closing: false })
        expect(
          JSON.parse(await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8'))
        ).toEqual(before)
      }
      if (!borrowed) {
        await app.evaluate(({ app }) => {
          type Pipe = {
            readable?: boolean
            writable?: boolean
            _handle?: { constructor: { name: string } }
            write: (...args: unknown[]) => boolean
            destroy(): void
          }
          const pipe = (process as NodeJS.Process & { _getActiveHandles(): Pipe[] })
            ._getActiveHandles()
            .find(
              (handle) =>
                handle.readable && handle.writable && handle._handle?.constructor.name === 'Pipe'
            )!
          if (!pipe) throw new Error('Final shutdown pipe missing')
          const original = pipe.write
          let buffered = Buffer.alloc(0)
          ;(globalThis as typeof globalThis & { shutdownDropped: boolean }).shutdownDropped = false
          pipe.write = function (...args): boolean {
            if (Buffer.isBuffer(args[0])) buffered = Buffer.concat([buffered, args[0]])
            // Parse only outgoing RFC6455 frames to drop the actual shutdown command. All earlier
            // inspect/hold/prepare/flush traffic follows the real connection unchanged.
            while (buffered.length >= 2) {
              const masked = Boolean(buffered[1] & 128)
              let bytes = buffered[1] & 127
              let offset = 2
              if (bytes === 126) {
                if (buffered.length < 4) break
                bytes = buffered.readUInt16BE(2)
                offset = 4
              } else if (bytes === 127) {
                if (buffered.length < 10) break
                bytes = Number(buffered.readBigUInt64BE(2))
                offset = 10
              }
              const header = offset + (masked ? 4 : 0)
              if (buffered.length < header + bytes) break
              const body = Buffer.from(buffered.subarray(header, header + bytes))
              if (masked)
                for (let i = 0; i < body.length; i++) body[i] ^= buffered[offset + (i % 4)]
              buffered = buffered.subarray(header + bytes)
              if (body.toString().includes('"kind":"shutdown"')) {
                pipe.write = original
                ;(globalThis as typeof globalThis & { shutdownDropped: boolean }).shutdownDropped =
                  true
                pipe.destroy()
                return false
              }
            }
            return original.apply(this, args)
          }
          app.quit()
        })
        await expect
          .poll(() =>
            app!.evaluate(
              () => (globalThis as typeof globalThis & { shutdownDropped: boolean }).shutdownDropped
            )
          )
          .toBe(true)
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'disconnected', closing: false })
        expect(
          await app.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  quitRecovery: { confirmations: number; errors: string[] }
                }
              ).quitRecovery
          )
        ).toEqual({ confirmations: 2, errors: [] })
        await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'connected' })
      }
      const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
      const health = await fetch(`http://127.0.0.1:${before.port}/owner`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-open-science-runtime-generation': before.generation
        },
        signal: AbortSignal.timeout(5000)
      })
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ pid: before.pid, generation: before.generation })
      expect(processHasExited(before.pid)).toBe(false)
      await app.close()
      app = undefined
      if (server) {
        expect(server.exitCode).toBeNull()
        expect(
          JSON.parse(await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8'))
        ).toEqual(before)
        await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
          env,
          timeout: 30_000
        })
        await serverExit
        expect(server.exitCode).toBe(0)
      } else {
        await expect.poll(() => processHasExited(before.pid), { timeout: 30_000 }).toBe(true)
      }
    } finally {
      await cleanupRecoveryFixture({
        app,
        server,
        owner,
        env,
        root,
        storageRoot: roots.storageRoot
      })
    }
  })

// eslint-disable-next-line no-empty-pattern
test('exits from the recovery notice when the original backend has really stopped', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-unavailable-recovery-with spaces-'))
  const roots = {
    storageRoot: join(root, 'storage'),
    userDataRoot: join(root, 'profile'),
    fakeAgentBinRoot: join(root, 'bin'),
    fakeRemoteItRoot: join(root, 'remote'),
    fakeRemoteItState: join(root, 'remote.json')
  }
  await mkdir(roots.storageRoot)
  const env = {
    ...launchEnvironment(roots.storageRoot),
    OPEN_SCIENCE_USER_DATA: roots.userDataRoot
  }
  let app: ElectronApplication | undefined
  let owner: RuntimeOwner | undefined
  try {
    app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = (_title, message) => {
        process
          .getBuiltinModule('node:fs')
          .writeFileSync(
            process.env.OPEN_SCIENCE_CONFIG_ROOT + '/unexpected-error-box.txt',
            message
          )
      }
    })
    const page = await app.firstWindow()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await expect
      .poll(() => page.evaluate(() => window.api?.desktopRuntime?.getState()), { timeout: 60_000 })
      .toMatchObject({ phase: 'connected' })
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60_000 })
      .toMatchObject({ phase: 'ready' })
    owner = JSON.parse(
      await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
    ) as RuntimeOwner
    await page.evaluate(() => window.api.settings.markOnboardingComplete())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(homeNewProjectButton(page)).toBeVisible()
    try {
      await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
        env,
        timeout: 30_000
      })
    } catch (error) {
      const processes = await promisify(execFile)('ps', [
        '-o',
        'pid=,ppid=,stat=,etime=,command=',
        '-p',
        `${owner!.pid},${app.process().pid}`
      ]).catch(() => ({ stdout: 'Unavailable' }))
      let directoryLock: string
      try {
        acquireRuntimeDirectorySync(roots.storageRoot).release()
        directoryLock = 'available'
      } catch (lockError) {
        directoryLock = String(lockError)
      }
      const evidence = {
        at: new Date().toISOString(),
        processes: processes.stdout,
        directoryLock,
        exitRecord: await readFile(join(roots.storageRoot, 'runtime-exit.json'), 'utf8').catch(
          () => 'missing'
        ),
        owner: await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8').catch(
          () => 'missing'
        )
      }
      console.log('CLI stop failure evidence', JSON.stringify(evidence))
      await testInfo.attach('cli-stop-failure', {
        body: JSON.stringify(evidence),
        contentType: 'application/json'
      })
      throw error
    }
    expect(
      await readFile(join(roots.storageRoot, 'unexpected-error-box.txt'), 'utf8').catch(() => '')
    ).toBe('')
    await expect
      .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
      .toMatchObject({ phase: 'unavailable' })
    await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    const desktopProcess = app.process()
    await page.getByRole('button', { name: 'Quit', exact: true }).click()
    await expect.poll(() => desktopProcess.exitCode, { timeout: 10_000 }).toBe(0)
    app = undefined
  } finally {
    for (const [name, path] of [
      ['runtime-log', join(roots.storageRoot, 'logs', 'main.log')],
      ['desktop-log', join(roots.userDataRoot, 'desktop-logs', 'main.log')],
      ['error-box', join(roots.storageRoot, 'unexpected-error-box.txt')]
    ])
      await testInfo.attach(name, {
        body: await readFile(path).catch(() => Buffer.from('Unavailable')),
        contentType: 'text/plain'
      })
    await cleanupRecoveryFixture({ app, owner, env, root, storageRoot: roots.storageRoot })
  }
})

for (const scenario of [
  'native quit',
  'native quit without window',
  'repeated notice quit',
  'quit after failed reconnects',
  'connection loss during quit',
  'connection loss after quit preflight',
  'system shutdown',
  'system shutdown during confirmation'
] as const)
  test(`disconnected desktop handles ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-disconnected-quit-with spaces-'))
    const roots = {
      storageRoot: join(root, 'storage'),
      userDataRoot: join(root, 'profile'),
      fakeAgentBinRoot: join(root, 'bin'),
      fakeRemoteItRoot: join(root, 'remote'),
      fakeRemoteItState: join(root, 'remote.json')
    }
    await mkdir(roots.storageRoot)
    const env = {
      ...launchEnvironment(roots.storageRoot),
      OPEN_SCIENCE_USER_DATA: roots.userDataRoot
    }
    let app: ElectronApplication | undefined
    let owner: RuntimeOwner | undefined
    try {
      app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
      const page = await app.firstWindow()
      await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
      await expect
        .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), {
          timeout: 60_000
        })
        .toMatchObject({ phase: 'ready' })
      owner = JSON.parse(
        await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
      ) as RuntimeOwner
      await app.evaluate(
        ({ dialog, BrowserWindow, ipcMain }, quitDisconnect) => {
          type QuitProbe = {
            dialogs: string[]
            errors: string[]
            respond?: (response?: number) => void
          }
          const probe: QuitProbe = { dialogs: [], errors: [] }
          ;(globalThis as typeof globalThis & { quitProbe: QuitProbe }).quitProbe = probe
          dialog.showErrorBox = (_title, content) => {
            probe.errors.push(content)
          }
          dialog.showMessageBox = (options) => {
            if (!('message' in options)) throw new Error('Expected an unparented quit confirmation')
            probe.dialogs.push(options.message)
            return new Promise((resolve) => {
              probe.respond = (response = 0) => resolve({ response, checkboxChecked: false })
            })
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
            )
          if (!pipe) throw new Error('Desktop pipe missing')
          if (quitDisconnect === 'failed-reconnects') {
            const net = process.getBuiltinModule('node:net')
            const connect = net.Socket.prototype.connect
            net.Socket.prototype.connect = function (
              this: import('node:net').Socket,
              ...args: unknown[]
            ) {
              const result = Reflect.apply(connect, this, args)
              if (/os-desktop-|open-science-/.test(JSON.stringify(args)))
                this.once('connect', () => this.destroy())
              return result
            }
            pipe.destroy()
          } else if (quitDisconnect === 'after-preflight') {
            ipcMain.prependOnceListener('sessions:flush-response', () => pipe.destroy())
          } else if (quitDisconnect === 'during-preflight') {
            const contents = BrowserWindow.getAllWindows()[0].webContents
            const send = contents.send.bind(contents)
            contents.send = (channel, ...args) => {
              if (channel === 'sessions:flush-request') {
                contents.send = send
                pipe.destroy()
              }
              send(channel, ...args)
            }
          } else {
            pipe.destroy()
          }
        },
        scenario === 'connection loss during quit'
          ? 'during-preflight'
          : scenario === 'connection loss after quit preflight'
            ? 'after-preflight'
            : scenario === 'quit after failed reconnects'
              ? 'failed-reconnects'
              : undefined
      )
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
        .toMatchObject({
          phase:
            scenario === 'connection loss during quit' ||
            scenario === 'connection loss after quit preflight'
              ? 'connected'
              : 'disconnected'
        })
      if (scenario === 'quit after failed reconnects') {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const before = await page.evaluate(() => window.api.desktopRuntime!.getState())
          await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
          await expect
            .poll(() => page.evaluate(() => window.api.desktopRuntime!.getState()))
            .toMatchObject({ phase: 'disconnected', epoch: before.epoch + 1 })
        }
      }
      const requestSystemShutdown = async (): Promise<void> => {
        const desktopProcess = app!.process()
        if (process.platform === 'win32') {
          // Windows kill bypasses Node signal listeners; exercise the installed adapter directly.
          await app!.evaluate(() => {
            setImmediate(() => process.emit('SIGTERM'))
          })
        } else {
          desktopProcess.kill('SIGTERM')
        }
        await expect.poll(() => desktopProcess.exitCode, { timeout: 10_000 }).toBe(0)
        app = undefined
        expect(processHasExited(owner!.pid)).toBe(false)
      }
      if (scenario === 'system shutdown') {
        await requestSystemShutdown()
        return
      }
      if (scenario === 'quit after failed reconnects') {
        await page.getByRole('button', { name: 'Quit', exact: true }).click()
      } else if (scenario === 'repeated notice quit') {
        await page.evaluate(() => {
          void window.api.desktopRuntime!.quit()
          void window.api.desktopRuntime!.quit()
        })
      } else {
        await app.evaluate(({ app, BrowserWindow }, noWindow) => {
          if (noWindow) for (const window of BrowserWindow.getAllWindows()) window.destroy()
          app.quit()
        }, scenario === 'native quit without window')
      }
      await expect
        .poll(() =>
          app!.evaluate(() => {
            const probe = (
              globalThis as typeof globalThis & {
                quitProbe: { dialogs: string[]; errors: string[] }
              }
            ).quitProbe
            return { dialogs: probe.dialogs, errors: probe.errors }
          })
        )
        .toEqual({ dialogs: ['Quit while disconnected?'], errors: [] })
      if (scenario === 'quit after failed reconnects') {
        const desktopProcess = app.process()
        await app.evaluate(() => {
          ;(
            globalThis as typeof globalThis & { quitProbe: { respond(response: number): void } }
          ).quitProbe.respond(1)
        })
        await expect.poll(() => desktopProcess.exitCode, { timeout: 10_000 }).toBe(0)
        app = undefined
        expect(processHasExited(owner.pid)).toBe(false)
        return
      }
      if (scenario === 'system shutdown during confirmation') {
        await requestSystemShutdown()
        return
      }
      await app.evaluate(() => {
        ;(globalThis as typeof globalThis & { quitProbe: { respond(): void } }).quitProbe.respond()
      })
      expect(app.process().exitCode).toBeNull()
      expect(processHasExited(owner.pid)).toBe(false)
      if (scenario !== 'native quit without window')
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'disconnected', closing: false })
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      })
      const desktopProcess = app.process()
      if (scenario === 'repeated notice quit')
        await page.evaluate(() => {
          void window.api.desktopRuntime!.quit()
        })
      else
        await app.evaluate(({ app }) => {
          app.quit()
        })
      await expect.poll(() => desktopProcess.exitCode, { timeout: 10_000 }).toBe(0)
      app = undefined
      expect(processHasExited(owner.pid)).toBe(false)
    } finally {
      await cleanupRecoveryFixture({ app, owner, env, root, storageRoot: roots.storageRoot })
    }
  })
