import { expect, test as base } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { terminateProcessTree } from '../src/main/process-tree'
import {
  closeElectronApplicationForCleanup,
  launchOpenScience,
  setFixtureServiceReconnectBlocked
} from './fixtures/electron-app'
import {
  cleanupObservedFixtureService,
  observeFixtureService,
  runFixtureCleanup
} from './fixtures/local-service-cleanup'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'
import { openProjectSession } from './certification/helpers'

const mainTitle = 'Visible conversation'
const backgroundTitle = 'Background conversation'
const warningTitle = 'Conversation storage needs attention'
const warningMessage =
  'Open-Science could not save the latest conversation changes. Retry before closing the app.'
const liveOpenCodeConfig = process.env.OPEN_SCIENCE_E2E_LIVE_OPENCODE_CONFIG
const recoveryStateDelayMs = Number(process.env.OPEN_SCIENCE_E2E_RECOVERY_STATE_DELAY_MS ?? 0)

type Desktop = {
  application: ElectronApplication
  page: Page
  projectId: string
  backgroundId: string
  desktopLogPath: string
  persistenceErrors: PersistenceErrorProbe[]
}
type LiveAgent = { model: string; executable: string; version: string }
type PersistenceErrorProbe = {
  name: string
  code: string | null
  hasNonRendererStackFrame: boolean
  messageKind: string
}

const sessionRow = (page: Page, title: string): Locator =>
  page
    .getByRole('navigation', { name: 'Sessions' })
    .locator('button[data-slot="session-open-button"]')
    .filter({ hasText: title })

const togglePin = async (page: Page, action: 'Pin' | 'Unpin'): Promise<void> => {
  await sessionRow(page, backgroundTitle).hover()
  await page
    .getByRole('button', { name: `Open actions for ${backgroundTitle}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

const configureLiveOpenCode = (
  application: ElectronApplication,
  configPath: string
): Promise<LiveAgent> =>
  application.evaluate(async ({ BrowserWindow }, path) => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    const separator = String(config.model).indexOf('/')
    const provider = config.provider?.[String(config.model).slice(0, separator)]
    const model = String(config.model).slice(separator + 1)
    if (
      separator < 1 ||
      provider?.npm !== '@ai-sdk/openai-compatible' ||
      typeof provider.options?.apiKey !== 'string' ||
      !provider.options?.baseURL
    )
      throw new Error(
        'Live reproduction requires a configured OpenAI-compatible OpenCode provider.'
      )
    const request = {
      type: 'custom',
      name: 'OpenCode live storage reproduction',
      apiEndpoints: ['chat-completions'],
      baseUrl: provider.options.baseURL,
      key: provider.options.apiKey,
      model,
      supportsImageInput: true
    }
    // Read credentials only inside Main. Playwright receives the source path and safe identity;
    // neither evaluation arguments, trace metadata nor captured results contain the key.
    return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(async () => {
      const snapshot = await window.api.settings.upsertProvider(${JSON.stringify(request)});
      const provider = snapshot.providers.find(item => item.name === 'OpenCode live storage reproduction');
      if (!provider) throw new Error('Live provider was not saved.');
      await window.api.settings.setActiveProvider({id: provider.id, model: ${JSON.stringify(model)}});
      await window.api.settings.setAgentFramework({id: 'opencode'});
      await window.api.settings.setSessionDetailsModel({configuration: {mode: 'disabled'}});
      const settings = await window.api.settings.detectOpencode();
      if (!settings.opencode.resolvedPath) throw new Error('OpenCode executable was not detected.');
      return {model: settings.activeModel, executable: settings.opencode.resolvedPath, version: settings.opencode.version};
    })()`)
  }, configPath)

