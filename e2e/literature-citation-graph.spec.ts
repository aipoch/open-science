import { resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  expect,
  test as base,
  _electron,
  type ElectronApplication,
  type TestInfo
} from '@playwright/test'
import { build, preview, type PreviewServer } from 'vite'
import {
  citationGraphPath,
  openCitationGraph,
  verifyCitationDesktopLayout,
  verifyCitationPointerAndHistory,
  verifyCitationInspectorLifecycle,
  verifyCitationEdgeRendering,
  verifyCitationNarrowLayout,
  verifyCitationFocusAndClose
} from './fixtures/citation-graph-interactions'

let server: PreviewServer
let url: string

async function captureGraph(
  graphApp: ElectronApplication,
  info: TestInfo,
  name: string
): Promise<void> {
  const screenshot = info.outputPath(`${name}.png`)
  const pixels = await graphApp.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64')
  )
  await writeFile(screenshot, Buffer.from(pixels, 'base64'))
  await info.attach(name, { path: screenshot, contentType: 'image/png' })
}
const configFile = resolve('e2e/vite.browser-test.config.ts')
const outDir = resolve('out/citation-graph-electron')
const test = base.extend<{ graphApp: ElectronApplication }>({
  // eslint-disable-next-line no-empty-pattern
  graphApp: async ({}, provide) => {
    const userData = await mkdtemp(resolve(tmpdir(), 'citation-graph-'))
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'
      )
    )
    let app: ElectronApplication | undefined
    try {
      app = await _electron.launch({
        args: [resolve('e2e/fixtures/citation-graph-electron.mjs')],
        env: { ...environment, CITATION_GRAPH_USER_DATA: userData }
      })
      await provide(app)
    } finally {
      try {
        await app?.close()
      } finally {
        await rm(userData, { recursive: true, force: true })
      }
    }
  },
  page: async ({ graphApp }, provide) => {
    await provide(await graphApp.firstWindow())
  }
})

test.beforeAll(async () => {
  // Fixture bundling shares the browser suite's startup budget; interactions keep their own timeout.
  test.setTimeout(300_000)
  await build({
    configFile,
    logLevel: 'warn',
    build: {
      outDir,
      rollupOptions: { input: [resolve('e2e/browser/fixture/literature-recovery.html')] }
    }
  })
  server = await preview({
    configFile,
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: false }
  })
  const origin = server.resolvedUrls?.local[0]
  if (!origin) throw new Error('Citation graph preview server has no local URL.')
  url = `${origin.replace(/\/$/, '')}${citationGraphPath}`
})
test.afterAll(async () => {
  if (server) await new Promise<void>((done) => server.httpServer.close(() => done()))
})

test('Electron graph desktop canvas, details and independent paper list', async ({
  page,
  graphApp
}, info) => {
  await openCitationGraph(page, url)
  const switcher = page.getByRole('group', { name: 'Citation discovery view' })
  const listView = switcher.getByRole('button', { name: 'List', exact: true })
  const graphView = switcher.getByRole('button', { name: 'Citation graph', exact: true })
  await expect(listView.locator('.lucide-list')).toBeVisible()
  await expect(graphView.locator('svg')).toBeVisible()
  await expect(graphView).toHaveAttribute('aria-pressed', 'true')
  await listView.click()
  await expect(listView).toHaveAttribute('data-variant', 'default')
  await expect(graphView).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: info.outputPath('citation-list-view.png') })
  await graphView.focus()
  await page.keyboard.press('Enter')
  await expect(graphView).toHaveAttribute('data-variant', 'default')
  await expect(listView).toHaveAttribute('aria-pressed', 'false')
  await captureGraph(graphApp, info, 'electron-graph-desktop-initial')
  await verifyCitationDesktopLayout(page, async () => {
    const frame = page.locator('[data-current-frame="true"]')
    const details = frame.getByRole('button', { name: 'View details' })
    await expect(details).toHaveText('View details')
    for (const label of ['Set as center', 'Add to Inbox']) {
      await frame.getByRole('button', { name: label, exact: true }).hover()
      await expect(page.getByRole('tooltip')).toHaveText(label)
    }
    await page.screenshot({ path: info.outputPath('electron-graph-list-selection.png') })
    await page.mouse.move(0, 0)
    await frame.locator('[data-citation-paper-id][aria-pressed="true"]').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('tooltip')).toHaveText('Add to Inbox')
  })
  await captureGraph(graphApp, info, 'electron-graph-desktop-selected')
})

