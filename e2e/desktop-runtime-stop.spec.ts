import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { launchOpenScience, removeTreeForCleanup } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

const makeFixtureWritable = async (root: string): Promise<void> => {
  await chmod(root, 0o700)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeFixtureWritable(join(root, entry.name))
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (processAlive(pid) && Date.now() < deadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  if (processAlive(pid)) throw new Error(`Owned process ${pid} did not exit within ${timeoutMs}ms`)
}

// Playwright requires a destructured fixture argument even when no fixtures are requested.
// eslint-disable-next-line no-empty-pattern
test('keeps the desktop connected after stopping several active chats through the UI', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'open-science-stop-e2e-'))
  const roots = {
    storageRoot: join(root, 'storage'),
    userDataRoot: join(root, 'electron-profile'),
    fakeAgentBinRoot: join(root, 'bin'),
    fakeRemoteItRoot: join(root, 'remote'),
    fakeRemoteItState: join(root, 'remote-state.json')
  }
  await mkdir(roots.storageRoot)
  await mkdir(roots.fakeAgentBinRoot)
  const launcher = join(
    roots.fakeAgentBinRoot,
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
  )
  const agent = resolve('e2e/fixtures/fake-opencode.mjs')
  await writeFile(
    launcher,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${agent}" %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(agent)} "$@"\n`
  )
  if (process.platform !== 'win32') await chmod(launcher, 0o755)
  await writeFile(
    join(roots.storageRoot, 'settings.json'),
    JSON.stringify({
      version: 1,
      opencodePath: launcher,
      opencodeVersion: '1.0.0',
      agentFramework: 'opencode',
      localePreference: 'en',
      sessionDetailsModel: { mode: 'disabled' }
    })
  )
  const application = await launchOpenScience(
    roots,
    true,
    false,
    roots.fakeRemoteItRoot,
    // The streaming assertion needs animation frames. Keep the Electron window visible on every
    // desktop platform so Windows does not throttle the smooth-streaming timer in hidden mode.
    'normal',
    false
  )
  const page = await application.firstWindow()
  const ownerPath = join(roots.storageRoot, 'runtime-owner.json')
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number; generation: string }
  const before = { pid: owner.pid, generation: owner.generation }
  let phase = 'create project'
  let stoppedChats = 0
  let postStopReadChecks = 0
  const failures: { at: string; phase: string; message: string }[] = []
  page.on('pageerror', (error) =>
    failures.push({ at: new Date().toISOString(), phase, message: error.message })
  )
  page.on('console', (message) => {
    if (message.type() === 'error')
      failures.push({ at: new Date().toISOString(), phase, message: message.text() })
  })
  let primaryError: unknown
  try {
    await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()))
      .toMatchObject({ phase: 'ready' })
    await page.evaluate(async () => {
      await window.api.settings.markOnboardingComplete()
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Stop E2E provider',
        apiEndpoints: ['chat-completions'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'e2e-model',
        key: 'e2e-key',
        supportsImageInput: true
      })
      const provider = snapshot.providers.find((item) => item.name === 'Stop E2E provider')!
      await window.api.settings.setActiveProvider({ id: provider.id, model: 'e2e-model' })
      await window.api.settings.setAgentFramework({ id: 'opencode' })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await createProjectViaUi(page, 'Desktop stop connection regression')
    for (let round = 0; round < 2; round++) {
      const sessions: string[] = []
      for (let chat = 0; chat < 3; chat++) {
        phase = `round ${round + 1}: start chat ${chat + 1}`
        if (round || chat) await page.getByRole('button', { name: 'New', exact: true }).click()
        const prompt = `Hold the turn outcome fixture. Stop regression ${round}-${chat}`
        await submitPromptViaUi(page, prompt)
        await expect(
          page.getByText('Turn outcome cancellation checkpoint.', { exact: false })
        ).toBeVisible()
        const id = await page.evaluate(async (text) => {
          const session = (await window.api.sessions.loadAll()).sessions.find((candidate) =>
            candidate.messages.some(
              (message) => message.role === 'user' && message.content === text
            )
          )
          if (!session) throw new Error('Started session was not persisted.')
          return session.id
        }, prompt)
        sessions.push(id)
      }
      await expect
        .poll(() =>
          page.evaluate(
            async (ids) =>
              (await window.api.sessions.loadAll()).sessions.filter(
                (session) => ids.includes(session.id) && session.status === 'running'
              ).length,
            sessions
          )
        )
        .toBe(3)
      for (const id of [sessions[1], sessions[0], sessions[2]]) {
        phase = `round ${round + 1}: Stop ${id}`
        await page.locator(`[data-session-id="${id}"] [data-slot="session-open-button"]`).click()
        await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
        stoppedChats += 1
        await expect(
          page.getByRole('button', { name: 'Resume session', exact: true })
        ).toBeVisible()
        await page.evaluate(async () => {
          await window.api.settings.getClassification()
          await window.api.sessions.loadAll()
        })
      }
    }
    phase = 'observe delayed disconnect for 22 seconds after Stop'
    const observationDeadline = Date.now() + 22_000
    while (Date.now() < observationDeadline) {
      await page.bringToFront()
      await page.evaluate(async () => {
        await window.api.settings.getClassification()
        await window.api.sessions.loadAll()
      })
      postStopReadChecks += 1
      await page.waitForTimeout(1000)
    }
    phase = 'fresh prompt after six Stops'
    await page.getByRole('button', { name: 'New', exact: true }).click()
    const fresh = 'Summarize the deterministic fixture.'
    await submitPromptViaUi(page, fresh)
    await expect(page.getByText(`Deterministic reply: ${fresh}`, { exact: false })).toBeVisible()
    const after = JSON.parse(await readFile(ownerPath, 'utf8'))
    expect(after.pid).toBe(before.pid)
    expect(after.generation).toBe(before.generation)
    process.kill(before.pid, 0)
    expect(failures).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('six-stops-connected.png') })
  } catch (error) {
    failures.push({ at: new Date().toISOString(), phase, message: String(error) })
    primaryError = error
  } finally {
    const cleanup: {
      cliStop?: { exitCode?: number | string; stdout?: string; stderr?: string; error?: string }
      desktopTermination?: {
        command: string
        exitCode?: number | string
        stdout?: string
        stderr?: string
        error?: string
      }
      desktopExited?: boolean
      desktopGracefulExit?: boolean
      forcedTermination?: boolean
      backendExited?: boolean
      profileCleanup?: { completed: boolean; error?: string }
      error?: string
    } = {}
    const cleanupErrors: string[] = []
    for (const [name, path] of [
      ['electron-log', join(roots.userDataRoot, 'desktop-logs', 'main.log')],
      ['backend-log', join(roots.storageRoot, 'logs', 'main.log')]
    ]) {
      await testInfo.attach(name, {
        body: await readFile(path).catch(() => Buffer.from('Log unavailable')),
        contentType: 'text/plain'
      })
    }
    // Keep the real connection available while requesting normal application shutdown.
    const child = application.process()
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await Promise.race([
          application.close(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Electron graceful close timed out')), 10_000)
          )
        ])
        await waitForProcessExit(child.pid!, 10_000)
        cleanup.desktopExited = true
        cleanup.desktopGracefulExit = true
      } catch (error) {
        cleanup.desktopGracefulExit = false
        cleanup.desktopTermination = {
          command: 'ElectronApplication.close()',
          error: String(error)
        }
        if (process.platform === 'win32') {
          const command = 'taskkill /PID ' + String(child.pid) + ' /T /F'
          try {
            const result = await promisify(execFile)(
              'taskkill',
              ['/PID', String(child.pid), '/T', '/F'],
              {
                timeout: 10_000,
                windowsHide: true,
                maxBuffer: 1024 * 1024
              }
            )
            cleanup.desktopTermination = {
              command,
              exitCode: 0,
              stdout: result.stdout,
              stderr: result.stderr
            }
            cleanup.forcedTermination = true
          } catch (terminationError) {
            const failure = terminationError as NodeJS.ErrnoException & {
              stdout?: string
              stderr?: string
              code?: number | string
            }
            cleanup.desktopTermination = {
              command,
              exitCode: failure.code,
              stdout: failure.stdout,
              stderr: failure.stderr,
              error: String(terminationError)
            }
            cleanupErrors.push(`taskkill failed: ${String(terminationError)}`)
          }
        } else {
          child.kill('SIGKILL')
          cleanup.forcedTermination = true
        }
        try {
          await waitForProcessExit(child.pid!, 10_000)
          cleanup.desktopExited = true
        } catch (waitError) {
          cleanup.desktopExited = false
          cleanupErrors.push(String(waitError))
        }
      }
    } else {
      cleanup.desktopExited = true
      cleanup.desktopGracefulExit = true
    }
    // Stop the desktop first so its owned runtime receives the normal quit request.
    // CLI stop is failure cleanup only; stopping it first would disconnect the desktop.
    if (processAlive(before.pid)) {
      try {
        const result = await promisify(execFile)(
          process.execPath,
          [resolve('cli/index.mjs'), 'stop'],
          {
            env: {
              ...process.env,
              OPEN_SCIENCE_CONFIG_ROOT: roots.storageRoot,
              OPEN_SCIENCE_STORAGE_ROOT: roots.storageRoot
            },
            timeout: 30_000,
            windowsHide: true,
            maxBuffer: 1024 * 1024
          }
        )
        cleanup.cliStop = { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
          stdout?: string
          stderr?: string
          code?: number | string
        }
        cleanup.cliStop = {
          exitCode: failure.code,
          stdout: failure.stdout,
          stderr: failure.stderr,
          error: String(error)
        }
      }
    }
    try {
      await waitForProcessExit(before.pid, 10_000)
      cleanup.backendExited = true
    } catch (error) {
      cleanup.backendExited = false
      cleanupErrors.push(String(error))
    }
    if (cleanupErrors.length > 0) cleanup.error = cleanupErrors.join('; ')
    const backendAlive = processAlive(before.pid)
    const evidence = {
      phase,
      stoppedChats,
      postStopReadChecks,
      before,
      backendAlive,
      failures,
      cleanup
    }
    if (cleanupErrors.length > 0 && !primaryError)
      primaryError = new Error(cleanupErrors.join('; '))
    if (cleanup.desktopExited && cleanup.backendExited && !backendAlive) {
      try {
        await makeFixtureWritable(root)
        await removeTreeForCleanup(root)
        cleanup.profileCleanup = { completed: true }
      } catch (error) {
        cleanup.profileCleanup = { completed: false, error: String(error) }
        cleanup.error = [cleanup.error, `profile cleanup failed: ${String(error)}`]
          .filter(Boolean)
          .join('; ')
        if (!primaryError) primaryError = error
      }
    } else {
      cleanup.profileCleanup = {
        completed: false,
        error: 'Skipped because owned Electron or backend process exit was not confirmed.'
      }
      const cleanupError = new Error(cleanup.profileCleanup.error)
      cleanup.error = [cleanup.error, cleanupError.message].filter(Boolean).join('; ')
      if (!primaryError) primaryError = cleanupError
    }
    evidence.cleanup = cleanup
    await writeFile(testInfo.outputPath('stop-evidence.json'), JSON.stringify(evidence, null, 2))
    await testInfo.attach('stop-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json'
    })
  }
  if (primaryError) throw primaryError
})