// A real, isolated Electron/main/preload/backend stack. Only the failing boundary or the
// timing of a real pipe disconnection is controlled; the renderer/store/save UI stays intact.
const test = base.extend<{ desktop: Desktop }>({
  desktop: [
    // Playwright requires destructuring even when no base fixture is needed.
    // eslint-disable-next-line no-empty-pattern
    async ({}, install, testInfo) => {
      // Keep native SQLite and OpenCode paths under the Windows path length limit.
      await mkdir(testInfo.project.outputDir, { recursive: true })
      const root = await mkdtemp(join(testInfo.project.outputDir, 'p-'))
      await testInfo.attach('isolated-profile-location', {
        body: JSON.stringify({ root }),
        contentType: 'application/json'
      })
      const roots = {
        storageRoot: join(root, 'storage'),
        userDataRoot: join(root, 'profile'),
        fakeAgentBinRoot: join(root, 'bin'),
        fakeRemoteItRoot: join(root, 'remote'),
        fakeRemoteItState: join(root, 'remote-state.json')
      }
      const cwd = join(root, 'workspace')
      await mkdir(roots.storageRoot, { recursive: true })
      await mkdir(cwd, { recursive: true })
      const application = await launchOpenScience(
        roots,
        false,
        false,
        roots.fakeRemoteItRoot,
        'hidden',
        false
      )
      const output: string[] = []
      for (const stream of [application.process().stdout, application.process().stderr])
        stream?.on('data', (chunk: Buffer) => output.push(chunk.toString()))
      try {
        const page = await application.firstWindow()
        const persistenceErrors: PersistenceErrorProbe[] = []
        page.on('console', (message) => {
          if (
            message.type() !== 'warning' ||
            !message.text().startsWith('Session persistence failed')
          )
            return
          const error = message.args()[1]
          if (!error) return
          void error
            .evaluate((value: unknown) => {
              const error = value as {
                name?: unknown
                code?: unknown
                stack?: unknown
                message?: unknown
              }
              const names = [
                'Error',
                'ApplicationCommandError',
                'DesktopRuntimeDisconnectedError',
                'SessionSizeLimitError'
              ]
              const codes = [
                'command-failed',
                'desktop-runtime-disconnected',
                'desktop-runtime-not-submitted',
                'session-size-limit',
                'session-revision-conflict'
              ]
              const message = typeof error?.message === 'string' ? error.message : ''
              return {
                name:
                  typeof error?.name === 'string' && names.includes(error.name)
                    ? error.name
                    : 'other',
                code:
                  typeof error?.code === 'string' && codes.includes(error.code) ? error.code : null,
                // Reconstructing the public error in the renderer creates a local stack.
                hasNonRendererStackFrame:
                  typeof error?.stack === 'string' &&
                  error.stack
                    .split(/\r?\n/)
                    .slice(1)
                    .some((frame) => !frame.includes(new URL('.', location.href).href)),
                messageKind: message.includes('result of a submitted operation is unknown')
                  ? 'submitted-result-unknown'
                  : message.includes('byte persistence limit')
                    ? 'session-size-limit'
                    : message.includes('Session revision conflict:')
                      ? 'session-revision-conflict'
                      : message.includes('E2E transient Session storage failure')
                        ? 'injected-save-failure'
                        : 'other'
              }
            })
            .then((probe) => persistenceErrors.push(probe))
            .catch(() => undefined)
        })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
        await expect
          .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), {
            timeout: 60_000
          })
          .toMatchObject({ phase: 'ready' })
        await page.evaluate(async () => {
          await window.api.locale.setPreference({ preference: 'en' })
          await window.api.settings.markOnboardingComplete()
        })
        const liveAgent = liveOpenCodeConfig
          ? await configureLiveOpenCode(application, liveOpenCodeConfig)
          : undefined
        await page.reload({ waitUntil: 'domcontentloaded' })
        await createProjectViaUi(page, 'Storage warning reproduction')
        await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
        const projectId = await page.evaluate(
          async () =>
            (await window.api.projects.list()).find(
              (entry) => entry.name === 'Storage warning reproduction'
            )!.id
        )
        let backgroundId = 'storage-warning-background'
        if (liveAgent) {
          // Create through the UI so OpenCode owns a genuine provider Session identity.
          await submitPromptViaUi(
            page,
            'Reply with exactly STORAGE_REPRO_LIVE_READY. Do not use tools or read any files.'
          )
          await expect
            .poll(
              () =>
                page.evaluate(async (projectId) => {
                  const saved = (await window.api.sessions.loadAll()).sessions.find(
                    (session) => session.projectId === projectId
                  )
                  return saved?.messages.some(
                    (message) =>
                      message.role === 'agent' &&
                      message.status === 'complete' &&
                      message.content.includes('STORAGE_REPRO_LIVE_READY')
                  )
                }, projectId),
              { timeout: 90_000 }
            )
            .toBe(true)
          await expect(
            page.getByText('STORAGE_REPRO_LIVE_READY', { exact: true }).last()
          ).toBeVisible({ timeout: 20_000 })
          await expect
            .poll(() => page.evaluate(() => window.api.storage.detectActive()), {
              timeout: 90_000
            })
            .toEqual([])
          const saved = await page.evaluate(
            async (projectId) =>
              (await window.api.sessions.loadAll()).sessions.find(
                (session) => session.projectId === projectId
              ),
            projectId
          )
          if (!saved) throw new Error('Live OpenCode Session was not persisted.')
          backgroundId = saved.id
          expect(saved?.runtimeTranscriptOwner).toBe('main')
          expect(
            saved?.messages.filter(
              (message) => message.role === 'agent' && message.status === 'complete'
            ).length
          ).toBeGreaterThan(0)
          await page.evaluate((request) => window.api.sessions.editDetails(request), {
            projectId,
            sessionId: backgroundId,
            title: backgroundTitle,
            description: ''
          })
          await testInfo.attach('live-opencode-result', {
            body: JSON.stringify({
              ...liveAgent,
              framework: 'opencode',
              sessionId: backgroundId,
              status: saved?.status,
              runtimeTranscriptOwner: saved?.runtimeTranscriptOwner,
              completedAgentMessages: saved?.messages.filter(
                (message) => message.role === 'agent' && message.status === 'complete'
              ).length
            }),
            contentType: 'application/json'
          })
        }
        await page.evaluate(
          async ({ cwd, projectId, live }) => {
            const now = Date.now()
            const sessions = [['storage-warning-main', 'Visible conversation']]
            if (!live) sessions.push(['storage-warning-background', 'Background conversation'])
            for (const [id, title] of sessions)
              await window.api.sessions.saveSession({
                id,
                projectId,
                title,
                cwd,
                status: 'idle',
                createdAt: now,
                updatedAt: now,
                messages: [
                  {
                    id: `message-${id}`,
                    role: 'user',
                    content: `Saved content for ${title}`,
                    status: 'complete',
                    eventIds: [],
                    createdAt: now,
                    updatedAt: now
                  }
                ]
              })
            await window.api.sessions.saveManifest({ lastSessionId: 'storage-warning-main' })
          },
          { cwd, projectId, live: Boolean(liveAgent) }
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        // Load both bodies before testing a background preference save.
        await openProjectSession(page, 'Storage warning reproduction', backgroundTitle)
        await expect(
          page
            .getByText(
              liveAgent ? 'STORAGE_REPRO_LIVE_READY' : `Saved content for ${backgroundTitle}`,
              { exact: true }
            )
            .last()
        ).toBeVisible()
        await sessionRow(page, mainTitle).click()
        await expect(sessionRow(page, mainTitle)).toHaveAttribute('aria-current', 'page')
        await expect(
          page.getByText(`Saved content for ${mainTitle}`, { exact: true })
        ).toBeVisible()
        await expect(page.getByTestId('session-persistence-alert')).toHaveCount(0)
        await install({
          application,
          page,
          projectId,
          backgroundId,
          desktopLogPath: join(roots.userDataRoot, 'desktop-logs', 'main.log'),
          persistenceErrors
        })
      } finally {
        await application.evaluate(setFixtureServiceReconnectBlocked, false).catch(() => undefined)
        await application
          .evaluate(() => {
            for (const name of [
              'restoreStorageWarningRepro',
              'restoreStorageOutcomeProbe',
              'restoreStorageRecoveryDelivery'
            ]) {
              const restore = Reflect.get(globalThis, name) as (() => void) | undefined
              restore?.()
            }
          })
          .catch(() => undefined)
        for (const [name, directory] of [
          ['desktop', join(roots.userDataRoot, 'desktop-logs')],
          ['backend', join(roots.storageRoot, 'logs')]
        ]) {
          for (const file of await readdir(directory).catch(() => [])) {
            if (file !== 'main.log' && !/^desktop-backend-\d+-\d+\.log$/u.test(file)) continue
            await testInfo.attach(`${name}-${file}`, {
              body: await readFile(join(directory, file)),
              contentType: 'text/plain'
            })
          }
        }
        await testInfo.attach('electron-process-output', {
          body: output.join(''),
          contentType: 'text/plain'
        })
        const service = await observeFixtureService(roots.storageRoot)
        await runFixtureCleanup([
          () =>
            closeElectronApplicationForCleanup(
              {
                close: () => application.close(),
                forceClose: async () => {
                  if (!(await terminateProcessTree(application.process())).reaped)
                    throw new Error('Reproduction Electron process did not exit.')
                }
              },
              { gracefulTimeoutMs: 10_000, forcedTimeoutMs: 15_000 }
            ),
          () => cleanupObservedFixtureService(service)
        ])
      }
    },
    { timeout: 180_000 }
  ]
})