test('Electron groups graph guidance, loads missing paper details and stages selections across tabs', async ({
  page
}, info) => {
  await openCitationGraph(page, url + '&hold-paper-details', undefined, 'all')
  const frame = page.locator('[data-current-frame="true"]')
  const source = page.getByRole('combobox', { name: 'Citation source' })
  await expect(source.locator('.lucide-library-big')).toBeVisible()
  await source.click()
  await expect(page.getByRole('option')).toHaveCount(3)
  await expect(page.getByRole('option').locator('svg')).toHaveCount(1)
  await expect(page.getByRole('option', { selected: true }).locator('.lucide-check')).toBeVisible()
  await page.screenshot({ path: info.outputPath('citation-sources.png') })
  await page.keyboard.press('Escape')
  const key = frame.locator('[data-citation-legend]')
  const legend = (await key.boundingBox())!
  const canvas = (await frame.getByRole('region', { name: 'Citation graph' }).boundingBox())!
  expect(legend.x - canvas.x).toBeLessThan(20)
  const centerMark = frame.locator('[data-citation-legend] .border-primary')
  expect(await centerMark.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await frame
      .locator('[data-paper-id="europe-pmc:MED:1000"] [data-node-mark]')
      .evaluate((el) => getComputedStyle(el).fill)
  )
  await expect(key.getByText('Scroll to zoom. Drag to pan.')).toBeVisible()
  await frame.locator('[data-paper-id="europe-pmc:MED:1101"] [data-node-mark]').click()
  await expect(frame.locator('[data-slot="abstract-skeleton"]')).toBeVisible()
  await expect(frame.getByRole('heading', { name: /Graph paper 1101/ })).toBeVisible()
  await expect(
    frame.getByRole('button', { name: 'Set as center' }).locator('.lucide-crosshair')
  ).toBeVisible()
  await expect(
    frame.getByRole('button', { name: 'Add to Inbox' }).locator('.lucide-inbox')
  ).toBeVisible()
  await page.screenshot({ path: info.outputPath('citation-details-loading.png') })
  await page.evaluate(() =>
    (
      window as unknown as { literatureLink: { completeLookup(index: number): void } }
    ).literatureLink.completeLookup(0)
  )
  await expect(frame.locator('[data-slot="abstract-skeleton"]')).toHaveCount(0)
  await expect(frame.getByText(/Metadata supplied by the browser fixture/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('citation-detail-actions.png') })
  await frame.getByRole('button', { name: 'Back to list' }).click()
  await frame.getByRole('button', { name: 'Select multiple' }).click()
  await frame.getByRole('checkbox', { name: /Select Graph paper 1101:/ }).check()
  await frame
    .getByRole('tablist', { name: 'Paper list' })
    .getByRole('tab', { name: /Cited by/ })
    .click()
  await frame.getByRole('checkbox', { name: /Select Graph paper 1200:/ }).check()
  await expect(frame.getByText('Selected: 2')).toBeVisible()
  await page.screenshot({ path: info.outputPath('citation-batch-selection.png') })
  await frame.getByRole('button', { name: 'Add to Inbox' }).click()
  await expect(frame.getByText('Selected: 0')).toBeVisible()
  await expect(frame.getByRole('checkbox', { name: /Select Graph paper 1200:/ })).toBeDisabled()
})

test('Electron shows initial, queued and partial citation results', async ({ page }, info) => {
  await page.goto(url + '&citation-loading')
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByRole('button', { name: 'A reference with supporting PDFs', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const finishRequest = (): Promise<void> =>
    page.evaluate(() =>
      (window as unknown as { finishCitationLookup(): void }).finishCitationLookup()
    )
  await dialog.getByRole('button', { name: 'References', exact: true }).click()
  await expect(dialog.locator('[data-slot="citation-loading"]')).toBeVisible()
  await finishRequest()
  await expect(dialog.getByRole('checkbox').first()).toBeVisible()
  await dialog.getByRole('button', { name: 'Citation graph', exact: true }).click()
  const frame = dialog.locator('[data-current-frame="true"]')
  const tabs = frame.getByRole('tablist', { name: 'Paper list' })
  const references = tabs.getByRole('tab', { name: /^References/ })
  const citedBy = tabs.getByRole('tab', { name: /^Cited by/ })
  const placeholder = frame.locator('[data-slot="citation-loading"]')
  await expect(references).toHaveAttribute('aria-busy', 'true')
  await expect(placeholder).toContainText('Searching…')
  await page.screenshot({ path: info.outputPath('citation-first-load.png') })
  await citedBy.click()
  await expect(placeholder).toContainText('Queued')
  await finishRequest()
  await expect(citedBy).toHaveAttribute('aria-busy', 'true')
  await expect(placeholder).toContainText('Papers that cite this paper.')
  await expect(placeholder).toContainText('Searching…')
  await references.click()
  await expect(frame.locator('[data-citation-paper-id]')).toHaveCount(20)
  await expect(placeholder).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('citation-cited-by-loading.png') })
  await finishRequest()
  await expect(citedBy).not.toHaveAttribute('aria-busy', 'true')
  await citedBy.click()
  await expect(frame.locator('[data-citation-paper-id]')).toHaveCount(20)
  await expect(placeholder).toHaveCount(0)
})

