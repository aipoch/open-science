import {
  captureFixtureProcess,
  captureFixtureService,
  cleanupFixtureProcess,
  cleanupFixtureService,
  runFixtureCleanup,
  type CapturedFixtureProcess,
  type CapturedService
} from './fixtures/local-service-cleanup'
import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { chromium, type Browser, type ElectronApplication } from 'playwright'
import {
  closeElectronApplicationForCleanup,
  electronLaunchTarget,
  launchEnvironment,
  launchOpenScience,
  removeTreeForCleanup
} from './fixtures/electron-app'

for (const stalled of [false, true]) {
  // eslint-disable-next-line no-empty-pattern
  test(`Runtime-requested relaunch ${stalled ? 'continues after bounded degraded shutdown' : 'replies before clean shutdown and Desktop relaunch'}`, async ({}, testInfo) => {
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
    let server!: ReturnType<typeof spawn>
    let serverProcess: CapturedFixtureProcess | undefined
    let desktopProcess: CapturedFixtureProcess | undefined
    let app: ElectronApplication | undefined
    let service: CapturedService | undefined
    let failure: unknown
    try {
      server = spawn(
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
      server.on('error', () => undefined)
      serverProcess = captureFixtureProcess(server)
      let output = ''
      server.stdout!.on('data', (data) => {
        output += String(data)
      })
      server.stderr!.on('data', (data) => {
        output += String(data)
      })
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
      desktopProcess = captureFixtureProcess(app.process())
      if (!desktopProcess) throw new Error('Fixture desktop child was not captured')
      service = await captureFixtureService(roots.storageRoot)
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
      const desktop = desktopProcess.child
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
        await expect.poll(() => desktop.exitCode, { timeout: 27000 }).toBe(0)
        const desktopExitObservedAt = Date.now()
        await expect.poll(() => server.exitCode !== null || server.signalCode !== null).toBe(true)
        const serviceExitObservedAt = Date.now()
        expect(await readFile(join(root, 'desktop-relaunch'), 'utf8')).toBe('relaunch')
        expect(await readFile(join(root, 'desktop-relaunch.error'), 'utf8').catch(() => '')).toBe(
          ''
        )
        acquireRuntimeDirectorySync(roots.storageRoot).release()
        const lockReleasedAt = Date.now()
        expect(lockReleasedAt - started).toBeLessThan(28000)
        await testInfo.attach('stalled-native-relaunch-evidence', {
          body: JSON.stringify(
            {
              baseline: process.env.OPEN_SCIENCE_E2E_BASELINE ?? null,
              buildId: process.env.OPEN_SCIENCE_E2E_BUILD_ID ?? null,
              target: {
                pid: server.pid,
                birthToken: serverProcess?.birthToken,
                generation: owner.desktop.generation
              },
              desktop: {
                pid: desktop.pid,
                birthToken: desktopProcess.birthToken,
                exitCode: desktop.exitCode,
                signalCode: desktop.signalCode
              },
              service: { exitCode: server.exitCode, signalCode: server.signalCode },
              timing: {
                startedAt: started,
                desktopExitObservedAt,
                serviceExitObservedAt,
                lockReleasedAt,
                desktopExitMs: desktopExitObservedAt - started,
                serviceExitMs: serviceExitObservedAt - started,
                totalMs: lockReleasedAt - started
              },
              lockReleased: true,
              relaunchRequested: true,
              nativeError: false
            },
            null,
            2
          ),
          contentType: 'application/json'
        })
        app = undefined
      } else {
        await expect.poll(() => desktop.exitCode, { timeout: 25000 }).toBe(0)
        await expect.poll(() => server.exitCode).toBe(0)
        expect(await readFile(join(root, 'desktop-relaunch'), 'utf8')).toBe('relaunch')
        expect(
          JSON.parse(await readFile(join(roots.storageRoot, 'runtime-exit.json'), 'utf8'))
        ).toMatchObject({ generation: owner.desktop.generation, pid: server.pid, outcome: 'clean' })
        app = undefined
      }
    } catch (error) {
      failure = error
      throw error
    } finally {
      await runFixtureCleanup(
        [
          () => testInfo.attach('fixture-root', { body: root, contentType: 'text/plain' }),
          async () => {
            service ??= await captureFixtureService(roots.storageRoot)
          },
          async () => {
            for (const [name, path] of [
              ['runtime-log', join(roots.storageRoot, 'logs', 'main.log')],
              ['desktop-log', join(roots.userDataRoot, 'desktop-logs', 'main.log')]
            ]) {
              await testInfo.attach(name, {
                body: await readFile(path).catch(() => Buffer.from('Unavailable')),
                contentType: 'text/plain'
              })
            }
          },
          async () => {
            if (
              !app ||
              !desktopProcess ||
              desktopProcess.child.exitCode !== null ||
              desktopProcess.child.signalCode !== null
            )
              return
            await closeElectronApplicationForCleanup(
              {
                close: () => app!.close(),
                forceClose: () => cleanupFixtureProcess(desktopProcess)
              },
              { gracefulTimeoutMs: 5000, forcedTimeoutMs: 25_000 }
            )
          },
          () => cleanupFixtureService(service),
          () => cleanupFixtureProcess(desktopProcess),
          () => cleanupFixtureProcess(serverProcess)
        ],
        failure
      )
      if (failure === undefined && testInfo.status === testInfo.expectedStatus)
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
  let desktopProcess: CapturedFixtureProcess | undefined
  const capturedServices: CapturedService[] = []
  let failure: unknown
  let browser: Browser | undefined
  let successorPid: number | undefined
  let launchStderr = ''
  let launchIdentity: unknown
  let completed = false
  const requestQuit = async (pid: number): Promise<void> => {
    const path = join(configRoot, 'fixture-quit-pid')
    // The observer polls concurrently; publish complete JSON without a truncate/write window.
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ pid, capability }))
    await rename(temporary, path)
  }
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
    desktopProcess = captureFixtureProcess(desktop)
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
    const firstService = await captureFixtureService(configRoot)
    if (firstService) capturedServices.push(firstService)
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
    const nextService = await captureFixtureService(configRoot)
    if (nextService) capturedServices.push(nextService)
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
    await requestQuit(successorPid!)
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
  } catch (error) {
    failure = error
    throw error
  } finally {
    let service: CapturedService | undefined
    await runFixtureCleanup(
      [
        () => testInfo.attach('native-relaunch-root', { body: root, contentType: 'text/plain' }),
        async () => {
          service = await captureFixtureService(configRoot)
        },
        async () => {
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
        },
        async () => {
          if (successorPid && !exited(successorPid)) {
            await requestQuit(successorPid)
            await expect.poll(() => exited(successorPid!), { timeout: 25000 }).toBe(true)
          }
        },
        async () => {
          await browser?.close()
        },
        () => cleanupFixtureProcess(desktopProcess),
        () => cleanupFixtureService(service),
        ...capturedServices.map((captured) => () => cleanupFixtureService(captured))
      ],
      failure
    )
    if (completed) await removeTreeForCleanup(root)
  }
})