test('identifies a failed background Session and clears only its confirmed successful save', async ({
  desktop: { application, page, projectId, backgroundId }
}, testInfo) => {
  await application.evaluate(({ ipcMain }, targetId) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
      string,
      (...args: unknown[]) => unknown
    >
    const original = handlers.get('sessions:save-session')
    if (!original) throw new Error('Session save handler missing.')
    Reflect.set(globalThis, 'restoreStorageWarningRepro', () =>
      handlers.set('sessions:save-session', original)
    )
    handlers.set('sessions:save-session', async (...args) => {
      const session = args[1] as { id: string }
      if (session.id === targetId) throw new Error('E2E transient Session storage failure')
      return original(...args)
    })
  }, backgroundId)
  await togglePin(page, 'Pin')
  const alert = page.getByTestId('session-persistence-alert')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText(warningTitle)
  await expect(alert).toContainText(warningMessage)
  await expect(alert.getByTestId('session-persistence-retry')).toBeVisible()
  await expect(alert).toContainText(backgroundTitle)
  await expect
    .poll(() => alert.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true)
  await expect(sessionRow(page, mainTitle)).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: testInfo.outputPath('warning-visible.png') })
  const persistedBefore = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: backgroundId
  })
  expect(persistedBefore?.pinned).not.toBe(true)
  await alert
    .getByRole('button', { name: `Open conversation: ${backgroundTitle}`, exact: true })
    .click()
  await expect(sessionRow(page, backgroundTitle)).toHaveAttribute('aria-current', 'page')
  await sessionRow(page, mainTitle).click()
  await expect(alert).toBeVisible()

  await application.evaluate(() =>
    (Reflect.get(globalThis, 'restoreStorageWarningRepro') as () => void)()
  )
  // Ordinary UI activity triggers another automatic save; no Retry or Dismiss is clicked.
  await togglePin(page, 'Unpin')
  await expect(alert).toHaveCount(0)
  const persistedAfter = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: backgroundId
  })
  expect(persistedAfter).toBeDefined()
  // Session JSON omits false optional flags when it is normalized for storage.
  expect(Boolean(persistedAfter?.pinned)).toBe(false)
  expect(persistedAfter?.revision).toBeGreaterThan(persistedBefore?.revision ?? 0)
  await page.screenshot({ path: testInfo.outputPath('warning-cleared.png') })
  await testInfo.attach('reproduction-result', {
    body: JSON.stringify({
      trigger: 'IPC save rejection for a background Session',
      sessionId: backgroundId,
      activeSessionId: 'storage-warning-main',
      warningVisible: true,
      warningClearedWithoutRetryOrDismiss: true,
      durableRevisionBefore: persistedBefore?.revision,
      durableRevisionAfter: persistedAfter?.revision
    }),
    contentType: 'application/json'
  })
})

