import { resolve } from 'node:path'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  expect,
  test as base,
  _electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

type ReplayFixtureWindow = Window & {
  replayFixture: {
    seek: (time: number) => void
    prepare: (mode: string, timeout: number) => void
    reprepare: () => void
  }
  replayReadiness: {
    ready: boolean
    degraded: boolean
    diagnostics: string[]
    frameKey: string
    positionMs: number
  }
}
let server: ViteDevServer
let url: string
const test = base.extend<{ stageApp: ElectronApplication }>({
  // eslint-disable-next-line no-empty-pattern
  stageApp: async ({}, provide) => {
    const userData = await mkdtemp(resolve(tmpdir(), 'research-replay-stage-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'
      )
    )
    let app: ElectronApplication | undefined
    try {
      app = await _electron.launch({
        args: [resolve('e2e/fixtures/replay-stage/electron.mjs')],
        env: { ...env, REPLAY_STAGE_USER_DATA: userData }
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
  page: async ({ stageApp }, provide) => {
    await provide(await stageApp.firstWindow())
  }
})
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: resolve('out/replay-stage-vite'),
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  })
  await server.listen()
  url = `${server.resolvedUrls!.local[0]}e2e/fixtures/replay-stage/index.html`
})
test.afterAll(async () => {
  await server?.close()
})
const seek = async (page: Page, time: number): Promise<void> => {
  await page.evaluate(
    (value) => (window as unknown as ReplayFixtureWindow).replayFixture.seek(value),
    time
  )
  await expect(page.getByTestId('replay-stage')).toHaveAttribute(
    'data-replay-position',
    String(time)
  )
  await expect(page.getByTestId('replay-stage')).toHaveAttribute('data-replay-frame-ready', 'true')
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ReplayFixtureWindow).replayReadiness.positionMs)
    )
    .toBe(time)
}
const chart =
  '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="300"><rect width="560" height="300" fill="white"/><path d="M30 260L280 40L530 200" fill="none" stroke="#167f85" stroke-width="12"/></svg>'

test('independent 1280×720 Stage paints the same frame by sequential advance and direct seek', async ({
  page
}, info) => {
  const unexpectedNetwork: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(new URL(url).origin) && !request.url().startsWith('data:'))
      unexpectedNetwork.push(request.url())
  })
  await page.goto(url)
  await seek(page, 6000)
  const stage = page.getByTestId('replay-stage')
  await expect(stage).toHaveCSS('width', '1280px')
  await expect(stage).toHaveCSS('height', '720px')
  await expect(page.getByText('Mean: 4.50', { exact: false })).toBeVisible()
  await expect(stage.locator('img')).toHaveCount(1)
  expect(
    await stage
      .locator('img')
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 560)
  ).toBe(true)
  const direct = await stage.screenshot({ path: info.outputPath('direct-frame.png'), scale: 'css' })
  for (const time of [0, 1000, 2200, 4000, 6000]) await seek(page, time)
  const sequential = await stage.screenshot({
    path: info.outputPath('sequential-frame.png'),
    scale: 'css'
  })
  expect(sequential.equals(direct)).toBe(true)
  // Theme changes outside the Stage cannot change a frozen export configuration.
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  expect((await stage.screenshot({ scale: 'css' })).equals(direct)).toBe(true)
  expect(await page.evaluate(() => 'api' in window)).toBe(false)
  expect(unexpectedNetwork).toEqual([])
  await info.attach('independent-replay-frame', { body: direct, contentType: 'image/png' })
})

