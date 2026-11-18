import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ElectronApplication } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'
import { readRawOutcomeSession } from './fixtures/session-outcome-fault'
import { openProjectSession } from './certification/helpers'

const nativeApplication = (app: object): ElectronApplication => {
  const application = (app as { application?: ElectronApplication }).application
  if (!application) throw new Error('The Electron fixture native application is unavailable.')
  return application
}

const freezeFixtureBackend = async (application: ElectronApplication): Promise<number> => {
  const backendPath = await application.evaluate(({ app }) => {
    const root = process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
    if (
      !root?.includes('open-science-electron-e2e-') ||
      root !== process.env.OPEN_SCIENCE_CONFIG_ROOT
    )
      throw new Error('The crash fixture requires isolated storage.')
    return process.getBuiltinModule('node:path')!.join(app.getAppPath(), 'out/backend/index.cjs')
  })
  const rootPid = application.process().pid
  if (!rootPid) throw new Error('The fixture Electron process is unavailable.')
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,command='], {
    maxBuffer: 16 * 1024 * 1024
  })
  const processes = stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u)
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }] : []
  })
  const descendants = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const entry of processes) {
      if (descendants.has(entry.parentPid) && !descendants.has(entry.pid)) {
        descendants.add(entry.pid)
        changed = true
      }
    }
  }
  const backends = processes.filter(
    (entry) => descendants.has(entry.pid) && entry.command.includes(backendPath)
  )
  expect(backends).toHaveLength(1)
  // Freeze persistence before child-first SIGKILL can turn the interrupted checkpoint into
  // a graceful ACP-error write. Only this isolated fixture's backend receives SIGSTOP.
  process.kill(backends[0].pid, 'SIGSTOP')
  return backends[0].pid
}

test('preserves a committed conversation through a forced crash and continues it once', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const project = 'Journal crash recovery'
  const prompt = 'Summarize the deterministic fixture.'
  await createProjectViaUi(page, project)
  await submitPromptViaUi(page, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  // Observe the durable authority, not just the renderer's visible streaming result.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const session = (await window.api.sessions.loadAll()).sessions[0]
        return {
          status: session?.status,
          outcome: session?.messages.find((message) => message.role === 'user')?.turnOutcome?.kind
        }
      })
    )
    .toEqual({ status: 'idle', outcome: 'completed' })
  const before = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  const promptsBefore = await app.readFakeAgentPrompts()
  page = await app.restartAfterCrash({ force: true })
  const restored = await page.evaluate(
    ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
    before
  )
  expect(restored?.messages).toEqual(before.messages)
  expect(restored?.revision).toBeGreaterThanOrEqual(before.revision!)
  expect(restored?.status).toBe('idle')
  expect(await app.readFakeAgentPrompts()).toEqual(promptsBefore)
  await openProjectSession(page, project, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible()
  const followup = 'Continue after the journal restart.'
  await submitPromptViaUi(page, followup)
  await expect
    .poll(() =>
      page.evaluate(
        async ({ projectId, id, followup }) => {
          const session = await window.api.sessions.loadOne({ projectId, sessionId: id })
          return {
            status: session?.status,
            prompts: session?.messages.filter((message) => message.role === 'user').length,
            followups: session?.messages.filter(
              (message) => message.role === 'user' && message.content === followup
            ).length,
            outcome: session?.messages.find((message) => message.content === followup)?.turnOutcome
              ?.kind
          }
        },
        { projectId: before.projectId, id: before.id, followup }
      )
    )
    .toEqual({ status: 'idle', prompts: 2, followups: 1, outcome: 'completed' })
  await page.screenshot({ path: testInfo.outputPath('journal-crash-continued.png') })
})

