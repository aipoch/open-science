import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CDPSession, ElectronApplication, Locator, Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { SETTINGS_FILE_VERSION } from '../src/shared/settings'
import { launchOpenScience } from './fixtures/electron-app'
import { assertSessionUiForeground } from './fixtures/session-ui-performance'

type Input = {
  caseId: string
  variant: 'original-json' | 'current-legacy-json' | 'current-jsonl'
  repeat: number
  sourceRoot: string
  projectId: string
  sessionId: string
  outputRoot: string
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
test.use({ trace: 'off', video: 'off' })

// Deliberately opt in: normal E2E runs must not need downloaded official packages or benchmark
// artifacts. The coordinator supplies one immutable, retained ten-turn input per isolated run.
// eslint-disable-next-line no-empty-pattern -- Launch isolated Electron ourselves, not a browser fixture.
test('diagnoses official history opening with renderer trace', async ({}, testInfo) => {
  test.skip(
    !process.env.OPEN_SCIENCE_UI_PERF_INPUT,
    'Requires a prepared official history manifest.'
  )
  test.setTimeout(180_000)
  const traceEnabled = process.env.OPEN_SCIENCE_UI_DIAG_TRACE !== '0'
  const hideHistoryLoadRows = process.env.OPEN_SCIENCE_UI_DIAG_HIDE_HISTORY === '1'
  const preloadWorkspace = process.env.OPEN_SCIENCE_UI_DIAG_PRELOAD_WORKSPACE === '1'
  const settleMs = Number(process.env.OPEN_SCIENCE_UI_DIAG_SETTLE_MS ?? '0')
  if (!Number.isFinite(settleMs) || settleMs < 0 || settleMs > 10_000)
    throw new Error('OPEN_SCIENCE_UI_DIAG_SETTLE_MS must be between 0 and 10000.')
  const historyExperimentCss = '[data-message-id^="history-load-"]{display:none!important}'
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
  let tracing: CDPSession | undefined
  let traceStarted = false
  let profilerStarted = false
  let probesInstalled = false
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
    diagnosticOnly: true,
    experiment: {
      traceEnabled,
      hideHistoryLoadRows,
      injectedCss: hideHistoryLoadRows ? historyExperimentCss : null,
      artificialLayoutChange: hideHistoryLoadRows,
      preloadWorkspace,
      workspacePreload: null,
      settleMs,
      preloadScope: preloadWorkspace
        ? 'Render bundle preloaded only; artificial diagnostic setup, not a user-path result.'
        : null
    },
    instrumentation: `${traceEnabled ? 'CDP trace + CPU sampling + ' : ''}IPC wrappers + visibility-check timing; diagnostic only, do not combine with the formal benchmark.`
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
    // Diagnostic A/B only: deliberately remove this row's layout without changing product code.
    if (hideHistoryLoadRows) await page.addStyleTag({ content: historyExperimentCss })
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
    if (preloadWorkspace) {
      const workspaceModules = (await readdir(resolve('out/renderer/assets'))).filter((name) =>
        /^WorkspacePage-[^/]+\.js$/.test(name)
      )
      expect(workspaceModules).toHaveLength(1)
      const workspacePreload = await page.evaluate(async (filename) => {
        const moduleUrl = new URL(`./assets/${filename}`, document.baseURI).href
        const startedAt = performance.now()
        // Only evaluate the actual built module. Do not mount it or call a session-loading API.
        await import(moduleUrl)
        const endedAt = performance.now()
        return {
          moduleUrl,
          timeOrigin: performance.timeOrigin,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt
        }
      }, workspaceModules[0])
      result.experiment = { ...(result.experiment as Record<string, unknown>), workspacePreload }
      await expect(page.locator(messageSelector)).toHaveCount(0)
    }
    // The paired control and preload runs receive the same explicit settling duration.
    if (settleMs > 0) await page.waitForTimeout(settleMs)
    await assertSessionUiForeground(page)
    const mainProbe = await installMainProbe(application!)
    const rendererProbe = await installRendererProbe(page)
    probesInstalled = true
    result = { ...result, mainProbe, rendererProbe }
    if (traceEnabled) {
      tracing = await page.context().newCDPSession(page)
      await tracing.send('Profiler.enable')
      await tracing.send('Profiler.setSamplingInterval', { interval: 1000 })
      await tracing.send('Profiler.start')
      profilerStarted = true
      await tracing.send('Tracing.start', {
        categories:
          'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-v8.cpu_profiler',
        transferMode: 'ReturnAsStream',
        options: 'record-as-much-as-possible'
      })
      traceStarted = true
    }
    await page.evaluate(() => performance.mark('os-opening:armed'))
    const opening = await diagnoseClickToVisible(page, recent, {
      selector: openingTargetSelector,
      text: latestQuestion.content
    })
    result = { ...result, opening }
    // Include the immediately following render work, outside the opening endpoint.
    await page.waitForTimeout(250)
    await page.evaluate(() => performance.mark('os-opening:capture-end'))
    if (tracing) {
      await stopTrace(tracing, join(input.outputRoot, 'trace.json'))
      traceStarted = false
      const profile = await tracing.send('Profiler.stop')
      profilerStarted = false
      await writeFile(join(input.outputRoot, 'cpu-profile.json'), JSON.stringify(profile.profile))
    }
    // Stop instrumentation first, then count serialized response bytes. No payload walk or
    // JSON.stringify occurs during the click / visible-content interval.
    const rendererTimeline = await page.evaluate(() =>
      Reflect.get(window, '__osOpeningRendererProbe').stop()
    )
    const mainTimeline = await application!.evaluate(() =>
      Reflect.get(globalThis, '__osOpeningMainProbe').stop()
    )
    probesInstalled = false
    await writeFile(
      join(input.outputRoot, 'calls-timeline.json'),
      JSON.stringify({ renderer: rendererTimeline, main: mainTimeline }, null, 2)
    )
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      visible: document.visibilityState,
      focused: document.hasFocus()
    }))
    await assertSessionUiForeground(page)
    await page.screenshot({ path: join(input.outputRoot, 'opened.png') })
    const sourceUnchanged =
      createHash('sha256')
        .update(await readFile(join(input.sourceRoot, relativeSessionFile)))
        .digest('hex') === sourceSha256
    expect(sourceUnchanged).toBe(true)
    expect(rendererErrors).toEqual([])
    result = {
      ...result,
      status: 'complete',
      viewport,
      sourceUnchanged,
      mainTimeline,
      rendererTimeline
    }
  } catch (error) {
    result = { ...result, status: 'failed', error: String(error) }
    if (page && !page.isClosed())
      await page.screenshot({ path: join(input.outputRoot, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    if (tracing && traceStarted)
      await stopTrace(tracing, join(input.outputRoot, 'trace.json')).catch((error) => {
        result.traceError = String(error)
      })
    if (tracing && profilerStarted)
      await tracing
        .send('Profiler.stop')
        .then((profile) =>
          writeFile(join(input.outputRoot, 'cpu-profile.json'), JSON.stringify(profile.profile))
        )
        .catch((error) => {
          result.profileError = String(error)
        })
    if (probesInstalled) {
      const rendererTimeline = await page
        ?.evaluate(() => Reflect.get(window, '__osOpeningRendererProbe')?.stop())
        .catch(() => undefined)
      const mainTimeline = await application
        ?.evaluate(() => Reflect.get(globalThis, '__osOpeningMainProbe')?.stop())
        .catch(() => undefined)
      await writeFile(
        join(input.outputRoot, 'calls-timeline.json'),
        JSON.stringify({ renderer: rendererTimeline, main: mainTimeline }, null, 2)
      )
    }
    await tracing?.detach().catch(() => undefined)
    await writeFile(
      join(input.outputRoot, 'result.json'),
      JSON.stringify({ ...result, rendererErrors }, null, 2)
    )
    await writeFile(join(input.outputRoot, 'electron.stderr.log'), stderr.join(''))
    await testInfo.attach('official-ui-opening-diagnosis', {
      path: join(input.outputRoot, 'result.json'),
      contentType: 'application/json'
    })
    await close()
  }
})

async function stopTrace(cdp: CDPSession, path: string): Promise<void> {
  const completed = new Promise<{ stream?: string }>((resolve) =>
    cdp.once('Tracing.tracingComplete', resolve)
  )
  await cdp.send('Tracing.end')
  const { stream } = await completed
  if (!stream) throw new Error('Renderer trace did not return a stream.')
  const chunks: Buffer[] = []
  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream })
      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))
      if (chunk.eof) break
    }
    await writeFile(path, Buffer.concat(chunks))
  } finally {
    await cdp.send('IO.close', { handle: stream })
  }
}