test('waits for real delayed image and font decoding before a capture-ready frame', async ({
  page
}) => {
  let releaseFont!: () => void
  const fontGate = new Promise<void>((resolve) => {
    releaseFont = resolve
  })
  await page.route('**/KaTeX_Main-Regular.woff2', async (route) => {
    await fontGate
    await route.fulfill({
      body: await readFile(resolve('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')),
      contentType: 'font/woff2'
    })
  })
  await page.goto(`${url}?font=1`, { waitUntil: 'domcontentloaded' })
  const stage = page.getByTestId('replay-stage')
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'false')
  expect(await page.evaluate(() => document.fonts.status)).toBe('loading')
  releaseFont()
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'true')
  expect(await page.evaluate(() => document.fonts.check('15px ReplayFixtureFont'))).toBe(true)
  let releaseImage!: () => void
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve
  })
  await page.route('**/replay-delayed.svg', async (route) => {
    await imageGate
    await route.fulfill({ body: chart, contentType: 'image/svg+xml' })
  })
  await page.evaluate(() =>
    (window as unknown as ReplayFixtureWindow).replayFixture.prepare('delayed', 5000)
  )
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'false')
  expect(await stage.locator('img').evaluate((image: HTMLImageElement) => image.complete)).toBe(
    false
  )
  releaseImage()
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'true')
  expect(
    await stage
      .locator('img')
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
  ).toBe(true)
  expect(
    await page.evaluate(() => (window as unknown as ReplayFixtureWindow).replayReadiness.degraded)
  ).toBe(false)
})

test('keeps a timeout placeholder stable until an explicit new preparation', async ({
  page
}, info) => {
  let releaseImage!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseImage = resolve
  })
  await page.route('**/replay-delayed.svg', async (route) => {
    await gate
    await route.fulfill({ body: chart, contentType: 'image/svg+xml' })
  })
  await page.goto(url)
  await seek(page, 6000)
  await page.evaluate(() =>
    (window as unknown as ReplayFixtureWindow).replayFixture.prepare('delayed', 150)
  )
  const stage = page.getByTestId('replay-stage')
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'false')
  await expect(stage.locator('[data-replay-image-missing="plot-v1"]')).toBeVisible()
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'true')
  expect(
    await page.evaluate(
      () => (window as unknown as ReplayFixtureWindow).replayReadiness.diagnostics
    )
  ).toContain('timeout:image:plot-v1')
  const placeholder = await stage.screenshot({ scale: 'css' })
  releaseImage()
  await seek(page, 6200)
  await seek(page, 6000)
  expect((await stage.screenshot({ scale: 'css' })).equals(placeholder)).toBe(true)
  await page.evaluate(() => (window as unknown as ReplayFixtureWindow).replayFixture.reprepare())
  await expect(stage.locator('img')).toHaveCount(1)
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'true')
  expect(await stage.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(
    560
  )
  await info.attach('timeout-placeholder', { body: placeholder, contentType: 'image/png' })
})

test('keeps fixed system-font pixels after a web-font timeout and late arrival', async ({
  page,
  stageApp
}, info) => {
  let releaseFont!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseFont = resolve
  })
  await page.route('**/KaTeX_Main-Regular.woff2', async (route) => {
    await gate
    await route.fulfill({
      body: await readFile(resolve('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2')),
      contentType: 'font/woff2'
    })
  })
  await page.goto(`${url}?font=1&fontTimeout=1`, { waitUntil: 'domcontentloaded' })
  const stage = page.getByTestId('replay-stage')
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'true')
  expect(
    await page.evaluate(
      () => (window as unknown as ReplayFixtureWindow).replayReadiness.diagnostics
    )
  ).toContain('timeout:fonts')
  expect(await stage.evaluate((node) => getComputedStyle(node).fontFamily)).toBe(
    'Arial, sans-serif'
  )
  // Capture immediately after our own readiness barrier; Playwright's screenshot helper adds
  // another unbounded document.fonts.ready wait and cannot exercise this timeout contract.
  const capture = async (): Promise<Buffer> =>
    Buffer.from(
      await stageApp.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
          .toPNG()
          .toString('base64')
      ),
      'base64'
    )
  const before = await capture()
  releaseFont()
  await page.evaluate(() => document.fonts.ready)
  await seek(page, 6100)
  await seek(page, 6000)
  expect((await capture()).equals(before)).toBe(true)
  await info.attach('fixed-font-timeout-frame', { body: before, contentType: 'image/png' })
})

