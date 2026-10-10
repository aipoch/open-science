import { test, expect } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { launchEnvironment, launchOpenScience } from './fixtures/electron-app'

for (const borrowed of [false, true]) {
  test(`desktop ${borrowed ? 'detaches from a CLI-owned' : 'stops its own'} ordinary Node runtime`, async () => {
    test.skip(
      Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
      'Source entry ownership certification'
    )
    const root = await mkdtemp(join(tmpdir(), 'open-science-desktop-lifetime-'))
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
      ...(process.platform === 'darwin'
        ? {
            NODE_OPTIONS: `--require=${JSON.stringify(resolve('e2e/fixtures/mock-node-credentials.cjs'))}`
          }
        : {})
    }
    const nodeArgs = [
      resolve('out/backend/index.cjs'),
      '--development',
      '--serve',
      ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [])
    ]
    const server = borrowed
      ? spawn(process.execPath, nodeArgs, { env, stdio: 'ignore' })
      : undefined
    const serverExit = server
      ? new Promise<void>((settle) => server.once('exit', () => settle()))
      : undefined
    let app: ElectronApplication | undefined
    const owner = async (): Promise<{ pid: number; port: number; generation: string }> =>
      JSON.parse(await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8'))
    const alive = async (): Promise<boolean> => {
      try {
        const state = await owner()
        const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
        const response = await fetch(`http://127.0.0.1:${state.port}/owner`, {
          headers: {
            authorization: `Bearer ${token}`,
            'x-open-science-runtime-generation': state.generation
          },
          signal: AbortSignal.timeout(1000)
        })
        return response.ok && (await response.json()).pid === state.pid
      } catch {
        return false
      }
    }
    try {
      if (borrowed) {
        await expect.poll(alive, { timeout: 60000 }).toBe(true)
        // The owner endpoint precedes database migration. Match CLI start's readiness boundary
        // before opening Chromium: this scenario certifies attachment to an already started server.
        await expect
          .poll(
            async () => {
              try {
                const state = JSON.parse(
                  await readFile(join(roots.storageRoot, 'web-service.json'), 'utf8')
                ) as { port: number }
                const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
                const response = await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, {
                  headers: { authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(1000)
                })
                return response.ok
              } catch {
                return false
              }
            },
            { timeout: 60000 }
          )
          .toBe(true)
      }
      app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
      const page = await app.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
      await expect
        .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60000 })
        .toMatchObject({ phase: 'ready' })
      const before = await owner()
      const desktopPid = app.process().pid
      expect(before.pid).not.toBe(desktopPid)
      if (borrowed) expect(before.pid).toBe(server!.pid)
      await app.close()
      app = undefined
      await expect.poll(alive).toBe(borrowed)
      if (borrowed) {
        expect(await owner()).toEqual(before)
        expect(server!.exitCode).toBeNull()
        await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
          env,
          timeout: 30000
        })
        await serverExit
        expect(server!.exitCode).toBe(0)
      }
    } finally {
      await app?.close()
      // Cleanup targets only this test's unique profile, then its actual spawned handle if startup failed.
      if (await alive())
        await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
          env,
          timeout: 30000
        })
      if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
      await serverExit
      await rm(root, { recursive: true, force: true })
    }
  })
}