async function installMainProbe(application: ElectronApplication): Promise<unknown> {
  return application.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    type Call = {
      id: number
      channel: string
      startTime: number
      endTime?: number
      error?: string
      response?: unknown
    }
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>
    if (!(handlers instanceof Map)) throw new Error('Native IPC handler map is unavailable.')
    const installed: Array<{ channel: string; original: Handler; wrapped: Handler }> = []
    const calls: Call[] = []
    const timeOrigin = performance.timeOrigin
    for (const [channel, original] of handlers) {
      const wrapped: Handler = async function (this: unknown, ...args) {
        const call: Call = { id: calls.length, channel, startTime: performance.now() }
        calls.push(call)
        try {
          const response = await Reflect.apply(original, this, args)
          call.endTime = performance.now()
          call.response = response
          return response
        } catch (error) {
          call.endTime = performance.now()
          call.error = String(error)
          throw error
        }
      }
      handlers.set(channel, wrapped)
      installed.push({ channel, original, wrapped })
    }
    Reflect.set(globalThis, '__osOpeningMainProbe', {
      stop() {
        for (const { channel, original, wrapped } of installed)
          if (handlers.get(channel) === wrapped) handlers.set(channel, original)
        const result = calls.map(({ response, ...call }) => {
          let responseJsonBytes: number | undefined
          let sizeError: string | undefined
          try {
            const json = JSON.stringify(response)
            responseJsonBytes = json === undefined ? 0 : Buffer.byteLength(json)
          } catch (error) {
            sizeError = String(error)
          }
          const object = response && typeof response === 'object' ? response : undefined
          const candidate = object && (Reflect.get(object, 'session') ?? object)
          const session = candidate && typeof candidate === 'object' ? candidate : undefined
          const messages = session && Reflect.get(session, 'messages')
          const activities = session && Reflect.get(session, 'activities')
          return {
            ...call,
            durationMs: call.endTime === undefined ? undefined : call.endTime - call.startTime,
            responseJsonBytes,
            sizeError,
            messageCount: Array.isArray(messages) ? messages.length : undefined,
            activityCount: Array.isArray(activities) ? activities.length : undefined,
            complete: object ? Reflect.get(object, 'complete') : undefined,
            hasMore: object ? Reflect.get(object, 'hasMore') : undefined
          }
        })
        calls.length = 0
        Reflect.deleteProperty(globalThis, '__osOpeningMainProbe')
        return {
          timeOrigin,
          scope:
            'Electron main IPC handler invocation; excludes renderer dispatch/serialization and frontend render; response sizes calculated after capture',
          calls: result
        }
      }
    })
    return {
      handlerCount: installed.length,
      channels: installed.map(({ channel }) => channel),
      timeOrigin
    }
  })
}

