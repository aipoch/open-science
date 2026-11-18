import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { SETTINGS_FILE_VERSION } from '../src/shared/settings'
import { launchOpenScience } from './fixtures/electron-app'
import {
  measureClickToVisible,
  measureInputPresentation,
  startSessionFileWatch,
  startSessionUiProbe,
  stopSessionUiProbe
} from './fixtures/session-ui-performance'

type Input = {
  caseId: string
  variant: 'original-json' | 'current-legacy-json' | 'current-jsonl'
  repeat: number
  sourceRoot: string
  projectId: string
  sessionId: string
  outputRoot: string
}

const PROMPT = 'Run the official science UI storage stream.'
const FIRST = 'Official science UI stream begins.'
const LAST = 'Official science UI stream complete.'
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
test.use({ trace: 'off', video: 'off' })

// Deliberately opt in: normal E2E runs must not need downloaded official packages or benchmark
// artifacts. The coordinator supplies one immutable, retained ten-turn input per isolated run.
// eslint-disable-next-line no-empty-pattern -- Launch isolated Electron ourselves, not a browser fixture.
test('measures official history opening and live autosave responsiveness', async ({}, testInfo) => {
  test.skip(
    !process.env.OPEN_SCIENCE_UI_PERF_INPUT,
    'Requires a prepared official history manifest.'
  )
  test.setTimeout(180_000)
  const input = JSON.parse(await readFile(process.env.OPEN_SCIENCE_UI_PERF_INPUT!, 'utf8')) as Input
  expect(['original-json', 'current-legacy-json', 'current-jsonl']).toContain(input.variant)
  expect(resolve(input.outputRoot)).not.toBe(resolve(input.sourceRoot))
  const storageRoot = join(input.outputRoot, 'storage')
  const extension = input.variant === 'current-jsonl' ? 'jsonl' : 'json'
  const relativeSessionFile = join('sessions', input.projectId, `${input.sessionId}.${extension}`)
  const sourceBytes = await readFile(join(input.sourceRoot, relativeSessionFile))
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  await mkdir(input.outputRoot, { recursive: true })
  // Copy the real multi-record journal and its derived SQLite state, not a replacement snapshot.
  await cp(input.sourceRoot, storageRoot, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false
  })
  const roots = {
    storageRoot,
    userDataRoot: join(input.outputRoot, 'electron-profile'),
    fakeAgentBinRoot: join(input.outputRoot, 'fake-agent-bin'),
    fakeRemoteItRoot: join(input.outputRoot, 'unused-remoteit'),
    fakeRemoteItState: join(input.outputRoot, 'unused-remoteit.json')
  }
  await mkdir(roots.fakeAgentBinRoot, { recursive: true })
  const launcher = join(roots.fakeAgentBinRoot, 'opencode')
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolve('e2e/fixtures/fake-opencode.mjs'))} "$@"\n`
  )
  await chmod(launcher, 0o700)
  await writeFile(
    join(storageRoot, 'settings.json'),
    JSON.stringify({
      version: SETTINGS_FILE_VERSION,
      providers: [],
      onboardingCompletedAt: Date.now(),
      pathsNormalizedAt: Date.now(),
      dataRoot: storageRoot,
      localePreference: 'en',
      agentFrameworkId: 'opencode',
      opencodePath: launcher,
      opencodeVersion: '1.0.0',
      sessionDetailsModel: { mode: 'disabled' },
      notificationsEnabled: false
    })
  )
  const identity = { projectId: input.projectId, sessionId: input.sessionId }
  const rendererErrors: string[] = []
  const stderr: string[] = []
  let application: ElectronApplication | undefined
  let page: Page | undefined
  let openingTargetSelector: string | undefined
  let fileWatch: ReturnType<typeof startSessionFileWatch> | undefined
  const launch = async (): Promise<Page> => {
    application = await launchOpenScience(roots, true, false, '', 'normal', false)
    application.process().stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    page = await application.firstWindow()
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
    await expect
      .poll(() => page!.evaluate(() => window.api.databaseStartup.getState()))
      .toMatchObject({ phase: 'ready' })
    await page.getByTestId('settings-startup-loading').waitFor({ state: 'hidden' })
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1280, 900)
      window.webContents.setZoomFactor(1)
      window.show()
      window.focus()
    })
    await page.bringToFront()
    return page
  }
  const close = async (): Promise<void> => {
    if (!application) return
    await application.close()
    application = undefined
  }
  let result: Record<string, unknown> = {
    input,
    status: 'preparing',
    sourceSha256,
    completionObservationPolicy:
      'Sample until button[aria-label="Cancel run"] is absent (DOM polling every 100 ms, 30 s timeout), then wait two requestAnimationFrame callbacks. Stop the probe before asserting final text visibility and Cancel run count; complete response and history integrity checks remain outside sampling.'
  }
  try {
    page = await launch()
    const migration = page.getByRole('alertdialog', {
      name: 'Move your data to a visible folder?'
    })
    await expect(migration).toBeVisible()
    await migration
      .getByRole('button', { name: 'Keep it in the current folder', exact: true })
      .click()
    await expect(migration).toBeHidden()
    await expect
      .poll(async () => {
        const settings = JSON.parse(await readFile(join(storageRoot, 'settings.json'), 'utf8'))
        return typeof settings.legacyDataMovePromptDismissedAt
      })
      .toBe('number')
    expect((await page.evaluate(() => window.api.storage.getInfo())).legacyDataMovePrompt).toBe(
      false
    )
    await page.evaluate(async () => {
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Official history UI fixture',
        apiEndpoints: ['chat-completions'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'e2e-model',
        key: 'e2e-key',
        supportsImageInput: true
      })
      const provider = snapshot.providers.find(
        (candidate) => candidate.name === 'Official history UI fixture'
      )
      if (!provider) throw new Error('Fake provider was not persisted.')
      await window.api.settings.setActiveProvider({ id: provider.id, model: 'e2e-model' })
      await window.api.settings.setAgentFramework({ id: 'opencode' })
    })
    const before = await page.evaluate((request) => window.api.sessions.loadOne(request), identity)
    expect(before).not.toBeNull()
    const historical = before as PersistedChatSession
    expect(historical.messages.filter((message) => message.role === 'user')).toHaveLength(10)
    expect(historical.cwd.startsWith(storageRoot)).toBe(true)
    expect(historical.agentConfiguration).toBeUndefined()
    // A copied journal has a new inode/path. Rebuild through the real API outside measurement,
    // then restart so opening has no in-memory session cache, with the same warm OS cache policy.
    const preparationRead = await page.evaluate(async (request) => {
      const started = performance.now()
      const pageApi = window.api.sessions.loadHistoryPage
      const loaded =
        typeof pageApi === 'function'
          ? await pageApi(request)
          : await window.api.sessions.loadOne(request)
      return {
        durationMs: performance.now() - started,
        usedPageApi: typeof pageApi === 'function',
        present: Boolean(loaded)
      }
    }, identity)
    expect(preparationRead.present).toBe(true)
    result = { ...result, preparationRead }
    await close()
    page = await launch()
    expect((await page.evaluate(() => window.api.storage.getInfo())).legacyDataMovePrompt).toBe(
      false
    )
    await expect(
      page.getByRole('alertdialog', { name: 'Move your data to a visible folder?' })
    ).toBeHidden()
    const recent = page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button')
      .filter({ hasText: historical.title })
    await expect(recent).toHaveCount(1)
    await expect(recent).toBeVisible()
    const latestQuestion = historical.messages.findLast((message) => message.role === 'user')!
    const messageSelector = `[data-message-id="${latestQuestion.id}"]`
    openingTargetSelector = `${messageSelector} [data-slot="user-message-content"]`
    result = {
      ...result,
      openingTarget: {
        messageId: latestQuestion.id,
        role: latestQuestion.role,
        selector: openingTargetSelector
      }
    }
    await expect(page.locator(messageSelector)).toHaveCount(0)
    const opening = await measureClickToVisible(page, recent, {
      selector: openingTargetSelector,
      text: latestQuestion.content,
      timeoutMs: 30_000
    })
    result = { ...result, opening }
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      visible: document.visibilityState,
      focused: document.hasFocus()
    }))
    expect(viewport.visible).toBe('visible')
    expect(viewport.focused).toBe(true)
    await page.screenshot({ path: join(input.outputRoot, 'opened.png') })
    const composer = page.getByRole('textbox', { name: 'Ask anything' })
    await expect(composer).toBeVisible()
    await startSessionUiProbe(page, { sessionId: input.sessionId, label: 'idle-reference' })
    await page.waitForTimeout(3000)
    const idle = await stopSessionUiProbe(page)
    expect(idle.invalidReasons).toEqual([])
    await composer.fill(PROMPT)
    fileWatch = startSessionFileWatch({
      directory: join(storageRoot, 'sessions', input.projectId),
      sessionId: input.sessionId
    })
    await startSessionUiProbe(page, {
      sessionId: input.sessionId,
      label: 'send-and-stream-and-natural-autosave'
    })
    const sendToFirstChunk = await measureClickToVisible(
      page,
      page.getByRole('button', { name: 'Send message', exact: true }),
      { selector: '[data-message-id] p', text: FIRST, timeoutMs: 30_000 }
    )
    expect(sendToFirstChunk.trustedClick).toBe(true)
    result = { ...result, sendToFirstChunk }
    const inputSamples: Awaited<ReturnType<typeof measureInputPresentation>>[] = []
    for (let index = 0; index < 3; index += 1) {
      await page.waitForTimeout(3500)
      inputSamples.push(
        await measureInputPresentation(page, composer, ` draft${index}`, { delayMs: 50 })
      )
    }
    // Locator assertions can build a full accessibility snapshot while retrying. Keep that
    // diagnostic work outside the measured stream, without dropping the completion assertions.
    await page.waitForFunction(
      () => document.querySelector('button[aria-label="Cancel run"]') === null,
      undefined,
      { timeout: 30_000, polling: 100 }
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    const streaming = await stopSessionUiProbe(page)
    const sessionFileWrites = await fileWatch.stop()
    fileWatch = undefined
    result = { ...result, idle, streaming, inputSamples, sessionFileWrites }
    await expect(page.getByText(LAST, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
    expect(streaming.invalidReasons).toEqual([])
    expect(sessionFileWrites.errors).toEqual([])
    expect(sessionFileWrites.events.some(({ kind }) => kind === 'primary')).toBe(true)
    expect(
      new Set(streaming.committedRevisions.map(({ revision }) => revision)).size
    ).toBeGreaterThanOrEqual(3)
    const duringReplyCommits = streaming.committedRevisions.filter(
      ({ originClientId, receivedAt }) =>
        originClientId === 'main:runtime-transcript' &&
        receivedAt >= sendToFirstChunk.presentationOpportunityAt &&
        receivedAt <= streaming.endedAt
    )
    expect(new Set(duringReplyCommits.map(({ revision }) => revision)).size).toBeGreaterThanOrEqual(
      3
    )
    expect(
      duringReplyCommits.at(-1)!.receivedAt - duringReplyCommits[0].receivedAt
    ).toBeGreaterThanOrEqual(4000)
    expect(inputSamples.flat()).toHaveLength(21)
    expect(inputSamples.flat().every(({ trusted }) => trusted)).toBe(true)
    expect(inputSamples.flat().every(({ domValueObserved }) => domValueObserved)).toBe(true)
    await composer.fill('')
    await page.screenshot({ path: join(input.outputRoot, 'stream-complete.png') })
    // Full-history reads and hashes happen only after all UI timings and natural autosaves.
    await expect
      .poll(async () => {
        const saved = await page!.evaluate(
          (request) => window.api.sessions.loadOne(request),
          identity
        )
        return (
          saved?.status === 'idle' &&
          saved.messages.some((message) => message.content.endsWith(`${LAST}\n`))
        )
      })
      .toBe(true)
    const after = (await page.evaluate(
      (request) => window.api.sessions.loadOne(request),
      identity
    )) as PersistedChatSession
    expect(after.messages.slice(0, historical.messages.length)).toEqual(historical.messages)
    expect(after.activities).toEqual(historical.activities)
    expect(after.artifacts).toEqual(historical.artifacts)
    for (const key of ['messages', 'activities', 'activityGroups'] as const) {
      const retained = new Map(after.conversationGraph?.[key].map((item) => [item.id, item]))
      for (const item of historical.conversationGraph?.[key] ?? [])
        expect(retained.get(item.id)).toEqual(item)
    }
    const response = after.messages.find((message) => message.content.startsWith(FIRST))!
    expect(response).toBeTruthy()
    expect(Buffer.byteLength(response.content)).toBe(32_768)
    expect(response.status).toBe('complete')
    expect(after.messages.filter((message) => message.role === 'user')).toHaveLength(11)
    expect(rendererErrors).toEqual([])
    result = {
      ...result,
      status: 'complete',
      preparationRead,
      viewport,
      opening,
      idle,
      sendToFirstChunk,
      streaming,
      inputSamples,
      sessionFileWrites,
      verification: {
        historicalMessages: historical.messages.length,
        historicalActivities: historical.activities?.length ?? 0,
        historicalMessagesSha256: digest(historical.messages),
        historicalActivitiesSha256: digest(historical.activities),
        historicalGraphMessagesSha256: digest(historical.conversationGraph?.messages),
        historicalGraphActivitiesSha256: digest(historical.conversationGraph?.activities),
        historicalGraphFrames: historical.conversationGraph?.frames.length,
        historicalGraphBranches: historical.conversationGraph?.branches.length,
        initialRevision: historical.revision,
        finalMessages: after.messages.length,
        finalRevision: after.revision,
        responseBytes: Buffer.byteLength(response.content),
        responseSha256: createHash('sha256').update(response.content).digest('hex'),
        historyUnchanged: true,
        pendingHistoryReplayPreservedDuringSetup: historical.pendingHistoryReplay,
        runtimeContextResetPreservedDuringSetup: historical.branchContextResetRequired,
        sourceUnchanged:
          createHash('sha256')
            .update(await readFile(join(input.sourceRoot, relativeSessionFile)))
            .digest('hex') === sourceSha256
      }
    }
    expect((result.verification as { sourceUnchanged: boolean }).sourceUnchanged).toBe(true)
  } catch (error) {
    result = { ...result, status: 'failed', error: String(error) }
    if (page && !page.isClosed() && openingTargetSelector)
      result.openingTargetDiagnostics = await page
        .evaluate(
          (selector) =>
            [...document.querySelectorAll(selector)].map((element) => ({
              messageId: element.closest('[data-message-id]')?.getAttribute('data-message-id'),
              rect: element.getBoundingClientRect().toJSON(),
              textLength: element.textContent?.length ?? 0,
              visible: element.checkVisibility({
                contentVisibilityAuto: true,
                checkOpacity: true,
                checkVisibilityCSS: true
              })
            })),
          openingTargetSelector
        )
        .catch(() => undefined)
    if (page && !page.isClosed())
      await page.screenshot({ path: join(input.outputRoot, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    if (fileWatch) await fileWatch.stop()
    await writeFile(
      join(input.outputRoot, 'result.json'),
      JSON.stringify({ ...result, rendererErrors }, null, 2)
    )
    await writeFile(join(input.outputRoot, 'electron.stderr.log'), stderr.join(''))
    await testInfo.attach('official-ui-result', {
      path: join(input.outputRoot, 'result.json'),
      contentType: 'application/json'
    })
    await close()
  }
})
