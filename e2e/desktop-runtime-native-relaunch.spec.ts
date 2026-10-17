import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { chromium, type Browser, type ElectronApplication } from 'playwright'
import {
  electronLaunchTarget,
  launchEnvironment,
  launchOpenScience,
  removeTreeForCleanup
} from './fixtures/electron-app'

for (const stalled of [false, true]) {
  // eslint-disable-next-line no-empty-pattern
  test(`Runtime-requested relaunch ${stalled ? 'times out before the transport closes' : 'replies before clean shutdown and Desktop relaunch'}`, async ({}, testInfo) => {
    test.skip(
      !['darwin', 'win32', 'linux'].includes(process.platform) ||
        Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
      'Isolated source credential fixture'
    )
    // Windows acceptance exercises spaced paths; macOS rejects them for environment data.
    const root = await mkdtemp(
      join(
        tmpdir(),
        process.platform === 'win32'
          ? 'runtime-native-relaunch-with spaces-'
          : 'runtime-native-relaunch-'
      )
    )
    const roots = {
      storageRoot: join(root, 'config'),
      userDataRoot: join(root, 'profile'),
      fakeAgentBinRoot: join(root, 'bin'),
      fakeRemoteItRoot: join(root, 'remote'),
      fakeRemoteItState: join(root, 'remote.json')
    }
    await mkdir(roots.storageRoot)
    await mkdir(join(root, 'new-data'))
    const preload = [
      ...(process.platform === 'darwin' ? [resolve('e2e/fixtures/mock-node-credentials.cjs')] : []),
      ...(stalled ? [resolve('e2e/fixtures/runtime-relaunch-stall.cjs')] : [])
    ]
    const server = spawn(
      process.execPath,
      [resolve('out/backend/index.cjs'), '--development', '--desktop', '--serve=0'],
      {
        env: {
          ...launchEnvironment(roots.storageRoot),
          OPEN_SCIENCE_USER_DATA: roots.userDataRoot,
          NODE_OPTIONS: preload.map((path) => `--require=${JSON.stringify(path)}`).join(' ')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    server.stdout.on('data', (data) => {
      output += String(data)
    })
    server.stderr.on('data', (data) => {
      output += String(data)
    })
    let app: ElectronApplication | undefined
    try {
      await expect
        .poll(
          async () => {
            if (server.exitCode !== null) throw new Error(`Runtime exited: ${output}`)
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
          { timeout: 60000 }
        )
        .toBe(true)
      app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
      const page = await app.firstWindow()
      await expect
        .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), { timeout: 60000 })
        .toMatchObject({ phase: 'ready' })
      await page.evaluate(() => window.api.settings.markOnboardingComplete())
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean(window.api?.storage))
      await page.evaluate(() => window.api.settings.getSettings())
      // Keep the OS from spawning an untracked successor. The production native request,
      // response and stop-confirmation path remain real; only final Electron relaunch is observed.
      await app.evaluate(
        ({ app, dialog }, marker) => {
          app.relaunch = () => {
            process.getBuiltinModule('node:fs').writeFileSync(marker, 'relaunch')
          }
          dialog.showErrorBox = (_title, message) => {
            process.getBuiltinModule('node:fs').writeFileSync(`${marker}.error`, message)
          }
        },
        join(root, 'desktop-relaunch')
      )
      const desktop = app.process()
      const owner = JSON.parse(
        await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
      )
      const started = Date.now()
      await page
        .evaluate(
          async (target) => {
            const result = await window.api.storage.setDataRootAndRelaunch(target, true)
            if (!result.ok) throw new Error(JSON.stringify(result))
          },
          join(root, 'new-data')
        )
        .catch((error) => {
          if (!String(error).includes('closed') && !String(error).includes('destroyed')) throw error
        })
      if (stalled) {
        await expect
          .poll(
            () =>
              readFile(join(roots.storageRoot, 'relaunch-control-close-stalled'), 'utf8').catch(
                () => ''
              ),
            { timeout: 10000 }
          )
          .toBe('stalled')
        await expect
          .poll(() => readFile(join(root, 'desktop-relaunch.error'), 'utf8').catch(() => ''), {
            timeout: 22000
          })
          .toContain('15 seconds')
        expect(Date.now() - started).toBeLessThan(26000)
        expect(desktop.exitCode).toBeNull()
        expect(server.exitCode).toBeNull()
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'disconnected' })
      } else {
        await expect.poll(() => desktop.exitCode, { timeout: 25000 }).toBe(0)
        await expect.poll(() => server.exitCode).toBe(0)
        expect(await readFile(join(root, 'desktop-relaunch'), 'utf8')).toBe('relaunch')
        expect(
          JSON.parse(await readFile(join(roots.storageRoot, 'runtime-exit.json'), 'utf8'))
        ).toMatchObject({ generation: owner.desktop.generation, pid: server.pid, outcome: 'clean' })
        app = undefined
      }
    } finally {
      for (const [name, path] of [
        ['runtime-log', join(roots.storageRoot, 'logs', 'main.log')],
        ['desktop-log', join(roots.userDataRoot, 'desktop-logs', 'main.log')]
      ]) {
        await testInfo.attach(name, {
          body: await readFile(path).catch(() => Buffer.from('Unavailable')),
          contentType: 'text/plain'
        })
      }
      const desktop = app?.process()
      await app?.evaluate(({ app }) => app.exit(0)).catch(() => desktop?.kill('SIGKILL'))
      if (desktop)
        await expect.poll(() => desktop.exitCode !== null || desktop.signalCode !== null).toBe(true)
      if (server.exitCode === null && server.signalCode === null)
        server.kill(stalled ? 'SIGKILL' : 'SIGTERM')
      await expect.poll(() => server.exitCode !== null || server.signalCode !== null).toBe(true)
      await removeTreeForCleanup(root)
    }
  })
}