async function installRendererProbe(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    type Call = {
      method: string
      startTime: number
      endTime?: number
      error?: string
      response?: unknown
    }
    const calls: Call[] = []
    const entries: unknown[] = []
    const supported = PerformanceObserver.supportedEntryTypes
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push(entry.toJSON())
    })
    observer.observe({
      entryTypes: ['longtask', 'resource', 'mark', 'measure'].filter((type) =>
        supported.includes(type)
      )
    })
    const api = window.api.sessions
    const descriptors: Array<{
      method: string
      writable: boolean
      configurable: boolean
      wrapped: boolean
    }> = []
    const originals: Array<{
      method: string
      original: (...args: unknown[]) => unknown
      wrapped: (...args: unknown[]) => unknown
    }> = []
    for (const method of Object.keys(api).filter((method) => /^(load|get|list)/.test(method))) {
      const descriptor = Object.getOwnPropertyDescriptor(api, method)
      const original = Reflect.get(api, method)
      const writable = descriptor?.writable === true && typeof original === 'function'
      const metadata = {
        method,
        writable,
        configurable: descriptor?.configurable === true,
        wrapped: false
      }
      descriptors.push(metadata)
      if (!writable) continue
      const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
        const call: Call = { method, startTime: performance.now() }
        calls.push(call)
        try {
          const response = await Reflect.apply(original, this, args)
          call.endTime = performance.now()
          call.response = response
          return response
        } catch (error) {
          call.endTime = performance.now()
          call.error = String(error)
          throw error
        }
      }
      if (Reflect.set(api, method, wrapped)) {
        originals.push({ method, original, wrapped })
        metadata.wrapped = true
      }
    }
    const pointerdown = (): void => {
      performance.mark('os-opening:pointerdown-handler')
    }
    const click = (): void => {
      performance.mark('os-opening:click-handler')
    }
    window.addEventListener('pointerdown', pointerdown, { capture: true, once: true })
    window.addEventListener('click', click, { capture: true, once: true })
    Reflect.set(window, '__osOpeningRendererProbe', {
      stop() {
        for (const entry of observer.takeRecords()) entries.push(entry.toJSON())
        observer.disconnect()
        for (const { method, original, wrapped } of originals)
          if (Reflect.get(api, method) === wrapped) Reflect.set(api, method, original)
        window.removeEventListener('pointerdown', pointerdown, true)
        window.removeEventListener('click', click, true)
        const result = calls.map(({ response, ...call }) => {
          let responseJsonBytes: number | undefined
          let sizeError: string | undefined
          try {
            const json = JSON.stringify(response)
            responseJsonBytes = json === undefined ? 0 : new TextEncoder().encode(json).byteLength
          } catch (error) {
            sizeError = String(error)
          }
          return {
            ...call,
            durationMs: call.endTime === undefined ? undefined : call.endTime - call.startTime,
            responseJsonBytes,
            sizeError
          }
        })
        calls.length = 0
        Reflect.deleteProperty(window, '__osOpeningRendererProbe')
        return {
          timeOrigin: performance.timeOrigin,
          descriptors,
          supported,
          entries,
          calls: result,
          scope: originals.length
            ? 'Writable renderer APIs measured end to end; other APIs unavailable'
            : 'ContextBridge API immutable; no renderer API wrapping. Use main handler durations and renderer trace separately.'
        }
      }
    })
    return { descriptors, supported, timeOrigin: performance.timeOrigin }
  })
}

