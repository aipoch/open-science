import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchEnvironment, launchOpenScience } from './fixtures/electron-app'
import { NotebookRunRepository } from '../src/main/notebook/repository'
import { createRootNotebookLane } from '../src/main/notebook/lane-identity'

// Playwright requires a destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test('keeps real desktop connected through concurrent Notebook and session reads', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-notebook-burst-'))
  const roots = {
    storageRoot: join(root, 'storage'),
    userDataRoot: join(root, 'profile'),
    fakeAgentBinRoot: join(root, 'bin'),
    fakeRemoteItRoot: join(root, 'remote'),
    fakeRemoteItState: join(root, 'remote-state.json')
  }
  const cwd = join(root, 'workspace')
  await mkdir(roots.storageRoot)
  await mkdir(cwd)
  const application = await launchOpenScience(
    roots,
    false,
    false,
    roots.fakeRemoteItRoot,
    'hidden',
    false
  )
  try {
    await application.evaluate(({ dialog }) => {
      dialog.showErrorBox = (_title, content): void => {
        const state = globalThis as typeof globalThis & { firstDesktopError?: string }
        state.firstDesktopError ??= content
      }
    })
    const page = await application.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60000 })
      .toMatchObject({ phase: 'ready' })
    const setup = await page.evaluate(async (cwd) => {
      const project = await window.api.projects.create({
        name: 'Notebook transport burst',
        description: ''
      })
      const sessionId = 'notebook-burst-session'
      await window.api.sessions.saveSession({
        id: sessionId,
        projectId: project.id,
        cwd,
        title: 'Synthetic Notebook output',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: 'message-1',
            role: 'user',
            status: 'complete',
            eventIds: [],
            content: 's'.repeat(1024 * 1024),
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
      return {
        projectId: project.id,
        sessionId,
        dataRoot: (await window.api.storage.getInfo()).dataRoot
      }
    }, cwd)
    // Seed valid stored Notebook output before this Notebook is opened. No wire/socket mocking.
    const repository = new NotebookRunRepository(setup.dataRoot)
    const lane = createRootNotebookLane(
      setup.projectId,
      setup.sessionId,
      `root-frame-${setup.sessionId}`
    )
    await repository.loadOrCreate({ ...setup, lane, workspaceCwd: cwd })
    const stdout = 'x'.repeat(342122)
    for (let index = 0; index < 3; index++)
      await repository.appendRun({
        ...setup,
        lane,
        run: {
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          kernelKind: 'python',
          script: 'print("synthetic output")',
          status: 'completed',
          startedAt: index + 1,
          text: { stdout, stderr: '', traceback: '', plain: [] },
          outputs: [{ type: 'stream', name: 'stdout', text: stdout }],
          artifacts: [],
          workingFiles: []
        }
      })
    const request = { projectId: setup.projectId, sessionId: setup.sessionId, workspaceCwd: cwd }
    const baseline = await page.evaluate(async (request) => {
      const state = await window.api.notebook.state(request)
      return {
        runs: state.runs.length,
        bytes: new TextEncoder().encode(JSON.stringify(state)).length
      }
    }, request)
    expect(baseline.runs).toBe(3)
    expect(baseline.bytes).toBeGreaterThan(4 * 1024 * 1024 - 150000)
    expect(baseline.bytes).toBeLessThan(16 * 1024 * 1024)
    const result = await page.evaluate(async (request) => {
      const pending = [
        ...Array.from({ length: 4 }, () => window.api.notebook.state(request)),
        window.api.sessions.loadOne(request)
      ]
      const reads = await Promise.allSettled(pending)
      let followup = 'ok'
      try {
        await window.api.settings.getSettings()
      } catch (error) {
        followup = String(error)
      }
      return {
        reads: reads.map((read) =>
          read.status === 'fulfilled'
            ? { status: read.status }
            : { status: read.status, error: String(read.reason) }
        ),
        followup
      }
    }, request)
    const owner = JSON.parse(
      await readFile(join(roots.storageRoot, 'runtime-owner.json'), 'utf8')
    ) as { port: number; generation: string }
    const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
    const backendAlive = (
      await fetch(`http://127.0.0.1:${owner.port}/owner`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-open-science-runtime-generation': owner.generation
        },
        signal: AbortSignal.timeout(3000)
      })
    ).ok
    await testInfo.attach('real-electron-notebook-burst', {
      body: JSON.stringify({
        baseline,
        result,
        backendAlive,
        firstDesktopError: await application.evaluate(
          () => (globalThis as typeof globalThis & { firstDesktopError?: string }).firstDesktopError
        )
      }),
      contentType: 'application/json'
    })
    await testInfo.attach('desktop-log', {
      body: await readFile(join(roots.userDataRoot, 'logs/main.log')),
      contentType: 'text/plain'
    })
    await testInfo.attach('backend-log', {
      body: await readFile(join(roots.storageRoot, 'logs/main.log')),
      contentType: 'text/plain'
    })
    expect(backendAlive).toBe(true)
    expect(result.reads.every((read) => read.status === 'fulfilled')).toBe(true)
    expect(result.followup).toBe('ok')
  } finally {
    const stopped = await promisify(execFile)(
      process.execPath,
      [resolve('cli/index.mjs'), 'stop'],
      {
        env: {
          ...launchEnvironment(roots.storageRoot),
          OPEN_SCIENCE_USER_DATA: roots.userDataRoot
        },
        timeout: 30000
      }
    ).then(
      () => true,
      () => false
    )
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await application.close().catch(() => undefined)
    expect(stopped, `Test backend cleanup failed; retained evidence at ${root}`).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