// eslint-disable-next-line no-empty-pattern
test('actual Electron relaunch starts a new Desktop and Runtime and reads the original Session', async ({}, testInfo) => {
  test.skip(
    !['darwin', 'win32', 'linux'].includes(process.platform) ||
      Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
    'Isolated source relaunch'
  )
  const root = await mkdtemp(
    join(
      tmpdir(),
      process.platform === 'win32'
        ? 'actual-desktop-relaunch-with spaces-'
        : 'actual-desktop-relaunch-'
    )
  )
  const configRoot = join(root, 'config'),
    profileRoot = join(root, 'profile')
  await mkdir(configRoot)
  await mkdir(join(root, 'new-data'))
  await mkdir(join(root, 'workspace'))
  const capability = randomUUID()
  const target = electronLaunchTarget(profileRoot)
  // Match Playwright's source Electron launch in Linux containers without a setuid sandbox.
  const initialArgs = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...target.args]
  initialArgs.splice(
    initialArgs.length - 1,
    0,
    '--require',
    resolve('e2e/fixtures/relaunch-observer.cjs')
  )
  let desktop: ChildProcess | undefined
  let browser: Browser | undefined
  let successorPid: number | undefined
  let launchStderr = ''
  let launchIdentity: unknown
  let completed = false
  const exited = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }
  try {
    // Playwright's Electron loader waits for its original inspector connection in a successor.
    // Launch directly and use renderer CDP so native relaunch preserves a standalone argv.
    const executablePath = createRequire(resolve('package.json'))('electron') as string
    desktop = spawn(executablePath, [...initialArgs, '--remote-debugging-port=0'], {
      env: {
        // Native relaunch must exercise the same visible-window startup used for product
        // acceptance; a hidden fixture window can be throttled before renderer registration.
        ...launchEnvironment(configRoot, undefined, process.env, undefined, 'normal'),
        OPEN_SCIENCE_USER_DATA: profileRoot,
        OPEN_SCIENCE_E2E_RELAUNCH_CAPABILITY: capability
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    desktop.stderr?.on('data', (data) => {
      launchStderr += String(data)
    })
    launchIdentity = { pid: desktop.pid, execPath: executablePath, argv: initialArgs }
    await expect
      .poll(() => readFile(join(profileRoot, 'DevToolsActivePort'), 'utf8').catch(() => ''), {
        timeout: 60000
      })
      .not.toBe('')
    const initialPort = (await readFile(join(profileRoot, 'DevToolsActivePort'), 'utf8')).split(
      '\n'
    )[0]
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${initialPort}`)
    await expect
      .poll(() => browser!.contexts().flatMap((context) => context.pages()).length)
      .toBeGreaterThan(0)
    let page = browser.contexts().flatMap((context) => context.pages())[0]
    await expect
      .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), { timeout: 60000 })
      .toMatchObject({ phase: 'ready' })
    await page.evaluate(() => window.api.settings.markOnboardingComplete())
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.evaluate(() => window.api.settings.getSettings())
    const identity = await page.evaluate(
      async (cwd) => {
        const project = await window.api.projects.create({ name: 'Relaunch fixture' })
        await window.api.sessions.saveSession({
          id: 'relaunch-session',
          projectId: project.id,
          cwd,
          title: 'Relaunch fixture',
          status: 'idle',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            {
              id: 'relaunch-message',
              role: 'user',
              content: 'Original saved relaunch evidence',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
        return { projectId: project.id, sessionId: 'relaunch-session' }
      },
      join(root, 'workspace')
    )
    const firstDesktop = desktop
    // Refuse to request a native successor unless the cleanup observer is already active.
    expect(await readFile(join(configRoot, 'fixture-desktop-pids'), 'utf8')).toBe(
      `${firstDesktop.pid}\n`
    )
    const firstOwner = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
    await page
      .evaluate(
        async (target) => {
          const result = await window.api.storage.setDataRootAndRelaunch(target, true)
          if (!result.ok) throw new Error(JSON.stringify(result))
        },
        join(root, 'new-data')
      )
      .catch((error) => {
        if (!/closed|destroyed/.test(String(error))) throw error
      })
    await expect.poll(() => firstDesktop.exitCode, { timeout: 25000 }).toBe(0)
    desktop = undefined
    await expect
      .poll(
        async () => {
          const ids = (await readFile(join(configRoot, 'fixture-desktop-pids'), 'utf8'))
            .trim()
            .split('\n')
            .map(Number)
          successorPid = ids.find((pid) => pid !== firstDesktop.pid)
          return Boolean(successorPid)
        },
        { timeout: 30000 }
      )
      .toBe(true)
    await expect
      .poll(
        async () => {
          try {
            const owner = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
            return owner.pid !== firstOwner.pid
          } catch {
            return false
          }
        },
        { timeout: 60000 }
      )
      .toBe(true)
    const port = (await readFile(join(profileRoot, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    await expect
      .poll(() => browser!.contexts().flatMap((context) => context.pages()).length)
      .toBeGreaterThan(0)
    page = browser.contexts().flatMap((context) => context.pages())[0]
    await expect
      .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), { timeout: 60000 })
      .toMatchObject({ phase: 'ready' })
    expect(
      await page.evaluate((identity) => window.api.sessions.loadOne(identity), identity)
    ).toMatchObject({
      id: 'relaunch-session',
      messages: [{ content: 'Original saved relaunch evidence' }]
    })
    await expect(
      page.locator('header').getByRole('button', { name: 'New project', exact: true })
    ).toBeVisible()
    await testInfo.attach('successor-desktop', {
      body: await page.screenshot({ path: join(root, 'successor-desktop.png') }),
      contentType: 'image/png'
    })
    const nextOwner = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
    expect(nextOwner.pid).not.toBe(firstOwner.pid)
    expect(nextOwner.desktop.generation).not.toBe(firstOwner.desktop.generation)
    const desktopIdentities = (
      await readFile(join(configRoot, 'fixture-desktop-identities.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(desktopIdentities.map((entry) => entry.pid)).toEqual([firstDesktop.pid, successorPid])
    for (const entry of desktopIdentities) {
      expect(entry).toMatchObject({
        configRoot,
        isPackaged: false
      })
      // Electron can preserve macOS's /var alias; compare the actual directories on both sides.
      expect(await realpath(entry.userData)).toBe(await realpath(profileRoot))
      expect(await realpath(entry.sessionData)).toBe(await realpath(profileRoot))
      expect(entry.environmentUserData).toBe(profileRoot)
      expect(entry.argv).toContain(`--user-data-dir=${profileRoot}`)
      if (process.platform === 'darwin') expect(entry.argv).toContain('--use-mock-keychain')
    }
    await writeFile(
      join(configRoot, 'fixture-quit-pid'),
      JSON.stringify({ pid: successorPid, capability })
    )
    await expect.poll(() => exited(successorPid!), { timeout: 25000 }).toBe(true)
    await expect.poll(() => exited(nextOwner.pid), { timeout: 10000 }).toBe(true)
    expect(JSON.parse(await readFile(join(configRoot, 'runtime-exit.json'), 'utf8'))).toMatchObject(
      { pid: nextOwner.pid, generation: nextOwner.desktop.generation, outcome: 'clean' }
    )
    acquireRuntimeDirectorySync(configRoot).release()
    const identities = {
      firstDesktop: firstDesktop.pid,
      successorPid,
      firstRuntime: firstOwner.pid,
      nextRuntime: nextOwner.pid,
      firstGeneration: firstOwner.desktop.generation,
      nextGeneration: nextOwner.desktop.generation,
      desktopIdentities,
      session: identity
    }
    await writeFile(
      join(root, 'actual-relaunch-identities.json'),
      JSON.stringify(identities, null, 2)
    )
    await testInfo.attach('actual-relaunch-identities', {
      body: JSON.stringify(identities),
      contentType: 'application/json'
    })
    completed = true
  } finally {
    await testInfo.attach('actual-relaunch-launch', {
      body: JSON.stringify({ root, launchIdentity, launchStderr, successorPid }),
      contentType: 'application/json'
    })
    await testInfo.attach('actual-relaunch-desktop-log', {
      body: await readFile(join(profileRoot, 'desktop-logs', 'main.log')).catch(() =>
        Buffer.from('Unavailable')
      ),
      contentType: 'text/plain'
    })
    if (successorPid && !exited(successorPid)) {
      await writeFile(
        join(configRoot, 'fixture-quit-pid'),
        JSON.stringify({ pid: successorPid, capability })
      )
      await expect.poll(() => exited(successorPid!), { timeout: 25000 }).toBe(true)
    }
    await browser?.close().catch(() => undefined)
    if (desktop && desktop.exitCode === null && desktop.signalCode === null) {
      desktop.kill('SIGKILL')
      await new Promise<void>((resolve) => desktop!.once('exit', () => resolve()))
    }
    if (completed) await removeTreeForCleanup(root)
    else {
      await writeFile(
        join(root, 'native-relaunch-failed.json'),
        JSON.stringify({ launchIdentity, launchStderr }, null, 2)
      )
      await testInfo.attach('native-relaunch-failed-root', {
        body: JSON.stringify({ root, launchIdentity, launchStderr }, null, 2),
        contentType: 'application/json'
      })
    }
  }
})