test('large archived history and results keep rendered nodes and material pages bounded', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&large=1`)
  const panel = page.getByTestId('replay-panel')
  const stage = page.getByTestId('replay-stage')
  const started = await page.evaluate(() => performance.now())
  await page.getByLabel('Replay progress', { exact: true }).focus()
  await page.keyboard.press('End')
  await expect(stage).toHaveAttribute('data-replay-position', '2001000')
  await expect(stage).toHaveAttribute('data-replay-frame-ready', 'true')
  const measurement = await stage.evaluate((node) => ({
    nodes: node.querySelectorAll('*').length,
    characters: node.textContent!.length,
    end: performance.now()
  }))
  expect(measurement.nodes).toBeLessThan(12000)
  expect(measurement.characters).toBeLessThan(1_300_000)
  expect(measurement.end - started).toBeLessThan(5000)
  await expect(
    stage.getByText('Preview is truncated. Open the evidence for the complete record.').first()
  ).toBeAttached()
  await panel.getByRole('button', { name: 'View research materials', exact: true }).click()
  await expect(panel.locator('[data-replay-material-item]')).toHaveCount(40)
  await expect(panel.getByText('Page 1 of 76', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(panel.locator('[data-replay-material-item]')).toHaveCount(40)
  await expect(panel.getByText('Page 2 of 76', { exact: true })).toBeVisible()
  await expect(
    panel.getByRole('button', { name: 'observations-0.svg Version 1', exact: true })
  ).toHaveCount(0)
  await panel.getByRole('button', { name: 'Previous page', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: 'observations-0.svg Version 1', exact: true })
  ).toBeVisible()
  const measurementsPath = info.outputPath('large-record-measurements.json')
  await writeFile(
    measurementsPath,
    JSON.stringify(
      {
        steps: 2001,
        versions: 3000,
        outputCharacters: 30_240_000,
        nodes: measurement.nodes,
        visibleCharacters: measurement.characters,
        seekMs: measurement.end - started,
        pageItems: 40
      },
      null,
      2
    )
  )
  await info.attach('large-record-measurements', {
    path: measurementsPath,
    contentType: 'application/json'
  })
})

for (const locale of ['en', 'de']) {
  test(`right-hand panel remains operable at narrow width and expands with keyboard focus (${locale})`, async ({
    page
  }, info) => {
    await page.goto(`${url}?panel=1&locale=${locale}`)
    const panel = page.getByTestId('replay-panel')
    const copy =
      locale === 'de'
        ? {
            play: 'Wiedergabe starten',
            expand: 'Vollbildmodus aktivieren',
            collapse: 'Vollbildmodus beenden',
            materials: 'Forschungsmaterial ansehen',
            close: 'Belege schließen',
            ask: 'Zu diesem Schritt fragen'
          }
        : {
            play: 'Play replay',
            expand: 'Enter full screen',
            collapse: 'Exit full screen',
            materials: 'View research materials',
            close: 'Close evidence',
            ask: 'Ask about this step'
          }
    await expect(panel).toBeVisible()
    expect((await panel.boundingBox())!.width).toBe(419)
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    )
    for (const name of [copy.play, copy.expand, copy.materials, copy.ask]) {
      const button = panel.getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      expect(
        await button.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
      ).toBeGreaterThanOrEqual(12)
      expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(28)
    }
    const materialButton = panel.getByRole('button', { name: copy.materials, exact: true })
    await materialButton.focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('button', { name: copy.close, exact: true })).toBeFocused()
    await expect(panel.getByRole('button', { name: /observations\.svg/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(materialButton).toBeFocused()
    const progress = panel.getByRole('slider')
    await progress.focus()
    await page.keyboard.press('End')
    await expect(progress).toHaveValue('9000')
    const expand = panel.getByRole('button', { name: copy.expand, exact: true })
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('button', { name: copy.collapse, exact: true })).toBeFocused()
    expect((await panel.boundingBox())!.width).toBeGreaterThan(900)
    await expect(progress).toHaveValue('9000')
    await panel.getByRole('button', { name: copy.ask, exact: true }).click()
    await expect(page.getByLabel('Discussion question')).toBeFocused()
    await expect(panel.getByRole('button', { name: copy.expand, exact: true })).toBeVisible()
    await expect(progress).toHaveValue('9000')
    await expect(panel.getByRole('button', { name: copy.play, exact: true })).toBeVisible()
    await info.attach(`narrow-replay-${locale}`, {
      body: await page.screenshot({ scale: 'css' }),
      contentType: 'image/png'
    })
  })
}
