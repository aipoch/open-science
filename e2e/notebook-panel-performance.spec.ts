import { createHash } from 'node:crypto'
import { expect } from '@playwright/test'
import { dirname, join } from 'node:path'
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type { Locator, Page } from 'playwright'
import { getNotebookSessionRoot } from '../src/main/notebook/repository'
import type { NotebookRunRecord } from '../src/shared/notebook'
import { test, type ElectronApp } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'
import {
  measureClickToVisible,
  measureInputPresentation,
  startSessionUiProbe,
  stopSessionUiProbe,
  type SessionUiOpenTiming,
  type SessionUiProbeResult
} from './fixtures/session-ui-performance'

test.use({ windowMode: 'normal', trace: 'off', video: 'off' })
test.skip(!process.env.OPEN_SCIENCE_NOTEBOOK_PANEL_BENCH, 'Opt-in foreground Electron benchmark')

const fixtureRun = (i: number, environment: string | undefined, png: string): NotebookRunRecord => {
  const mixed = i < 900
  const lines = mixed && i % 20 === 0 ? 28 : 2
  const stdout = mixed && i % 10 === 0 ? 'observation\n'.repeat(80) : '42\n'
  return {
    runId: 'baseline-' + i,
    cellId: 'cell-' + i,
    source: 'user',
    kernelKind: 'python',
    environment,
    startedAt: i + 1,
    endedAt: i + 1,
    status: 'completed',
    script: Array.from({ length: lines }, (_, n) => 'value_' + n + ' = ' + (i + n)).join('\n'),
    text: { stdout, stderr: '', traceback: '', plain: [] },
    outputs:
      mixed && i % 25 === 0
        ? [
            { type: 'stream', name: 'stdout', text: stdout },
            { type: 'display', data: { 'image/png': png } }
          ]
        : [],
    workingFiles: [],
    artifacts: []
  }
}

type ViewportSample = {
  mounted: number
  descendants: number
  top: number
  height: number
  width: number
  remaining: number
  anchor?: string
  offset?: number
}

async function geometry(viewport: Locator): Promise<ViewportSample> {
  return viewport.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const rows = [...element.querySelectorAll<HTMLElement>('[data-run-id]')]
    const anchor = rows.find((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })
    return {
      mounted: rows.length,
      descendants: element.querySelectorAll('*').length,
      top: element.scrollTop,
      height: element.clientHeight,
      width: element.clientWidth,
      remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
      anchor: anchor?.dataset.runId,
      offset: anchor && anchor.getBoundingClientRect().top - bounds.top
    }
  })
}

async function scrollSample(
  page: Page,
  viewport: Locator,
  sessionId: string,
  label: string
): Promise<{ before: ViewportSample; after: ViewportSample; probe: SessionUiProbeResult }> {
  await viewport.hover()
  const before = await geometry(viewport)
  await startSessionUiProbe(page, { sessionId, label })
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, -140)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    )
  }
  const probe = await stopSessionUiProbe(page)
  expect(probe.invalidReasons).toEqual([])
  const after = await geometry(viewport)
  expect(after.top).toBeLessThan(before.top)
  return { before, after, probe }
}

// Count committed Cell host renders for a separate diagnostic keystroke. Keep the tree
// walk out of the latency samples. React bails out by sharing the previous child list.
async function installCellCommitProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Fiber = {
      type: unknown
      child: Fiber | null
      sibling: Fiber | null
      alternate: Fiber | null
      memoizedProps?: Record<string, unknown>
    }
    const probe = { armed: false, counts: [] as number[] }
    Reflect.set(window, '__notebookCommitProbe', probe)
    Reflect.set(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        if (!probe.armed) return
        let changed = 0
        function visit(fiber: Fiber): void {
          if (
            fiber.type === 'div' &&
            fiber.memoizedProps?.['data-testid'] === 'notebook-cell' &&
            fiber.memoizedProps !== fiber.alternate?.memoizedProps
          )
            changed++
          if (fiber.child === fiber.alternate?.child) return
          for (let child = fiber.child; child; child = child.sibling) visit(child)
        }
        visit(root.current)
        probe.counts.push(changed)
      }
    })
  })
}

async function probeOneKey(page: Page, input: Locator): Promise<number[]> {
  await input.focus()
  await page.evaluate(() => {
    const probe = Reflect.get(window, '__notebookCommitProbe')
    probe.counts = []
    probe.armed = true
  })
  await input.press('x')
  await expect(input).toHaveValue('x')
  const counts = await page.evaluate(() => {
    const probe = Reflect.get(window, '__notebookCommitProbe')
    probe.armed = false
    return probe.counts as number[]
  })
  expect(counts.length).toBeGreaterThan(0)
  await input.fill('')
  return counts
}

