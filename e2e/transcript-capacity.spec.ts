import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PersistedChatSession, PersistedToolActivity } from '../src/shared/session-persistence'
import type { NotebookRunRecord } from '../src/shared/notebook'
import {
  createLinearConversationGraph,
  synchronizeActiveConversationActivities,
  forkEditedConversationMessage,
  activateConversationBranch,
  validateConversationGraph
} from '../src/shared/conversation-graph'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'
import { openGeneralSettings } from './fixtures/settings-preferences'

test.use({ windowMode: 'normal' })

test('bounds history scrolling and preserves native find across the transcript', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('transcript-capacity')
  await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({
      name: 'Transcript capacity',
      description: ''
    })
    const now = Date.now() - 400_000
    await window.api.sessions.saveSession({
      id: 'capacity-history',
      projectId: project.id,
      title: 'Capacity history',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now + 400,
      messages: Array.from({ length: 400 }, (_, index) => ({
        id: `capacity-${index}`,
        role: 'user' as const,
        content: `CAPACITYTOKEN${String(index).padStart(4, '0')}\n\n${'Historical paragraph for scrolling. '.repeat(5)}`,
        status: 'complete' as const,
        eventIds: [],
        createdAt: now + index,
        updatedAt: now + index
      }))
    })
  }, cwd)
  page = await app.restart()
  const openedAt = performance.now()
  await openProjectSession(page, 'Transcript capacity', 'Capacity history')
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  const rows = viewport.locator('[data-message-id^="capacity-"]')
  await expect(rows).toHaveCount(80)
  const openMs = performance.now() - openedAt
  const scrollMs: number[] = []
  const counts: number[] = [80]
  await viewport.hover()
  for (let i = 0; i < 4; i++) {
    const first = await rows.first().getAttribute('data-message-id')
    const startedAt = performance.now()
    await page.mouse.wheel(0, -100_000)
    await expect.poll(() => rows.first().getAttribute('data-message-id')).not.toBe(first)
    scrollMs.push(performance.now() - startedAt)
    counts.push(await rows.count())
    expect(counts.at(-1)).toBeLessThanOrEqual(160)
  }
  await expect(rows.first()).toHaveAttribute('data-message-id', 'capacity-0')
  const modifiers = process.platform === 'darwin' ? (['meta'] as const) : (['control'] as const)
  await app.pressMainWindowShortcut('F', [...modifiers])
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  await expect
    .poll(() =>
      page
        .context()
        .pages()
        .some((p) => p.url().includes('/find-overlay/'))
    )
    .toBe(true)
  const overlay = page
    .context()
    .pages()
    .find((p) => p.url().includes('/find-overlay/'))!
  for (const index of [0, 200, 399]) {
    await overlay.getByRole('textbox').fill(`CAPACITYTOKEN${String(index).padStart(4, '0')}`)
    await expect(viewport.locator(`[data-message-id="capacity-${index}"]`)).toBeInViewport()
    // Native find must keep its match visible when deferred transcript layout settles.
    await viewport.evaluate((element) => {
      element.style.height = `${element.clientHeight - 20}px`
    })
    await expect(viewport.locator(`[data-message-id="capacity-${index}"]`)).toBeInViewport()
  }
  await overlay.getByRole('button', { name: 'Close find' }).click()
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
  await expect.poll(() => rows.count()).toBeLessThanOrEqual(160)
  const screenshot = testInfo.outputPath('transcript-capacity.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('transcript-capacity', { path: screenshot, contentType: 'image/png' })
  const timingsPath = testInfo.outputPath('transcript-timings.json')
  await writeFile(
    timingsPath,
    JSON.stringify({
      messageCount: 400,
      mountedRows: counts,
      openMs,
      scrollMs,
      measurement:
        'Playwright wall time from wheel to changed first row; includes automation and polling latency, not frame time'
    })
  )
  await testInfo.attach('transcript-timings', {
    path: timingsPath,
    contentType: 'application/json'
  })
})