test('verifies a saved Session after losing its acknowledgement on the real runtime pipe', async ({
  desktop: { application, page, projectId, backgroundId, desktopLogPath, persistenceErrors }
}, testInfo) => {
  const before = await page.evaluate(() => window.api.desktopRuntime!.getState())
  const savedBefore = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: backgroundId
  })
  if (recoveryStateDelayMs > 0) {
    await application.evaluate(({ BrowserWindow }, delayMs) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const original = contents.send
      const queued = new Map<ReturnType<typeof setTimeout>, [string, ...unknown[]]>()
      const release = (): void => {
        if (contents.send === delayed) contents.send = original
        for (const [timer, args] of queued) {
          clearTimeout(timer)
          Reflect.apply(original, contents, args)
        }
        queued.clear()
      }
      const delayed = (channel: string, ...args: unknown[]): void => {
        if (channel === 'desktop-runtime:state-changed') {
          // Preserve event order and spacing; batching every phase into one delivery would
          // introduce a second variable by hiding intermediate phases from React.
          const timer = setTimeout(() => {
            queued.delete(timer)
            Reflect.apply(original, contents, [channel, ...args])
          }, delayMs)
          queued.set(timer, [channel, ...args])
          return
        }
        Reflect.apply(original, contents, [channel, ...args])
      }
      contents.send = delayed
      Reflect.set(globalThis, 'restoreStorageRecoveryDelivery', release)
    }, recoveryStateDelayMs)
  }
  await application.evaluate(({ ipcMain }, sessionId) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    const original = handlers.get('sessions:save-session')
    if (!original) throw new Error('Session save handler missing for outcome probe.')
    const outcomes: Array<{ ok: boolean; code: string | null; submittedResultUnknown: boolean }> =
      []
    Reflect.set(globalThis, 'storageSaveOutcomeProbes', outcomes)
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const result = await original(...args)
      if ((args[1] as { id?: string })?.id === sessionId) {
        const outcome = result as { ok: boolean; error?: { code?: string; message?: string } }
        outcomes.push({
          ok: outcome.ok,
          code: outcome.error?.code ?? null,
          submittedResultUnknown:
            outcome.error?.message?.includes('result of a submitted operation is unknown') ?? false
        })
      }
      return result
    }
    handlers.set('sessions:save-session', wrapped)
    Reflect.set(globalThis, 'restoreStorageOutcomeProbe', () => {
      // Recovery installs a replacement adapter; never overwrite its current handler.
      if (handlers.get('sessions:save-session') === wrapped)
        handlers.set('sessions:save-session', original)
    })
  }, backgroundId)
  await page.evaluate(() => {
    const samples: Array<{
      at: number
      storageWarning: boolean
      checkingStorage: boolean
      runtimeRecovery: boolean
    }> = []
    const capture = (): void => {
      const sample = {
        at: Date.now(),
        storageWarning:
          document
            .querySelector('[data-testid="session-persistence-alert"]')
            ?.textContent?.includes('Conversation storage needs attention') ?? false,
        checkingStorage:
          document
            .querySelector('[data-testid="session-persistence-alert"]')
            ?.textContent?.includes('Checking conversation storage') ?? false,
        runtimeRecovery: Boolean(document.querySelector('[data-testid="local-service-recovery"]'))
      }
      const previous = samples.at(-1)
      if (
        !previous ||
        previous.storageWarning !== sample.storageWarning ||
        previous.checkingStorage !== sample.checkingStorage ||
        previous.runtimeRecovery !== sample.runtimeRecovery
      )
        samples.push(sample)
    }
    const observer = new MutationObserver(capture)
    observer.observe(document.body, { subtree: true, childList: true })
    capture()
    const states: Array<{ at: number; phase: string; epoch: number }> = []
    const removeState = window.api.desktopRuntime!.onStateChanged((state) => {
      states.push({ at: Date.now(), phase: state.phase, epoch: state.epoch })
    })
    Reflect.set(globalThis, 'storageWarningObservations', {
      samples,
      observer,
      states,
      removeState
    })
  })
  await application.evaluate((_electron, marker) => {
    type Pipe = {
      readable?: boolean
      writable?: boolean
      _handle?: { constructor: { name: string } }
      [key: symbol]: unknown
      emit(event: string, ...args: unknown[]): boolean
      destroy(): void
    }
    const pipe = (process as NodeJS.Process & { _getActiveHandles(): Pipe[] })
      ._getActiveHandles()
      .find(
        (handle) =>
          handle.readable &&
          handle.writable &&
          handle._handle?.constructor.name === 'Pipe' &&
          Object.getOwnPropertySymbols(handle).some((key) => {
            const owner = handle[key] as
              { _socket?: Pipe; url?: string; readyState?: number } | undefined
            return (
              owner?._socket === handle &&
              owner.url === 'ws://localhost/desktop' &&
              owner.readyState === 1
            )
          })
      )
    if (!pipe) throw new Error('Verified Desktop runtime pipe missing.')
    const originalEmit = pipe.emit
    Reflect.set(globalThis, 'restoreStorageWarningRepro', () => {
      pipe.emit = originalEmit
    })
    pipe.emit = function (event, ...args): boolean {
      if (event === 'data' && Buffer.isBuffer(args[0]) && args[0].includes(Buffer.from(marker))) {
        pipe.emit = originalEmit
        Reflect.set(globalThis, 'storageWarningPipeCut', true)
        pipe.destroy()
        return true
      }
      return originalEmit.call(this, event, ...args)
    }
  }, backgroundId)
  await togglePin(page, 'Pin')
  await expect
    .poll(() => application.evaluate(() => Reflect.get(globalThis, 'storageWarningPipeCut')))
    .toBe(true)
  const alert = page.getByTestId('session-persistence-alert')
  if (recoveryStateDelayMs > 0) {
    await expect(alert).toContainText('Checking conversation storage…')
    await expect(alert.getByTestId('session-persistence-retry')).toHaveCount(0)
    await expect(sessionRow(page, mainTitle)).toHaveAttribute('aria-current', 'page')
    await page.screenshot({ path: testInfo.outputPath('pipe-loss-storage-warning-visible.png') })
  }
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.api.desktopRuntime!.getState())
        return { phase: state.phase, epochChanged: state.epoch > before.epoch }
      },
      { timeout: 30_000 }
    )
    .toEqual({ phase: 'connected', epochChanged: true })
  await expect(page.getByTestId('local-service-recovery')).toHaveCount(0)
  await expect(alert).toHaveCount(0)
  const warningVisibleAfterRuntimeRecovery = (await alert.count()) > 0
  const after = await page.evaluate(() => window.api.desktopRuntime!.getState())
  expect(after.epoch).toBeGreaterThan(before.epoch)
  const persisted = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: backgroundId
  })
  expect(persisted?.pinned).toBe(true)
  expect(persisted?.revision).toBe((savedBefore?.revision ?? 0) + 1)
  await expect
    .poll(() => persistenceErrors)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'desktop-runtime-disconnected',
          hasNonRendererStackFrame: false,
          messageKind: 'submitted-result-unknown'
        })
      ])
    )
  const mainOutcomes = await application.evaluate(() =>
    Reflect.get(globalThis, 'storageSaveOutcomeProbes')
  )
  expect(mainOutcomes).toEqual(
    expect.arrayContaining([
      { ok: false, code: 'desktop-runtime-disconnected', submittedResultUnknown: true }
    ])
  )
  const diagnostics = (await readFile(desktopLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        msg: 'desktop runtime disconnected',
        data: expect.objectContaining({ phase: 'connected', reason: 'transport-close' })
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          context: 'session-save',
          sessionWrite: expect.objectContaining({
            sessionId: backgroundId,
            projectId,
            code: 'desktop-runtime-disconnected',
            phase: 'result-unknown'
          })
        })
      })
    ])
  )
  const observations = await page.evaluate(() => {
    const observations = Reflect.get(globalThis, 'storageWarningObservations') as {
      samples: Array<{
        at: number
        storageWarning: boolean
        checkingStorage: boolean
        runtimeRecovery: boolean
      }>
      observer: MutationObserver
      states: Array<{ at: number; phase: string; epoch: number }>
      removeState: () => void
    }
    observations.observer.disconnect()
    observations.removeState()
    return { notices: observations.samples, recoveryStates: observations.states }
  })
  expect(observations.notices.some(({ storageWarning }) => storageWarning)).toBe(false)
  await page.screenshot({
    path: testInfo.outputPath(
      warningVisibleAfterRuntimeRecovery
        ? 'pipe-recovered-storage-warning-stale.png'
        : 'pipe-recovered-warning-cleared.png'
    )
  })
  await testInfo.attach('reproduction-result', {
    body: JSON.stringify({
      trigger: 'Real runtime pipe destroyed while its save acknowledgement was arriving',
      sessionId: backgroundId,
      activeSessionId: 'storage-warning-main',
      recoveryStateDelayMs,
      ...observations,
      runtimeRecoveredWithoutRetryOrDismiss: true,
      warningVisibleAfterRuntimeRecovery,
      runtimeEpochBefore: before.epoch,
      runtimeEpochAfter: after.epoch,
      durablePinned: persisted?.pinned,
      durableRevisionBefore: savedBefore?.revision,
      durableRevisionAfter: persisted?.revision,
      mainOutcomes,
      rendererErrors: persistenceErrors
    }),
    contentType: 'application/json'
  })
})