type BenchmarkHistory = {
  page: Page
  sessionId: string
  environment?: string
  projectId: string
  sample: NotebookRunRecord[]
  singleOutputBytes: number
}

const prepareHistory = async (
  app: ElectronApp,
  size: number,
  kind: 'scalar' | 'science'
): Promise<BenchmarkHistory> => {
  const interpreter = process.env.OPEN_SCIENCE_TEST_PYTHON
  if (!interpreter) throw new Error('Set OPEN_SCIENCE_TEST_PYTHON to the benchmark interpreter.')
  const python = await realpath(interpreter)
  const png = (await readFile('e2e/fixtures/sanitized-performance.png')).toString('base64')
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.evaluate(
    async ({ path, root }) => {
      await window.api.localFs.grantRoot({ path: root, access: 'ro' })
      await window.api.runtime.registerInterpreter('python', path)
      await window.api.runtime.setEnvironmentEnabled('python', path, true)
      await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
    },
    { path: python, root: dirname(dirname(python)) }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  const projectId = await createProject(page, 'Notebook panel performance')
  const prompt = 'Warm the Notebook benchmark kernel.'
  await sendPrompt(page, prompt, 'Notebook benchmark kernel ready.', 120_000)
  const session = await page.evaluate(async (projectId) => {
    const session = (await window.api.sessions.loadAll()).sessions.find(
      (s) => s.projectId === projectId
    )
    if (!session) throw new Error('Benchmark session missing')
    return session
  }, projectId)
  const kernel = (await app.readNotebookFixtureRuns(projectId, session.id)).find(
    (run) => run.kernelKind === 'python'
  )
  expect(kernel?.status).toBe('completed')
  const sample = Array.from({ length: size - 2 }, (_, i) => {
    const run = fixtureRun(i, kernel?.environment, png)
    if (kind === 'science') {
      run.kernelEpochId = 'phase3-science'
      run.script = [
        'import pandas as pd',
        "frame = pd.DataFrame({'value': [1, 2]})",
        "values = frame['value']",
        'total = values.sum()'
      ][i % 4]
    }
    return run
  })
  const giant = fixtureRun(1, 'large-output-control', png)
  giant.runId = 'single-large'
  giant.cellId = 'cell-large'
  giant.text.stdout = 'single-large-output\n'.repeat(8192)
  page = await app.restartWithSessionFixture(session, [...sample, giant])
  await installCellCommitProbe(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openRecentSession(page, prompt)
  await sendPrompt(page, prompt, 'Notebook benchmark kernel ready.', 120_000)
  await app.setMainWindowSizeAndViewport(1440, 900)
  await app.setMainWindowZoomFactor(1)
  await page.bringToFront()
  return {
    page,
    sessionId: session.id,
    environment: kernel?.environment,
    projectId,
    singleOutputBytes: Buffer.byteLength(giant.text.stdout),
    sample
  }
}

const openHistory = (page: Page): Promise<SessionUiOpenTiming> =>
  measureClickToVisible(page, page.getByRole('button', { name: 'Open notebook', exact: true }), {
    selector: '[data-testid="notebook-cells"] [data-run-id]',
    timeoutMs: 120_000
  })

test('measures the live Notebook panel as persisted history grows', async ({ app }, testInfo) => {
  test.setTimeout(600_000)
  test.skip(process.env.OPEN_SCIENCE_NOTEBOOK_PANEL_BENCH === 'open-scan')
  const { page, sessionId, environment, projectId, singleOutputBytes } = await prepareHistory(
    app,
    1000,
    'scalar'
  )
  const viewport = page.getByTestId('notebook-cells')
  const open = await openHistory(page)
  const input = page.getByTestId('kernel-terminal-input')
  await expect(input).toBeEditable()
  const initial = await geometry(viewport)
  await testInfo.attach('initial-viewport', {
    body: JSON.stringify(initial),
    contentType: 'application/json'
  })
  const shortInput = await measureInputPresentation(page, input, 'value = 1234567890 + 42')
  await input.fill('')
  const shortCommits = await probeOneKey(page, input)
  const shortScroll = await scrollSample(page, viewport, sessionId, 'initial-page')
  const earlier = viewport.getByRole('button', { name: 'Load earlier runs', exact: true })
  const pages = []
  while (await earlier.count()) {
    expect(pages.length).toBeLessThan(12)
    await earlier.scrollIntoViewIfNeeded()
    await expect.poll(async () => (await geometry(viewport)).anchor).toBeTruthy()
    const before = await geometry(viewport)
    expect(before.anchor).toBeTruthy()
    const anchor = viewport.locator('[data-run-id="' + before.anchor + '"]')
    // Measure from actual user input to the old Cell receiving its new chronological
    // number plus two animation frames. Playwright's assertion polling is outside the clock.
    await earlier.evaluate((button, id) => {
      const container = button.closest('[data-testid="notebook-cells"]')!
      const number = (): string | undefined =>
        container.querySelector('[data-run-id="' + id + '"] [data-testid="notebook-cell"] span')
          ?.textContent ?? undefined
      const initial = number()
      if (!initial) throw new Error('Missing prepend anchor number')
      Reflect.deleteProperty(window, '__notebookPrependMs')
      button.addEventListener(
        'click',
        (event) => {
          const observer = new MutationObserver(() => {
            const current = number()
            if (!current || current === initial) return
            observer.disconnect()
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                Reflect.set(window, '__notebookPrependMs', performance.now() - event.timeStamp)
              )
            )
          })
          observer.observe(container, { subtree: true, childList: true, characterData: true })
        },
        { once: true, capture: true }
      )
    }, before.anchor!)
    await earlier.click()
    await page.waitForFunction(() => typeof Reflect.get(window, '__notebookPrependMs') === 'number')
    const elapsed = await page.evaluate(() => Reflect.get(window, '__notebookPrependMs') as number)
    const after = await geometry(viewport)
    const anchorOffset = await anchor.evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        row.closest('[data-testid="notebook-cells"]')!.getBoundingClientRect().top
    )
    pages.push({ before, after, elapsed, anchorDrift: anchorOffset - before.offset! })
  }

  await viewport.hover()
  await page.mouse.wheel(0, 1_000_000)
  await expect
    .poll(async () => {
      const view = await geometry(viewport)
      return !!view.anchor && view.remaining <= 2
    })
    .toBe(true)
  const full = await geometry(viewport)
  const longInput = await measureInputPresentation(page, input, 'value = 1234567890 + 42')
  await input.fill('')
  const longCommits = await probeOneKey(page, input)
  const longScroll = await scrollSample(page, viewport, sessionId, 'all-pages')
  const beforeAppend = await geometry(viewport)
  expect(beforeAppend.top).toBeGreaterThan(0)
  expect(beforeAppend.remaining).toBeGreaterThan(beforeAppend.height)
  await input.fill('print("history-anchor-check")')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(input).toBeEditable()
  const afterAppend = await geometry(viewport)
  expect(afterAppend.anchor).toBe(beforeAppend.anchor)
  expect(Math.abs(afterAppend.offset! - beforeAppend.offset!)).toBeLessThanOrEqual(2)
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await input.fill('print("follow-tail-check")')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(viewport.getByTestId('notebook-text-output').last()).toContainText(
    'follow-tail-check'
  )
  await expect
    .poll(() => geometry(viewport).then((sample) => sample.remaining))
    .toBeLessThanOrEqual(2)
  const followed = await geometry(viewport)
  const singleOpen = await measureClickToVisible(
    page,
    page.getByTestId('env-option-large-output-control'),
    {
      selector: '[data-run-id="single-large"] [data-testid="notebook-text-output"]'
    }
  )
  const large = await geometry(viewport)
  expect(large.mounted).toBe(1)
  const textOutput = viewport.getByTestId('notebook-text-output')
  await expect(textOutput).toContainText('single-large-output')
  await textOutput.locator('summary').click()
  await expect(textOutput).not.toHaveAttribute('open')
  await textOutput.locator('summary').click()
  await expect(textOutput).toHaveAttribute('open', '')
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  const analysisCache = join(
    getNotebookSessionRoot(dataRoot, projectId, sessionId),
    'cache',
    'dependency-analysis.json'
  )
  const evidence = {
    analysisCacheBytes: (await stat(analysisCache)).size,
    open,
    initial,
    shortInput,
    shortCommits,
    shortScroll,
    pages,
    full,
    longInput,
    longCommits,
    longScroll,
    beforeAppend,
    afterAppend,
    followed,
    large,
    singleOpen,
    fixture: {
      mainRuns: 1000,
      singleOutputBytes,
      zoom: 1,
      window: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        userAgent: navigator.userAgent
      }))
    }
  }
  await writeFile(testInfo.outputPath('notebook-baseline.json'), JSON.stringify(evidence, null, 2))
  expect(pages.length).toBeGreaterThan(0)
  if (process.env.OPEN_SCIENCE_NOTEBOOK_PANEL_BENCH === 'verify') {
    for (const sample of [
      initial,
      full,
      shortScroll.after,
      longScroll.after,
      ...pages.map((page) => page.after)
    ]) {
      expect(sample.mounted).toBeGreaterThan(0)
      expect(sample.mounted).toBeLessThanOrEqual(32)
    }
    expect([...shortCommits, ...longCommits].every((count) => count === 0)).toBe(true)
    for (const sample of pages) {
      expect(
        Math.abs(sample.anchorDrift),
        'Prepend before ' + sample.before.anchor
      ).toBeLessThanOrEqual(2)
    }
    const mainEnv = page.getByTestId('env-option-' + environment)
    await mainEnv.click()
    const rows = viewport.locator('[data-run-id]')
    const match = viewport.locator('[data-run-id="baseline-701"]')
    const findMatch = async (): Promise<void> => {
      await app.pressMainWindowShortcut('F', [process.platform === 'darwin' ? 'meta' : 'control'])
      await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
      const overlay = page
        .context()
        .pages()
        .find((p) => p.url().includes('/find-overlay/'))!
      await overlay.getByRole('textbox').fill('')
      await overlay.getByRole('textbox').fill('value_0 = 701')
      await expect(match).toBeInViewport()
      await overlay.getByRole('button', { name: 'Close find' }).click()
      await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
      await expect.poll(() => rows.count()).toBeLessThanOrEqual(32)
      await expect(match).toBeInViewport()
    }
    await findMatch()
    const details = match.getByTestId('notebook-text-output')
    await details.locator('summary').click()
    await expect(details).not.toHaveAttribute('open')
    const evidencePanel = match.getByTestId('notebook-run-evidence')
    await evidencePanel.locator('summary').click()
    await expect(evidencePanel).toHaveAttribute('open', '')
    await details.locator('summary').focus()
    await app.setMainWindowSizeAndViewport(1280, 800)
    await viewport.hover()
    await page.mouse.wheel(0, 80000)
    await expect(details.locator('summary')).toBeFocused()
    await input.focus()
    await expect(match).toHaveCount(0)
    await findMatch()
    await expect(details).not.toHaveAttribute('open')
    await expect(evidencePanel).toHaveAttribute('open', '')
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open', '')
    const selected = await match.evaluate((row) => {
      const next = row.nextElementSibling!
      const range = document.createRange()
      range.setStartBefore(row.querySelector('summary')!)
      range.setEndBefore(next.querySelector('[data-testid="notebook-text-output"]')!)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return selection.toString()
    })
    expect(selected.length).toBeGreaterThan(0)
    await viewport.hover()
    await page.mouse.wheel(0, 80000)
    await expect(match).not.toBeInViewport()
    await expect(match).toHaveCount(1)
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected)
  }
})