test('does not force unannotated transcript geometry during native layout changes', async ({
  app
}, testInfo) => {
  let page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('layout-history')
  await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({ name: 'Layout history', description: '' })
    const now = Date.now() - 400_000
    await window.api.sessions.saveSession({
      id: 'layout-history',
      projectId: project.id,
      title: 'Layout history',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now + 400,
      messages: Array.from({ length: 400 }, (_, index) => ({
        id: `layout-${index}`,
        role: index % 2 ? ('agent' as const) : ('user' as const),
        content:
          index % 2
            ? `## Result ${index}\n\n${'Historical paragraph for resizing. '.repeat(20)}\n\n| Column | Value |\n| --- | --- |\n| Data | 123 |\n\n\`\`\`python\nprint("layout")\n\`\`\``
            : index === 380
              ? 'Long historical prompt line.\n'.repeat(30)
              : `Historical question ${index}. ${'Explain the data. '.repeat(10)}`,
        status: 'complete' as const,
        eventIds: [],
        createdAt: now + index,
        updatedAt: now + index
      }))
    })
  }, cwd)
  page = await app.restart()
  await openProjectSession(page, 'Layout history', 'Layout history')
  await expect(page.locator('[data-message-id="layout-399"]')).toBeVisible()
  await expect(page.locator('[data-slot="message-scroller-item"]')).toHaveCount(80)
  await expect(page.locator('[data-annotation-surface]').first()).toBeAttached()

  // Count the synchronous geometry reads identified by the issue's CPU reproduction.
  // Work counts are deterministic; wall-clock/CPU thresholds would vary across CI runners.
  await page.evaluate(() => {
    const original = Element.prototype.getBoundingClientRect
    let reads = 0
    Object.defineProperty(window, '__unannotatedLayoutProbe', {
      configurable: true,
      value: {
        count: () => reads,
        restore: () => {
          Element.prototype.getBoundingClientRect = original
        }
      }
    })
    Element.prototype.getBoundingClientRect = function () {
      if (
        this.matches(
          '[data-annotation-surface]:not([data-annotation-active]):not([data-bookmark-active])'
        )
      )
        reads++
      return original.call(this)
    }
  })
  const counts: Record<string, number> = {}
  const readCount = (): Promise<number> =>
    page.evaluate(() =>
      (
        window as unknown as { __unannotatedLayoutProbe: { count: () => number } }
      ).__unannotatedLayoutProbe.count()
    )
  try {
    const settings = await openGeneralSettings(page)
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await expect(settings).toBeHidden()
    counts.settings = await readCount()
    for (let i = 0; i < 12; i++) {
      await app.setMainWindowSize(1050 + i * 15, 800 + (i % 5) * 10)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
    }
    counts.resize = (await readCount()) - counts.settings
    await testInfo.attach('unannotated-geometry-reads', {
      body: JSON.stringify(counts),
      contentType: 'application/json'
    })
    expect(counts, 'empty marker surfaces must not force offscreen layout').toEqual({
      settings: 0,
      resize: 0
    })
    await page.screenshot({ path: testInfo.outputPath('resized-history.png') })
  } finally {
    await page.evaluate(() => {
      ;(
        window as unknown as { __unannotatedLayoutProbe: { restore: () => void } }
      ).__unannotatedLayoutProbe.restore()
      Reflect.deleteProperty(window, '__unannotatedLayoutProbe')
    })
  }

  // An offscreen user row must still measure and offer disclosure on entry.
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  const longRow = viewport.locator('[data-message-id="layout-380"]')
  await longRow.scrollIntoViewIfNeeded()
  await expect(longRow).toBeInViewport()
  await longRow.getByRole('button', { name: 'Show more', exact: true }).click()
  await expect(longRow.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  await longRow.getByRole('button', { name: 'Show less', exact: true }).click()
  await expect(longRow.getByRole('button', { name: 'Show more', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})

for (const { count, contextLines } of [
  { count: 100, contextLines: 1400 },
  { count: 500, contextLines: 2800 },
  { count: 1000, contextLines: 5600 },
  { count: 1000, contextLines: 0 }
]) {
  test(`profiles ${count} Notebook runs and ${contextLines ? 'long' : 'short'} approvals across branches and restart @capacity`, async ({
    app
  }, testInfo) => {
    test.setTimeout(300_000)
    let page = await app.completeOnboarding()
    const cwd = await app.createTestDirectory('notebook-review-capacity')
    const projectName = `Notebook capacity ${count}`
    const projectId = await page.evaluate(
      async (name) => (await window.api.projects.create({ name, description: '' })).id,
      projectName
    )
    await app.beginResourceProfile({ sampleIntervalMs: 1000 })
    page = app.page
    const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    const id = `notebook-capacity-${count}`
    const now = Date.now() - count * 100
    const session: PersistedChatSession = {
      id,
      projectId,
      title: `Notebook history ${count}`,
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now + count * 10,
      messages: Array.from({ length: count * 2 }, (_, i) => ({
        id: `capacity-message-${i}`,
        role: i % 2 ? 'agent' : 'user',
        status: 'complete',
        content: i % 2 ? `Saved Notebook result ${i}` : `Inspect research data ${i}`,
        eventIds: [],
        createdAt: now + i * 5,
        updatedAt: now + i * 5
      })),
      activities: []
    }
    const activities: PersistedToolActivity[] = []
    const runs: NotebookRunRecord[] = []
    const longSource =
      '# Research context and reproducible calculations\n'.repeat(contextLines) +
      'import os\nos.unlink("temporary.txt")'
    let expectedReviewCount = 0
    for (let i = 0; i < count; i++) {
      const reviewed = i % 25 === 0 || i >= count - 3
      const code = reviewed
        ? `# Run ${i}\n${longSource}`
        : `values = [${i}, ${i + 1}]\nprint(sum(values))`
      const promptMessageId = `capacity-message-${i * 2}`
      const runId = `capacity-run-${i}`
      runs.push({
        runId,
        cellId: `capacity-cell-${i}`,
        source: 'agent',
        kernelKind: 'python',
        script: code,
        status: 'completed',
        startedAt: now + i * 10 + 1,
        endedAt: now + i * 10 + 3,
        promptMessageId,
        rootFrameId: `root-frame-${id}`,
        agentFrameId: `root-frame-${id}`,
        messageBranchId: `message-branch-${id}`,
        runtimeSegmentId: `runtime-segment-${id}`,
        text: { stdout: String(i * 2 + 1), stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: []
      })
      const base: PersistedToolActivity = {
        id: `tool-${i}`,
        kind: 'tool',
        title: 'Notebook run',
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        status: 'completed',
        sortIndex: i * 2,
        eventIds: [],
        promptMessageId,
        createdAt: now + i * 10 + 1,
        updatedAt: now + i * 10 + 3,
        rawInput: { language: 'python', code },
        rawOutput: { runId, kernelKind: 'python', status: 'completed' }
      }
      activities.push(base)
      if (reviewed) {
        expectedReviewCount++
        activities.push({
          ...base,
          id: `app-approval:capacity-${i}`,
          appOwned: true,
          providerToolName: 'Open-Science',
          title: 'Review potentially destructive code',
          sortIndex: i * 2 + 1,
          rawOutput: undefined,
          rawInput: {
            code,
            notebookCodeRisk: {
              runId,
              language: 'python',
              environment: 'default-python',
              risks: [
                {
                  operation: 'os.unlink',
                  source: 'os.unlink("temporary.txt")',
                  line: code.split('\n').length
                }
              ]
            }
          }
        })
      }
    }
    let graph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: id,
        messages: session.messages,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }),
      activities,
      []
    )
    const primaryBranch = graph.frames[0].activeBranchId
    const alternateBranch = `alternate-${id}`
    graph = forkEditedConversationMessage(
      graph,
      `capacity-message-${(count - 4) * 2}`,
      alternateBranch,
      session.updatedAt + 1
    )
    graph = activateConversationBranch(graph, primaryBranch)
    validateConversationGraph(graph)
    session.conversationGraph = graph
    session.activities = activities
    const metrics: Record<string, unknown> = {
      count,
      reviews: expectedReviewCount,
      longSourceCharacters: longSource.length,
      uniqueRunSourceBytes: runs.reduce((sum, run) => sum + Buffer.byteLength(run.script), 0),
      measurement:
        'Renderer performance.now around preload calls includes IPC plus main work; UI wall time includes Playwright. Fixture creation and run seeding are excluded. No kernels or external providers execute.'
    }
    const rendererHeap: Record<string, unknown> = {}
    metrics.rendererHeap = rendererHeap
    const captureHeap = async (phase: string): Promise<void> => {
      const cdp = await page.context().newCDPSession(page)
      try {
        rendererHeap[phase] = await cdp.send('Runtime.getHeapUsage')
      } finally {
        await cdp.detach()
      }
    }
    try {
      page = await app.restartWithSessionFixture(session, runs)
      await app.markResourceProfilePhase('seeded-cold')
      const openedAt = performance.now()
      await openProjectSession(page, projectName, session.title)
      await expect(
        page.locator(`[data-message-id="capacity-message-${count * 2 - 1}"]`)
      ).toBeVisible()
      metrics.firstViewMs = performance.now() - openedAt
      metrics.mountedMessages = await page.locator('[data-message-id]').count()
      expect(metrics.mountedMessages).toBeLessThanOrEqual(160)
      await app.markResourceProfilePhase('first-view')
      await captureHeap('first-view')
      // Review history remains durable without mounting duplicate transcript code blocks.
      await expect(
        page.getByTestId('tool-chip').filter({ hasText: 'Code risk review' })
      ).toHaveCount(0)
      await expect(page.getByTestId('notebook-code-review-receipt')).toHaveCount(0)
      metrics.hiddenReviewReceipts = true
      await app.markResourceProfilePhase('reviews-hidden')
      await captureHeap('reviews-hidden')
      metrics.ipc = await page.evaluate(
        async ({ projectId, id, cwd, count }) => {
          const request = { projectId, sessionId: id }
          const loadMs: number[] = [],
            saveMs: number[] = [],
            runIndexMs: number[] = []
          let payloadBytes = 0,
            reviewCount = 0
          for (let i = 0; i < 3; i++) {
            let start = performance.now()
            const loaded = await window.api.sessions.loadOne(request)
            loadMs.push(performance.now() - start)
            if (!loaded) throw new Error('Capacity Session disappeared')
            if (i === 0) {
              payloadBytes = new TextEncoder().encode(JSON.stringify(loaded)).byteLength
              reviewCount = loaded.conversationGraph!.activities.filter((item) =>
                item.id.startsWith('app-approval:')
              ).length
            }
            start = performance.now()
            await window.api.sessions.saveSession(loaded)
            saveMs.push(performance.now() - start)
            start = performance.now()
            const index = await window.api.notebook.runIndex({ ...request, workspaceCwd: cwd })
            runIndexMs.push(performance.now() - start)
            if (index.length !== count)
              throw new Error(`Lost Notebook runs: ${index.length}/${count}`)
          }
          return { loadMs, saveMs, runIndexMs, payloadBytes, reviewCount }
        },
        { projectId, id, cwd, count }
      )
      expect((metrics.ipc as { reviewCount: number }).reviewCount).toBe(expectedReviewCount)
      const branchMetrics = []
      for (const branchId of [alternateBranch, primaryBranch, alternateBranch, primaryBranch]) {
        const started = performance.now()
        const saveMs = await page.evaluate(
          async ({ projectId, id, branchId }) => {
            const loaded = await window.api.sessions.loadOne({ projectId, sessionId: id })
            if (!loaded) throw new Error('Missing Session')
            const frame = loaded.conversationGraph!.frames.find(
              (frame) => frame.id === loaded.conversationGraph!.rootFrameId
            )!
            const start = performance.now()
            await window.api.sessions.saveSession(loaded, {
              conversationCommands: [
                {
                  id: `capacity-switch-${Date.now()}`,
                  timestamp: Date.now(),
                  kind: 'select-branch',
                  branchId,
                  previousBranchId: frame.activeBranchId
                }
              ]
            })
            return performance.now() - start
          },
          { projectId, id, branchId }
        )
        await page.reload()
        await openProjectSession(page, projectName, session.title)
        const tail = branchId === primaryBranch ? count * 2 - 1 : (count - 4) * 2 - 1
        await expect(page.locator(`[data-message-id="capacity-message-${tail}"]`)).toBeVisible()
        if (branchId === alternateBranch)
          await expect(
            page.locator(`[data-message-id="capacity-message-${count * 2 - 1}"]`)
          ).toHaveCount(0)
        branchMetrics.push({ branchId, saveMs, switchAndReloadMs: performance.now() - started })
      }
      metrics.branchSwitches = branchMetrics
      await app.markResourceProfilePhase('four-branch-switches')
      await captureHeap('four-branch-switches')
      const restartAt = performance.now()
      page = await app.restart({ resourceProfilePhase: 'restart' })
      metrics.restartToReadyMs = performance.now() - restartAt
      const restoredAt = performance.now()
      await openProjectSession(page, projectName, session.title)
      await expect(
        page.locator(`[data-message-id="capacity-message-${count * 2 - 1}"]`)
      ).toBeVisible()
      metrics.restoredViewMs = performance.now() - restoredAt
      const integrity = await page.evaluate(
        async ({ projectId, id, expectedCode }) => {
          const loaded = await window.api.sessions.loadOne({ projectId, sessionId: id })
          const restoredReviews = loaded!.conversationGraph!.activities.filter((item) =>
            item.id.startsWith('app-approval:')
          )
          return {
            branches: loaded!.conversationGraph!.branches.length,
            hostOwned: restoredReviews.every((item) => item.appOwned === true),
            exactSource:
              (restoredReviews.at(-1)!.rawInput as { code: string }).code === expectedCode
          }
        },
        { projectId, id, expectedCode: runs.at(-1)!.script }
      )
      expect(integrity).toEqual({ branches: 2, hostOwned: true, exactSource: true })
      await app.markResourceProfilePhase('restored-view')
      await captureHeap('restored-view')
      await app.captureResourceTimings('capacity:')
      await page.screenshot({ path: testInfo.outputPath('notebook-capacity.png') })
      // Notebook data root is separate from settings/Session storage; derive the latter from
      // the profiler's documented fixture root, without inspecting any user storage.
      const sessionPath = join(dataRoot, '..', 'storage', 'sessions', projectId, `${id}.json`)
      metrics.sessionFileBytes = (await stat(sessionPath)).size
      const durable = JSON.parse(await readFile(sessionPath, 'utf8'))
      let allReviewSourceBytes = 0,
        reviewSourceCopies = 0
      const uniqueReviewSources = new Set<string>()
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        if ('notebookCodeRisk' in value && 'code' in value && typeof value.code === 'string') {
          reviewSourceCopies++
          allReviewSourceBytes += Buffer.byteLength(value.code)
          uniqueReviewSources.add(value.code)
        }
        for (const child of Object.values(value)) visit(child)
      }
      visit(durable)
      const uniqueReviewSourceBytes = [...uniqueReviewSources].reduce(
        (sum, code) => sum + Buffer.byteLength(code),
        0
      )
      metrics.sourceDuplication = {
        reviewSourceCopies,
        uniqueReviewCount: uniqueReviewSources.size,
        allReviewSourceBytes,
        uniqueReviewSourceBytes,
        redundantReviewSourceBytes: allReviewSourceBytes - uniqueReviewSourceBytes
      }
      // Each seeded review has a unique "# Run i" prefix; repeated durable projections
      // add source copies, never new unique sources.
      expect(uniqueReviewSources.size).toBe(expectedReviewCount)
    } finally {
      const profile = await app.finishResourceProfile()
      await testInfo.attach('notebook-capacity-profile', {
        path: profile.summaryMarkdownPath,
        contentType: 'text/markdown'
      })
      await testInfo.attach('notebook-capacity-resource-data', {
        body: JSON.stringify(profile.summary),
        contentType: 'application/json'
      })
      await writeFile(
        testInfo.outputPath('notebook-capacity-metrics.json'),
        JSON.stringify(metrics, null, 2)
      )
      await testInfo.attach('notebook-capacity-metrics', {
        path: testInfo.outputPath('notebook-capacity-metrics.json'),
        contentType: 'application/json'
      })
    }
  })
}