test('preserves size-limit classification across the real Electron preload boundary', async ({
  desktop: { application, page, backgroundId, persistenceErrors }
}, testInfo) => {
  await application.evaluate(({ ipcMain }, targetId) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
      string,
      (...args: unknown[]) => unknown
    >
    const original = handlers.get('sessions:save-session')
    if (!original) throw new Error('Session save handler missing.')
    handlers.set('sessions:save-session', async (...args) => {
      if ((args[1] as { id?: string })?.id === targetId)
        return {
          ok: false,
          error: {
            code: 'session-size-limit',
            message: 'Session exceeds the 268435456 byte persistence limit.'
          }
        }
      return original(...args)
    })
    Reflect.set(globalThis, 'restoreStorageWarningRepro', () =>
      handlers.set('sessions:save-session', original)
    )
  }, backgroundId)
  await togglePin(page, 'Pin')
  const alert = page.getByTestId('session-persistence-alert')
  await expect(alert).toContainText('Conversation storage limit reached')
  await expect(alert).toContainText('exceeded the 256 MiB storage limit')
  await expect(alert.getByTestId('session-persistence-retry')).toHaveCount(0)
  await expect(alert).toContainText(backgroundTitle)
  await expect
    .poll(() => persistenceErrors)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'session-size-limit',
          hasNonRendererStackFrame: false,
          messageKind: 'session-size-limit'
        })
      ])
    )
  await page.screenshot({ path: testInfo.outputPath('size-limit-classified.png') })
  await testInfo.attach('error-boundary-diagnosis', {
    body: JSON.stringify({
      injectedMainOutcomeCode: 'session-size-limit',
      rendererErrors: persistenceErrors,
      visibleTitle: 'Conversation storage limit reached',
      retryVisible: false,
      expectedSizeLimitTitle: 'Conversation storage limit reached'
    }),
    contentType: 'application/json'
  })
  await application.evaluate(() =>
    (Reflect.get(globalThis, 'restoreStorageWarningRepro') as () => void)()
  )
  await togglePin(page, 'Unpin')
  await expect(alert).toHaveCount(0)
})