test.describe('Notebook opening performance', () => {
  test.skip(
    process.env.OPEN_SCIENCE_NOTEBOOK_PANEL_BENCH !== 'open-scan',
    'Opt-in cold and warm opening matrix'
  )
  for (const [size, kind] of [
    [100, 'scalar'],
    [1000, 'scalar'],
    [3000, 'scalar'],
    [1000, 'science']
  ] as const) {
    test('opens cold and warm history for ' + size + ' ' + kind, async ({ app }, testInfo) => {
      test.setTimeout(600_000)
      const { page, projectId, sessionId, sample } = await prepareHistory(app, size, kind)
      const dataRoot = await page.evaluate(
        async () => (await window.api.storage.getInfo()).dataRoot
      )
      const path = join(
        getNotebookSessionRoot(dataRoot, projectId, sessionId),
        'cache',
        'dependency-analysis.json'
      )
      const readCache = async (): Promise<Record<string, unknown>> => {
        try {
          return JSON.parse(await readFile(path, 'utf8')).runs
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
          throw error
        }
      }
      const fixtureCount = (records: Record<string, unknown>): number =>
        Object.keys(records).filter((key) => key.startsWith('baseline-')).length
      // A completed execution may still be analyzing history. Stop the isolated app first
      // so that only the measured opening can rebuild this fixture's derived cache.
      for (let round = 1; round <= 3; round++) {
        await app.close()
        await rm(path, { force: true })
        const fresh = await app.restart()
        await openRecentSession(fresh, 'Warm the Notebook benchmark kernel.')
        await app.setMainWindowSizeAndViewport(1440, 900)
        await app.setMainWindowZoomFactor(1)
        await fresh.bringToFront()
        expect(fixtureCount(await readCache())).toBe(0)
        const cold = await openHistory(fresh)
        const records = await readCache()
        expect(fixtureCount(records)).toBe(sample.length)
        // The digest compares the entire per-run analysis record across builds.
        const hash = createHash('sha256')
        for (const run of sample) hash.update(JSON.stringify(records[run.runId]))
        const close = fresh.getByRole('button', { name: 'Close preview of Notebook', exact: true })
        await close.click()
        await expect(fresh.getByTestId('notebook-cells')).toHaveCount(0)
        const warm = await openHistory(fresh)
        await close.click()
        await expect(fresh.getByTestId('notebook-cells')).toHaveCount(0)
        await writeFile(
          testInfo.outputPath('open-' + round + '.json'),
          JSON.stringify({
            size,
            kind,
            round,
            cold: cold.clickToPresentationOpportunityMs,
            warm: warm.clickToPresentationOpportunityMs,
            digest: hash.digest('hex')
          })
        )
      }
    })
  }
})
