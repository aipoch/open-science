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
  await captureGraph(graphApp, info, 'electron-graph-desktop-initial')
  await verifyCitationDesktopLayout(page)
  await captureGraph(graphApp, info, 'electron-graph-desktop-selected')
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
  const action = frame.getByRole('button', { name: 'Set as center', exact: true })
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
  await expect(frame.locator('[data-citation-paper-list-toggle]')).toHaveAttribute(
    'aria-expanded',
    'false'
  )
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