for (const framework of ['claude-code', 'opencode', 'codex', 'codebuddy', 'pi'] as const) {
  test(`retains a not-submitted preference until explicit retry for ${framework} (common save path)`, async ({
    desktop: { application, page, projectId, backgroundId }
  }, testInfo) => {
    test.skip(
      Boolean(liveOpenCodeConfig),
      'The common-save matrix uses no model; live OpenCode has separate coverage.'
    )
    const before = await page.evaluate(
      async ({ projectId, backgroundId, framework }) => {
        const session = await window.api.sessions.loadOne({ projectId, sessionId: backgroundId })
        if (!session) throw new Error('Fixture Session missing.')
        return window.api.sessions.saveSession({ ...session, agentFrameworkId: framework })
      },
      { projectId, backgroundId, framework }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openProjectSession(page, 'Storage warning reproduction', mainTitle)
    await expect(sessionRow(page, mainTitle)).toHaveAttribute('aria-current', 'page')
    await application.evaluate(({ ipcMain }, sessionId) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get('sessions:save-session')!
      let rejected = false
      const submissions: Array<{ expectedRevision?: number }> = []
      handlers.set('sessions:save-session', async (...args) => {
        if ((args[1] as { id: string }).id !== sessionId) return original(...args)
        if (!rejected) {
          rejected = true
          return {
            ok: false,
            error: {
              code: 'desktop-runtime-not-submitted',
              message: 'The connection changed before the operation was submitted.'
            }
          }
        }
        submissions.push({
          expectedRevision: (args[2] as { expectedRevision?: number })?.expectedRevision
        })
        return original(...args)
      })
      Reflect.set(globalThis, 'storageRetrySubmissions', submissions)
      Reflect.set(globalThis, 'restoreStorageWarningRepro', () =>
        handlers.set('sessions:save-session', original)
      )
    }, backgroundId)
    await togglePin(page, 'Pin')
    const alert = page.getByTestId('session-persistence-alert')
    await expect(alert).toContainText('Some conversation changes could not be confirmed as saved.')
    await expect(alert).toContainText(backgroundTitle)
    await expect(sessionRow(page, mainTitle)).toHaveAttribute('aria-current', 'page')
    if (framework === 'claude-code') {
      // Exercise Main's real normal-quit handshake while the edit is retained in this renderer.
      await application.evaluate(({ app }) => app.quit())
      await expect(alert).toContainText('Quit was canceled')
      expect(application.process().exitCode).toBeNull()
      const confirmation = page.getByRole('alertdialog', { name: 'Saving is not finished' })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Stay', exact: true }).click()
      await expect(confirmation).not.toBeVisible()
      await expect
        .poll(() => page.evaluate(() => window.api.desktopRuntime!.getState()))
        .toMatchObject({ closing: false })
      await alert.getByTestId('session-persistence-dismiss').click()
      await expect(alert).toContainText(
        'Some conversation changes could not be confirmed as saved.'
      )
    }
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'storageRetrySubmissions'))
    ).toEqual([])
    const unconfirmed = await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: backgroundId
    })
    expect(Boolean(unconfirmed?.pinned)).toBe(false)
    await alert.getByTestId('session-persistence-retry').click()
    await expect(alert).toHaveCount(0)
    const saved = await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: backgroundId
    })
    expect(saved).toMatchObject({
      pinned: true,
      agentFrameworkId: framework,
      revision: (before.revision ?? 0) + 1
    })
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'storageRetrySubmissions'))
    ).toEqual([{ expectedRevision: before.revision }])
    await testInfo.attach('framework-common-save-result', {
      body: JSON.stringify({
        framework,
        modelExecuted: false,
        sessionId: backgroundId,
        retainedUntilManualRetry: true,
        durablePinned: saved?.pinned
      }),
      contentType: 'application/json'
    })
  })
}