test('Electron keeps a failed citation page readable and retries in place', async ({
  page
}, info) => {
  await openCitationGraph(page, url + '&fail-next-page')
  const frame = page.locator('[data-current-frame="true"]')
  const papers = frame.getByRole('region', { name: 'Paper list', exact: true })
  const more = papers.getByRole('button', { name: 'Load more' })
  const before = await more.boundingBox()
  await more.click()
  const retry = papers.getByRole('button', { name: 'Retry' })
  const notice = papers.getByRole('alert')
  await expect(retry).toBeInViewport({ ratio: 1 })
  await expect(notice).not.toBeInViewport()
  expect((await retry.boundingBox())!.y).toBeCloseTo(before!.y, 0)
  const last = papers.locator('[data-citation-paper-id]').last()
  await last.scrollIntoViewIfNeeded()
  await last.click()
  await expect(last).toHaveAttribute('aria-pressed', 'true')
  await expect(retry).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: info.outputPath('citation-page-retry.png') })
  await retry.click()
  await expect(papers.locator('[data-citation-paper-id]')).toHaveCount(40)
  await expect(papers.getByText('No more results', { exact: true })).toBeInViewport({ ratio: 1 })
  await expect(more).toHaveCount(0)
  await expect(retry).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('citation-last-page.png') })
  await expect(papers.locator('[data-citation-paper-id][aria-pressed="true"]')).toContainText(
    'Graph paper 1119'
  )
  await expect(notice).toHaveCount(0)
})

test('Electron briefly hints only when a new page adds papers beyond the viewport', async ({
  page
}, info) => {
  await openCitationGraph(page, url)
  const frame = page.locator('[data-current-frame="true"]')
  const hint = frame.getByText(
    'New papers are outside the current view. Fit the graph to see all loaded papers.'
  )
  const zoomIn = frame.getByRole('button', { name: 'Zoom in', exact: true })
  await zoomIn.click()
  await zoomIn.click()
  await expect(hint).toHaveCount(0)
  await frame.getByRole('button', { name: 'Load more' }).click()
  await expect(hint).toBeVisible()
  await page.screenshot({ path: info.outputPath('citation-page-hint.png') })
  await expect(hint).toHaveCount(0, { timeout: 8000 })
  await zoomIn.click()
  await expect(hint).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('citation-zoomed.png') })
})

test('Electron graph preserves selected paper and camera across detail disclosure return', async ({
  page
}) => {
  await openCitationGraph(page, url)
  await verifyCitationInspectorLifecycle(page)
})

test('Electron graph preserves edge direction and highlights selected relationships', async ({
  page,
  graphApp
}, info) => {
  await openCitationGraph(page, url)
  await verifyCitationEdgeRendering(page, async (state) => {
    await captureGraph(graphApp, info, `electron-graph-edges-${state}`)
  })
})

test('Electron graph restores visible focus when a resize collapses details', async ({
  page,
  graphApp
}, info) => {
  await openCitationGraph(page, url)
  const frame = page.locator('[data-current-frame="true"]')
  const selected = frame.locator('[data-paper-id="europe-pmc:MED:1100"]')
  await selected.locator('[data-node-mark]').click()
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  const list = frame.locator('[data-citation-paper-list-toggle]')
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  const action = frame.getByRole('button', { name: 'View details', exact: true })
  await action.focus()
  await expect(action).toBeFocused()
  await graphApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(375, 812)
  })
  const disclosure = frame.locator('[data-citation-inspector-toggle]')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await expect(disclosure).toBeVisible()
  await expect(disclosure).toBeFocused()
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  await expect(frame.getByRole('region', { name: 'Paper list', exact: true })).toBeVisible()
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'false')
  await expect(frame.locator('[data-citation-inspector-title]')).toBeVisible()
  await captureGraph(graphApp, info, 'electron-graph-375-resize-focus')
})

for (const zoom of [1, 1.25]) {
  test(`Electron graph pointer geometry and exploration at zoom ${zoom}`, async ({
    page,
    graphApp
  }) => {
    await openCitationGraph(page, url, async () => {
      await graphApp.evaluate(({ BrowserWindow }, zoom) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setContentSize(1440, 1000)
        window.webContents.setZoomFactor(zoom)
      }, zoom)
      await expect
        .poll(() =>
          graphApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor()
          )
        )
        .toBe(zoom)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeCloseTo(1440 / zoom, 0)
    })
    await verifyCitationPointerAndHistory(page)
  })
}

test('Electron graph narrow layout and detail-dialog focus recovery', async ({
  page,
  graphApp
}, info) => {
  await graphApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setContentSize(375, 812)
    window.webContents.setZoomFactor(1)
  })
  await openCitationGraph(page, url)
  await verifyCitationNarrowLayout(page, async (state) => {
    await captureGraph(graphApp, info, `electron-graph-375-${state}`)
  })
  // Reopen with a desktop viewport for the independent keyboard/close journey.
  await page.keyboard.press('Escape')
  await graphApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000)
  })
  await openCitationGraph(page, url)
  await verifyCitationFocusAndClose(page)
})