test.describe('in-flight journal recovery', () => {
  test.use({ windowMode: 'normal' })

  test('preserves a durable partial reply through a forced crash and resumes once without duplicate saves', async ({
    app
  }, testInfo) => {
    test.skip(process.platform === 'win32', 'The in-flight checkpoint requires POSIX SIGSTOP.')
    test.setTimeout(180_000)
    const prompt = 'Run the official science UI storage stream.'
    const first = 'Official science UI stream begins.'
    const last = 'Official science UI stream complete.'
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await createProjectViaUi(page, 'In-flight journal recovery')
    await submitPromptViaUi(page, prompt)
    await expect(page.getByText(first, { exact: false })).toBeVisible()
    const source = await page.evaluate(
      async () => (await window.api.sessions.loadAll()).sessions[0]
    )
    const identity = { projectId: source.projectId, sessionId: source.id }
    await expect
      .poll(async () => {
        const session = await readRawOutcomeSession(app, identity)
        const reply = session.messages.find((message) => message.content.startsWith(first))
        return session.status === 'running' && (reply?.content.length ?? 0) >= 4096
      })
      .toBe(true)

    const backendPid = await freezeFixtureBackend(nativeApplication(app))
    let crashed = false
    let partial!: PersistedChatSession
    let promptsBefore!: Awaited<ReturnType<typeof app.readFakeAgentPrompts>>
    try {
      partial = await readRawOutcomeSession(app, identity)
      const content = partial.messages.find((message) => message.content.startsWith(first))!.content
      expect(partial.runtimeTranscriptOwner).toBe('main')
      expect(partial.status).toBe('running')
      expect(content.length).toBeGreaterThanOrEqual(4096)
      expect(content.length).toBeLessThan(32768)
      expect(content).not.toContain(last)
      promptsBefore = await app.readFakeAgentPrompts()
      page = await app.restartAfterCrash({ force: true })
      crashed = true
    } finally {
      if (!crashed) {
        try {
          process.kill(backendPid, 'SIGCONT')
        } catch {
          // A failed relaunch may already have reaped the old backend.
        }
      }
    }

    const partialReply = partial.messages.find((message) => message.content.startsWith(first))!
    const restored = await readRawOutcomeSession(app, identity)
    expect(restored?.resumeRecovery).toMatchObject({
      kind: 'resume-required',
      cause: 'app-restart'
    })
    expect(restored?.messages.find((message) => message.id === partialReply.id)?.content).toBe(
      partialReply.content
    )
    await page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button')
      .filter({ has: page.getByText(prompt, { exact: true }) })
      .click()
    const resume = page.getByRole('button', { name: 'Resume session', exact: true })
    await expect(resume).toBeVisible()
    // This control renders only when contentLoaded=false and historyPage exists. Keep the
    // indexed view intact: the durable read above never hydrates the renderer before Resume.
    await expect(
      page.getByRole('button', { name: 'Load full conversation', exact: true })
    ).toBeVisible()
    expect(await app.readFakeAgentPrompts()).toEqual(promptsBefore)

    const application = nativeApplication(app)
    await application.evaluate(({ ipcMain }, sessionId) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const channel = 'sessions:save-session'
      const original = handlers.get(channel)
      if (!original) throw new Error('The Session save IPC handler is unavailable.')
      const calls: number[] = []
      const wrapped = (...args: unknown[]): unknown => {
        if ((args[1] as { id?: string } | undefined)?.id === sessionId)
          calls.push(performance.timeOrigin + performance.now())
        return original(...args)
      }
      handlers.set(channel, wrapped)
      Reflect.set(globalThis, 'journalResumeSaveProbe', () => {
        if (handlers.get(channel) === wrapped) handlers.set(channel, original)
        return calls
      })
    }, identity.sessionId)
    let firstResumedChunkEpoch: number | undefined
    let saveCalls: number[] = []
    try {
      await resume.click()
      const visible = await page.waitForFunction(
        ({ partialId, first }) =>
          [...document.querySelectorAll('[data-message-id]')].some(
            (element) =>
              element.getAttribute('data-message-id') !== partialId &&
              element.textContent?.includes(first)
          ) && performance.timeOrigin + performance.now(),
        { partialId: partialReply.id, first }
      )
      firstResumedChunkEpoch = (await visible.jsonValue()) as number
      await visible.dispose()
      await expect(
        page.getByRole('button', { name: 'Load full conversation', exact: true })
      ).toHaveCount(0)
      await expect(page.getByText(last, { exact: false }).last()).toBeVisible({ timeout: 40_000 })
      await expect
        .poll(async () => {
          const session = await readRawOutcomeSession(app, identity)
          return {
            status: session.status,
            users: session.messages.filter((message) => message.role === 'user').length,
            outcome: session.messages.find((message) => message.role === 'user')?.turnOutcome?.kind
          }
        })
        .toEqual({ status: 'idle', users: 1, outcome: 'completed' })
      // Observe three full two-second autosave intervals after completion as well as the stream.
      await page.waitForTimeout(6500)
    } finally {
      saveCalls = await application.evaluate(() => {
        const stop = Reflect.get(globalThis, 'journalResumeSaveProbe') as () => number[]
        Reflect.deleteProperty(globalThis, 'journalResumeSaveProbe')
        return stop()
      })
      await testInfo.attach('resumed-session-save-requests', {
        body: Buffer.from(JSON.stringify({ firstResumedChunkEpoch, saveCalls }, null, 2)),
        contentType: 'application/json'
      })
    }
    expect(saveCalls.filter((time) => time >= firstResumedChunkEpoch!)).toEqual([])
    const completed = await readRawOutcomeSession(app, identity)
    expect(completed.messages.find((message) => message.id === partialReply.id)?.content).toBe(
      partialReply.content
    )
    expect(completed.resumeRecovery).toBeUndefined()
    expect(completed.messages.some((message) => message.content.endsWith(last + '\n'))).toBe(true)
    expect(await app.readFakeAgentPrompts()).toHaveLength(promptsBefore.length + 1)
    await page.screenshot({ path: testInfo.outputPath('journal-partial-resumed.png') })
  })
})