test.describe('live OpenCode control', () => {
  test.skip(!liveOpenCodeConfig, 'Set OPEN_SCIENCE_E2E_LIVE_OPENCODE_CONFIG for live verification.')

  test('saves normal background turns and preferences without a storage warning', async ({
    desktop: { page, projectId, backgroundId, desktopLogPath }
  }, testInfo) => {
    test.setTimeout(180_000)
    await page.evaluate(() => {
      Reflect.set(globalThis, 'normalRunSawStorageWarning', false)
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="session-persistence-alert"]'))
          Reflect.set(globalThis, 'normalRunSawStorageWarning', true)
      })
      observer.observe(document.body, { subtree: true, childList: true })
      Reflect.set(globalThis, 'normalRunWarningObserver', observer)
    })
    const rounds: Array<{ marker: string; activeDuringPreferenceChange: boolean }> = []
    for (const index of [1, 2]) {
      const marker = `STORAGE_REPRO_ROUND_${index}_OK`
      await sessionRow(page, backgroundTitle).click()
      await submitPromptViaUi(
        page,
        `Reply with exactly ${marker}. Do not use tools or read any files.`
      )
      await sessionRow(page, mainTitle).click()
      const activeDuringPreferenceChange = (
        await page.evaluate(() => window.api.storage.detectActive())
      ).some((session) => session.sessionId === backgroundId)
      await togglePin(page, index === 1 ? 'Pin' : 'Unpin')
      await expect
        .poll(
          () =>
            page.evaluate(
              async ({ projectId, sessionId, marker }) => {
                const saved = await window.api.sessions.loadOne({ projectId, sessionId })
                return (
                  saved?.status === 'idle' &&
                  saved.messages.some(
                    (message) =>
                      message.role === 'agent' &&
                      message.status === 'complete' &&
                      message.content.includes(marker)
                  )
                )
              },
              { projectId, sessionId: backgroundId, marker }
            ),
          { timeout: 90_000 }
        )
        .toBe(true)
      await expect(sessionRow(page, mainTitle)).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('session-persistence-alert')).toHaveCount(0)
      rounds.push({ marker, activeDuringPreferenceChange })
    }
    await expect.poll(() => page.evaluate(() => window.api.storage.detectActive())).toEqual([])
    await expect
      .poll(() =>
        page.evaluate(
          async (request) => Boolean((await window.api.sessions.loadOne(request))?.pinned),
          { projectId, sessionId: backgroundId }
        )
      )
      .toBe(false)
    const saved = await page.evaluate((request) => window.api.sessions.loadOne(request), {
      projectId,
      sessionId: backgroundId
    })
    expect(saved?.runtimeTranscriptOwner).toBe('main')
    expect(Boolean(saved?.pinned)).toBe(false)
    expect(
      saved?.messages.filter((message) => message.role === 'agent' && message.status === 'complete')
    ).toHaveLength(3)
    const sawStorageWarning = await page.evaluate(() => {
      const observer = Reflect.get(globalThis, 'normalRunWarningObserver') as MutationObserver
      observer.disconnect()
      return Reflect.get(globalThis, 'normalRunSawStorageWarning')
    })
    expect(sawStorageWarning).toBe(false)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openProjectSession(page, 'Storage warning reproduction', backgroundTitle)
    for (const { marker } of rounds)
      await expect(page.getByText(marker, { exact: true }).last()).toBeVisible()
    await expect(page.getByTestId('session-persistence-alert')).toHaveCount(0)
    // Log assertions also catch failures outside the observer's pre-reload lifetime.
    const diagnostics = (await readFile(desktopLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(diagnostics.filter((entry) => entry.data?.context === 'session-save')).toHaveLength(0)
    await page.screenshot({ path: testInfo.outputPath('normal-opencode-background-turns.png') })
    await testInfo.attach('normal-opencode-result', {
      body: JSON.stringify({
        framework: 'opencode',
        sessionId: backgroundId,
        completedAgentMessages: 3,
        storageWarningCount: 0,
        reloadPreservedReplies: true,
        rounds
      }),
      contentType: 'application/json'
    })
  })
})