// Copy the formal visibility predicate, but separate its own forced-layout work from the frame
// callback entry and the first visible observation. This diagnostic never updates formal results.
async function diagnoseClickToVisible(
  page: Page,
  trigger: Locator,
  target: { selector: string; text: string }
): Promise<unknown> {
  await trigger.evaluate((element, target) => {
    type Rect = { left: number; top: number; right: number; bottom: number }
    type Check = {
      id: number
      phase: 'observe' | 'final'
      startTime: number
      endTime?: number
      visible: boolean
      rect?: Rect
      intersection?: Rect
      candidateCount: number
      ancestorCount: number
    }
    const state = {
      timeOrigin: performance.timeOrigin,
      pointerDownAt: undefined as number | undefined,
      clickEventAt: undefined as number | undefined,
      clickHandlerAt: undefined as number | undefined,
      firstDomAt: undefined as number | undefined,
      firstSeenAt: undefined as number | undefined,
      lastSeenAt: undefined as number | undefined,
      checks: [] as Check[],
      frameCallbacks: [] as Array<{
        phase: 'observe' | 'first-after-visible' | 'second-after-visible'
        enteredAt: number
      }>,
      retryCount: 0,
      done: false,
      error: '',
      secondRafEnteredAt: undefined as number | undefined,
      finalCheckEndedAt: undefined as number | undefined,
      trusted: false
    }
    Reflect.set(window, '__osOpeningVisibility', state)
    const visibleContent = (phase: 'observe' | 'final'): boolean => {
      const check: Check = {
        id: state.checks.length,
        phase,
        startTime: performance.now(),
        visible: false,
        candidateCount: 0,
        ancestorCount: 0
      }
      state.checks.push(check)
      performance.mark(`os-opening:visibility-${check.id}:start`)
      try {
        for (const content of document.querySelectorAll(target.selector)) {
          state.firstDomAt ??= performance.now()
          check.candidateCount++
          if (target.text && !content.textContent?.includes(target.text)) continue
          if (
            !content.checkVisibility({
              contentVisibilityAuto: true,
              opacityProperty: true,
              visibilityProperty: true
            })
          )
            continue
          const rect = content.getBoundingClientRect()
          check.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          let left = Math.max(rect.left, 0)
          let right = Math.min(rect.right, innerWidth)
          let top = Math.max(rect.top, 0)
          let bottom = Math.min(rect.bottom, innerHeight)
          for (let parent = content.parentElement; parent; parent = parent.parentElement) {
            check.ancestorCount++
            const style = getComputedStyle(parent)
            const parentRect = parent.getBoundingClientRect()
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
              left = Math.max(left, parentRect.left + parent.clientLeft)
              right = Math.min(right, parentRect.left + parent.clientLeft + parent.clientWidth)
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
              top = Math.max(top, parentRect.top + parent.clientTop)
              bottom = Math.min(bottom, parentRect.top + parent.clientTop + parent.clientHeight)
            }
          }
          check.intersection = { left, top, right, bottom }
          if (right <= left || bottom <= top) continue
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
          if (hit && (hit === content || content.contains(hit))) {
            check.visible = true
            return true
          }
        }
        return false
      } finally {
        check.endTime = performance.now()
        performance.mark(`os-opening:visibility-${check.id}:end`)
      }
    }
    element.addEventListener(
      'pointerdown',
      (event) => {
        state.pointerDownAt = event.timeStamp
      },
      { capture: true, once: true }
    )
    element.addEventListener(
      'click',
      (event) => {
        state.clickEventAt = event.timeStamp
        state.clickHandlerAt = performance.now()
        state.trusted = event.isTrusted
        const deadline = state.clickHandlerAt + 30_000
        const foreground = (): boolean => {
          if (document.visibilityState === 'visible' && document.hasFocus()) return true
          state.error = 'Window lost foreground during opening diagnosis.'
          return false
        }
        const observe = (): void => {
          state.frameCallbacks.push({ phase: 'observe', enteredAt: performance.now() })
          if (!foreground()) return
          if (visibleContent('observe')) {
            const seenAt = performance.now()
            state.firstSeenAt ??= seenAt
            state.lastSeenAt = seenAt
            requestAnimationFrame(() => {
              state.frameCallbacks.push({
                phase: 'first-after-visible',
                enteredAt: performance.now()
              })
              requestAnimationFrame(() => {
                const enteredAt = performance.now()
                state.frameCallbacks.push({ phase: 'second-after-visible', enteredAt })
                if (!foreground()) return
                if (!visibleContent('final')) {
                  state.retryCount++
                  if (performance.now() >= deadline)
                    state.error = 'Final visibility kept failing until timeout.'
                  else observe()
                  return
                }
                state.secondRafEnteredAt = enteredAt
                state.finalCheckEndedAt = performance.now()
                performance.mark('os-opening:final-visible-confirmed')
                state.done = true
              })
            })
          } else if (performance.now() >= deadline) state.error = 'Visible content timed out.'
          else requestAnimationFrame(observe)
        }
        requestAnimationFrame(observe)
      },
      { capture: true, once: true }
    )
  }, target)
  await trigger.click()
  await page.waitForFunction(
    () => {
      const state = Reflect.get(window, '__osOpeningVisibility')
      return state.done || state.error
    },
    undefined,
    { timeout: 35_000, polling: 100 }
  )
  return page.evaluate(() => {
    const state = Reflect.get(window, '__osOpeningVisibility')
    if (state.error) throw new Error(state.error)
    if (state.pointerDownAt === undefined || !state.trusted)
      throw new Error('Missing trusted pointer click.')
    return {
      ...state,
      pointerToFirstDomMs: state.firstDomAt - state.pointerDownAt,
      pointerToFirstSeenMs: state.firstSeenAt - state.pointerDownAt,
      pointerToSecondRafEntryMs: state.secondRafEnteredAt - state.pointerDownAt,
      pointerToFinalCheckEndMs: state.finalCheckEndedAt - state.pointerDownAt,
      finalCheckCostMs: state.finalCheckEndedAt - state.secondRafEnteredAt,
      visibilityCheckTotalMs: state.checks.reduce(
        (sum: number, item: { startTime: number; endTime: number }) =>
          sum + item.endTime - item.startTime,
        0
      )
    }
  })
}
