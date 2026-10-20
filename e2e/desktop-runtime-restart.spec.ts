import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchEnvironment, launchOpenScience } from './fixtures/electron-app'
import { NotebookRunRepository } from '../src/main/notebook/repository'
import { createRootNotebookLane } from '../src/main/notebook/lane-identity'
import { createProjectViaUi } from './fixtures/project'

for (const borrowed of [false, true])
  for (const retainBackend of [true, false]) {
    const largeConversations = !borrowed && retainBackend
    // The sizes are field metadata only. All session IDs, text and profiles are synthetic.
    // eslint-disable-next-line no-empty-pattern
    test(`disconnected ${borrowed ? 'borrowed' : 'owned'} desktop relaunch restores ${largeConversations ? 'large conversations' : 'persisted sessions'} with ${retainBackend ? 'retained original' : 'recreated owned'} backend`, async ({}, testInfo) => {
      const root = await mkdtemp(join(tmpdir(), 'open-science-restart-with spaces-'))
      const roots = {
        storageRoot: join(root, 'storage'),
        userDataRoot: join(root, 'profile'),
        fakeAgentBinRoot: join(root, 'bin'),
        fakeRemoteItRoot: join(root, 'remote'),
        fakeRemoteItState: join(root, 'remote.json')
      }
      const cwd = join(root, 'workspace')
      await mkdir(roots.storageRoot)
      await mkdir(cwd)
      const env = {
        ...launchEnvironment(roots.storageRoot),
        OPEN_SCIENCE_USER_DATA: roots.userDataRoot,
        ...(process.platform === 'darwin' && !process.env.OPEN_SCIENCE_E2E_EXECUTABLE
          ? {
              NODE_OPTIONS: `--require=${JSON.stringify(resolve('e2e/fixtures/mock-node-credentials.cjs'))}`
            }
          : {})
      }
      const stopBackend = (): Promise<unknown> =>
        promisify(execFile)(process.execPath, [resolve('cli/index.mjs'), 'stop'], {
          env,
          timeout: 30_000
        })
      let app: ElectronApplication | undefined
      let server: ReturnType<typeof spawn> | undefined
      const launch = async (): Promise<Page> => {
        app = await launchOpenScience(roots, false, false, roots.fakeRemoteItRoot, 'hidden', false)
        await app.evaluate(({ dialog }) => {
          dialog.showErrorBox = () => undefined
        })
        const page = await app.firstWindow()
        await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
        await expect
          .poll(() => page.evaluate(() => window.api?.databaseStartup.getState()), {
            timeout: 60_000
          })
          .toMatchObject({ phase: 'ready' })
        return page
      }
      const disconnect = (): Promise<void> =>
        app!.evaluate(() => {
          const pipes = (
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
            .filter(
              (handle) =>
                handle.readable && handle.writable && handle._handle?.constructor.name === 'Pipe'
            )
          if (pipes.length !== 1)
            throw new Error(`Expected one runtime pipe, found ${pipes.length}`)
          pipes[0].destroy()
        })
      try {
        if (borrowed) {
          server = spawn(
            process.execPath,
            [resolve('out/backend/index.cjs'), '--development', '--serve=0'],
            { env, stdio: 'ignore' }
          )
          await expect
            .poll(
              async () => {
                if (server!.exitCode !== null)
                  throw new Error('Fixture backend exited before bootstrap')
                try {
                  const state = JSON.parse(
                    await readFile(join(roots.storageRoot, 'web-service.json'), 'utf8')
                  )
                  const token = (
                    await readFile(join(roots.storageRoot, 'web-token'), 'utf8')
                  ).trim()
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
        }
        let page = await launch()
        await page.evaluate(() => window.api.settings.markOnboardingComplete())
        await page.reload({ waitUntil: 'domcontentloaded' })
        await createProjectViaUi(page, 'Restart fixtures')
        await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
        const setup = await page.evaluate(
          async ({ cwd, largeConversations }) => {
            const project = (await window.api.projects.list()).find(
              (item) => item.name === 'Restart fixtures'
            )!
            const sessionIds = largeConversations
              ? ['fixture-172', 'fixture-173', 'unrelated-session']
              : ['fixture-172', 'unrelated-session']
            for (const sessionId of sessionIds) {
              await window.api.sessions.saveSession({
                id: sessionId,
                projectId: project.id,
                cwd,
                title: sessionId,
                status: 'idle',
                createdAt: 1,
                updatedAt: 1,
                messages: [
                  {
                    id: `message-${sessionId}`,
                    role: 'user',
                    content: `Persisted restart ${sessionId}`,
                    status: 'complete',
                    eventIds: [],
                    createdAt: 1,
                    updatedAt: 1
                  }
                ]
              })
            }
            await window.api.sessions.saveManifest({ lastSessionId: 'fixture-172' })
            return {
              projectId: project.id,
              dataRoot: (await window.api.storage.getInfo()).dataRoot
            }
          },
          { cwd, largeConversations }
        )
        if (largeConversations) {
          const repo = new NotebookRunRepository(setup.dataRoot)
          for (const [sessionId, bytes] of [
            ['fixture-172', 1572865],
            ['fixture-173', 367002]
          ] as const) {
            const lane = createRootNotebookLane(setup.projectId, sessionId, `root-${sessionId}`)
            const request = { projectId: setup.projectId, sessionId, lane }
            await repo.loadOrCreate({ ...request, workspaceCwd: cwd })
            const stdout = 'x'.repeat(bytes)
            for (let index = 0; index < 3; index++)
              await repo.appendRun({
                ...request,
                run: {
                  runId: `${sessionId}-${index}`,
                  cellId: `cell-${index}`,
                  source: 'agent',
                  kernelKind: 'python',
                  script: 'print("synthetic")',
                  status: 'completed',
                  startedAt: index + 1,
                  text: { stdout, stderr: '', traceback: '', plain: [stdout] },
                  outputs: [{ type: 'stream', name: 'stdout', text: stdout }],
                  artifacts: [],
                  workingFiles: []
                }
              })
          }
        }
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.getByText('fixture-172', { exact: true }).click()
        await expect(page.getByText('Persisted restart fixture-172', { exact: true })).toBeVisible()
        if (largeConversations) {
          await page.getByRole('button', { name: 'Open notebook', exact: true }).click()
          await expect
            .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
            .toMatchObject({ phase: 'connected' })
          // A mounted large Notebook must not veto the whole recovery barrier.
          await disconnect()
          await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
          await expect
            .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
            .toMatchObject({ phase: 'connected' })
          await expect
            .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
            .toMatchObject({ phase: 'connected' })
        }
        await page.evaluate(() => window.api.settings.getSettings())
        const before = JSON.parse(
          await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
        ) as { pid: number; generation: string; desktop: { generation: string } }
        const firstPid = await app!.evaluate(() => process.pid)
        const backendParent = Number(
          (process.platform === 'win32'
            ? await promisify(execFile)(
                'powershell.exe',
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  `(Get-CimInstance Win32_Process -Filter "ProcessId = ${before.pid}").ParentProcessId`
                ],
                { timeout: 10_000 }
              )
            : await promisify(execFile)('ps', ['-o', 'ppid=', '-p', String(before.pid)], {
                timeout: 10_000
              })
          ).stdout.trim()
        )
        expect(backendParent).toBe(borrowed ? process.pid : firstPid)
        // Exit directly from a real disconnected state, without pressing Reconnect.
        await disconnect()
        await expect
          .poll(() => page.evaluate(() => window.api.desktopRuntime?.getState()))
          .toMatchObject({ phase: 'disconnected' })
        expect(
          await page.evaluate(
            async (projectId) =>
              (
                await Promise.allSettled([
                  window.api.settings.getSettings(),
                  window.api.sessions.loadOne({ projectId, sessionId: 'unrelated-session' })
                ])
              ).map((result) => result.status),
            setup.projectId
          )
        ).toEqual(['rejected', 'rejected'])
        // Terminate only the Desktop process created by this fixture. Its detached Runtime
        // must survive and the next genuine Desktop must claim controller authority.
        const crashedDesktop = app!.process()
        // Playwright wraps Electron in cmd.exe on Windows. Signal the PID obtained from
        // this application's main process, not the launcher or its detached Runtime tree.
        process.kill(firstPid, 'SIGKILL')
        await expect
          .poll(() => {
            try {
              process.kill(firstPid, 0)
              return false
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
              throw error
            }
          })
          .toBe(true)
        await expect
          .poll(() => crashedDesktop.exitCode !== null || crashedDesktop.signalCode !== null)
          .toBe(true)
        app = undefined
        if (!retainBackend) await stopBackend()
        page = await launch()
        expect(await app!.evaluate(() => process.pid)).not.toBe(firstPid)
        const after = JSON.parse(
          await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
        ) as { pid: number; generation: string; desktop: { generation: string } }
        if (retainBackend) expect(after).toEqual(before)
        else {
          expect(after.pid).not.toBe(before.pid)
          expect(after.generation).not.toBe(before.generation)
        }
        // Startup opens Home. Inspect durable selection before a user open can rewrite it.
        const results = await page.evaluate(
          async ({ projectId, cwd, largeConversations }) => {
            const outcomes = largeConversations
              ? await Promise.allSettled([
                  ...['fixture-172', 'fixture-173', 'fixture-173', 'fixture-173'].map((sessionId) =>
                    window.api.notebook.state({ projectId, sessionId, workspaceCwd: cwd })
                  ),
                  window.api.sessions.loadOne({ projectId, sessionId: 'unrelated-session' })
                ])
              : []
            const [settings, restored, other, { manifest }, hosts] = await Promise.all([
              window.api.settings.getSettings(),
              window.api.sessions.loadOne({ projectId, sessionId: 'fixture-172' }),
              window.api.sessions.loadOne({ projectId, sessionId: 'unrelated-session' }),
              window.api.sessions.loadAll(),
              window.api.compute.list()
            ])
            return {
              outcomes: outcomes.map((result) =>
                result.status === 'fulfilled'
                  ? {
                      status: result.status,
                      encodedValueBytes: new TextEncoder().encode(JSON.stringify(result.value))
                        .length
                    }
                  : { status: result.status, error: String(result.reason) }
              ),
              settingsAvailable: Boolean(settings),
              restored,
              manifest,
              otherId: other?.id,
              computeAvailable: Array.isArray(hosts),
              recovery: await window.api.desktopRuntime?.getState()
            }
          },
          { projectId: setup.projectId, cwd, largeConversations }
        )
        const metadata = {
          initialOwnership: borrowed ? 'borrowed' : 'owned',
          backendParent,
          exitedPhase: 'disconnected',
          retainedBackend: retainBackend,
          largeConversations,
          before: { pid: before.pid, generation: before.generation },
          after: { pid: after.pid, generation: after.generation },
          firstPid,
          secondPid: await app!.evaluate(() => process.pid),
          results
        }
        console.log('Generated restart metadata', JSON.stringify(metadata))
        await testInfo.attach('restart-metadata', {
          body: JSON.stringify(metadata),
          contentType: 'application/json'
        })
        expect(results.settingsAvailable).toBe(true)
        expect(results.computeAvailable).toBe(true)
        expect(results.otherId).toBe('unrelated-session')
        expect(results.manifest.lastSessionId).toBe('fixture-172')
        expect(results.restored).toMatchObject({
          id: 'fixture-172',
          projectId: setup.projectId,
          cwd,
          title: 'fixture-172',
          messages: [{ id: 'message-fixture-172', content: 'Persisted restart fixture-172' }]
        })
        if (largeConversations) {
          expect(results.outcomes.slice(1).every((result) => result.status === 'fulfilled')).toBe(
            true
          )
          if (results.outcomes[0].status === 'rejected')
            expect(results.outcomes[0].error).toContain(
              'response exceeds the transport byte budget'
            )
        }
        expect(results.recovery).toMatchObject({ phase: 'connected' })
        await page
          .getByRole('region', { name: 'Recent sessions' })
          .getByRole('button', { name: /^fixture-172/ })
          .click()
        await expect(page.getByText('Persisted restart fixture-172', { exact: true })).toBeVisible()
        const desktop = app!.process()
        void app!.close().catch(() => undefined)
        await expect.poll(() => desktop.exitCode, { timeout: 25000 }).toBe(0)
        app = undefined
        if (!borrowed || !retainBackend) {
          const record = JSON.parse(
            await readFile(join(roots.storageRoot, 'runtime-exit.json'), 'utf8')
          )
          expect(record).toMatchObject({
            pid: after.pid,
            generation: after.desktop.generation,
            outcome: 'clean'
          })
          await expect
            .poll(() => {
              try {
                process.kill(after.pid, 0)
                return false
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ESRCH'
              }
            })
            .toBe(true)
        }
        await stopBackend()
        acquireRuntimeDirectorySync(roots.storageRoot).release()
      } catch (error) {
        for (const [name, path] of [
          ['desktop-log', join(roots.userDataRoot, 'desktop-logs/main.log')],
          ['runtime-log', join(roots.storageRoot, 'logs/main.log')]
        ]) {
          await testInfo.attach(name, {
            body: await readFile(path).catch(() => Buffer.from('unavailable')),
            contentType: 'text/plain'
          })
        }
        throw error
      } finally {
        const desktop = app?.process()
        if (app && desktop) {
          const cleanupTimer = setTimeout(() => desktop.kill('SIGKILL'), 5000)
          try {
            await app.evaluate(({ app }) => app.exit(0)).catch(() => desktop.kill('SIGKILL'))
          } finally {
            clearTimeout(cleanupTimer)
          }
        }
        if (desktop)
          await expect
            .poll(() => desktop.exitCode !== null || desktop.signalCode !== null, {
              timeout: 10_000
            })
            .toBe(true)
        await stopBackend().catch(() => undefined)
        if (server && server.exitCode === null && server.signalCode === null) {
          server.kill('SIGTERM')
          await expect
            .poll(() => server!.exitCode !== null || server!.signalCode !== null, {
              timeout: 10_000
            })
            .toBe(true)
        }
        await rm(root, { recursive: true, force: true })
      }
    })
  }
