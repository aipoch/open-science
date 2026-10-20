import { homeNewProjectButton } from './fixtures/project'
import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { test, expect } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { electronLaunchTarget, launchEnvironment, launchOpenScience } from './fixtures/electron-app'

test('scopes single-instance ownership to environment-selected profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-profile-lock-'))
  const applications: ElectronApplication[] = []
  let duplicate: ReturnType<typeof spawn> | undefined
  try {
    for (const name of ['a', 'b']) {
      const storageRoot = join(root, `storage-${name}`)
      const profileRoot = join(root, `profile-${name}`)
      await mkdir(storageRoot)
      const target = electronLaunchTarget(profileRoot)
      target.args = target.args.filter((arg) => !arg.startsWith('--user-data-dir='))
      const env: Record<string, string> = {
        ...launchEnvironment(storageRoot),
        OPEN_SCIENCE_USER_DATA: profileRoot,
        ...(process.platform === 'darwin' && !process.env.OPEN_SCIENCE_E2E_EXECUTABLE
          ? {
              NODE_OPTIONS: `--require=${JSON.stringify(resolve('e2e/fixtures/mock-node-credentials.cjs'))}`
            }
          : {})
      }
      delete env.OPEN_SCIENCE_ALLOW_MULTI_INSTANCE
      const args = [...target.args, '--open-science-headless', '--serve=0']
      const application = await electron.launch({ ...target, args, env })
      applications.push(application)
      await expect
        .poll(
          () => readFile(join(profileRoot, 'desktop-logs', 'main.log'), 'utf8').catch(() => ''),
          {
            timeout: 60000
          }
        )
        .toContain('Open-Science Web:')
      expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profileRoot)
      if (name === 'a') {
        duplicate = spawn(application.process().spawnfile, args, { env, stdio: 'ignore' })
        await expect.poll(() => duplicate!.exitCode, { timeout: 20000 }).toBe(0)
        expect(application.process().exitCode).toBeNull()
      }
    }
    expect(applications.every((application) => application.process().exitCode === null)).toBe(true)
  } finally {
    if (duplicate && duplicate.exitCode === null) duplicate.kill()
    for (const application of applications.reverse()) await application.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('headless desktop creates no renderer and exits after Web shutdown', async () => {
  test.skip(Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE), 'Source entry certification')
  const root = await mkdtemp(join(tmpdir(), 'open-science-headless-lifetime-with spaces-'))
  const storageRoot = join(root, 'storage')
  const profileRoot = join(root, 'profile')
  await mkdir(storageRoot)
  const target = electronLaunchTarget(profileRoot)
  const env = {
    ...launchEnvironment(storageRoot),
    OPEN_SCIENCE_USER_DATA: profileRoot,
    ...(process.platform === 'darwin' && !process.env.OPEN_SCIENCE_E2E_EXECUTABLE
      ? {
          NODE_OPTIONS: `--require=${JSON.stringify(resolve('e2e/fixtures/mock-node-credentials.cjs'))}`
        }
      : {})
  }
  let application: ElectronApplication | undefined
  try {
    application = await electron.launch({
      ...target,
      args: [...target.args, '--open-science-headless', '--serve=0'],
      env
    })
    const child = application.process()
    const logPath = join(profileRoot, 'desktop-logs', 'main.log')
    // Main publishes readiness only after it installs the window/quit lifecycle.
    await expect
      .poll(() => readFile(logPath, 'utf8').catch(() => ''), { timeout: 60000 })
      .toContain('Open-Science Web:')
    expect(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(0)
    const { port } = JSON.parse(await readFile(join(storageRoot, 'web-service.json'), 'utf8'))
    const token = (await readFile(join(storageRoot, 'web-token'), 'utf8')).trim()
    const headers = { authorization: `Bearer ${token}` }
    const health = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
      headers,
      signal: AbortSignal.timeout(5000)
    })
    expect(health.ok).toBe(true)
    await health.text()
    const response = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5000)
    })
    await response.text()
    expect(response.status).toBe(202)
    await expect.poll(() => child.exitCode, { timeout: 30000 }).toBe(0)
    expect(child.signalCode).toBeNull()
    application = undefined
  } finally {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const borrowed of [false, true]) {
  test(`desktop ${borrowed ? 'detaches from a CLI-owned' : 'stops its own'} ordinary Node runtime`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-desktop-lifetime-with spaces-'))
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
    const nodeArgs = [
      resolve('out/backend/index.cjs'),
      '--development',
      '--serve=0',
      ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [])
    ]
    const server = borrowed
      ? spawn(process.execPath, nodeArgs, { env, stdio: 'ignore' })
      : undefined
    const serverExit = server
      ? new Promise<void>((settle) => server.once('exit', () => settle()))
      : undefined
    let app: ElectronApplication | undefined
    const owner = async (): Promise<{
      pid: number
      port: number
      generation: string
      desktop: { generation: string }
    }> => JSON.parse(await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8'))
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
      await app.evaluate(({ dialog }) => {
        dialog.showErrorBox = (_title, message) => {
          process
            .getBuiltinModule('node:fs')
            .writeFileSync(process.env.OPEN_SCIENCE_CONFIG_ROOT + '/quit-error.txt', message)
        }
      })
      const page = await app.firstWindow()
      // Keep the lifecycle assertions independent of the Windows account language. The direct
      // launch path does not pass through ElectronAppHarness.create(), which normally pins English.
      await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
      await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
      await expect
        .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60000 })
        .toMatchObject({ phase: 'ready' })
      // Database readiness precedes React's persistence subscription. Quit only after the
      // application surface is mounted, so this checks runtime ownership rather than startup.
      await page.evaluate(() => window.api.settings.markOnboardingComplete())
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(homeNewProjectButton(page)).toBeVisible()
      const before = await owner()
      const desktopPid = app.process().pid
      expect(before.pid).not.toBe(desktopPid)
      if (borrowed) expect(before.pid).toBe(server!.pid)
      const closing = app.process()
      const closingApplication = app
      void closingApplication.close().catch(() => undefined)
      await expect
        .poll(
          async () => ({
            exitCode: closing.exitCode,
            error: await readFile(join(roots.storageRoot, 'quit-error.txt'), 'utf8').catch(() => '')
          }),
          { timeout: 25000 }
        )
        .toEqual({ exitCode: 0, error: '' })
      app = undefined
      await expect.poll(alive).toBe(borrowed)
      if (!borrowed) {
        await expect
          .poll(
            () => {
              try {
                process.kill(before.pid, 0)
                return false
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
                throw error
              }
            },
            { timeout: 30000 }
          )
          .toBe(true)
        expect(
          JSON.parse(await readFile(join(roots.storageRoot, 'runtime-exit.json'), 'utf8'))
        ).toMatchObject({
          pid: before.pid,
          generation: before.desktop.generation,
          outcome: 'clean'
        })
        acquireRuntimeDirectorySync(roots.storageRoot).release()
      }
      if (borrowed) {
        expect(await owner()).toEqual(before)
        expect(server!.exitCode).toBeNull()
        const service = JSON.parse(
          await readFile(join(roots.storageRoot, 'web-service.json'), 'utf8')
        )
        const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
        const response = await fetch(`http://127.0.0.1:${service.port}/api/bootstrap`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000)
        })
        expect(response.ok).toBe(true)
        await response.text()
        await promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
          env,
          timeout: 30000
        })
        await serverExit
        expect(server!.exitCode).toBe(0)
      }
    } finally {
      const desktop = app?.process()
      await app?.evaluate(({ app }) => app.exit(0)).catch(() => desktop?.kill('SIGKILL'))
      if (desktop)
        await expect.poll(() => desktop.exitCode !== null || desktop.signalCode !== null).toBe(true)
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
