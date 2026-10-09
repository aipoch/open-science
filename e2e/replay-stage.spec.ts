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
    const userData = await mkdtemp(resolve(tmpdir(), 'session-replay-stage-'))
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
  page,
  stageApp
}, info) => {
  const graphics = await stageApp.evaluate(({ app }) => app.getGPUFeatureStatus())
  expect(graphics.gpu_compositing).toBe('disabled_software')
  await info.attach('capture-renderer', {
    body: JSON.stringify(graphics, null, 2),
    contentType: 'application/json'
  })
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
  const sameRaster = async (actual: Buffer): Promise<void> => {
    const maximumChannelDifference = await stageApp.evaluate(
      ({ nativeImage }, { actual, expected }) => {
        const left = nativeImage.createFromDataURL(`data:image/png;base64,${actual}`).toBitmap()
        const right = nativeImage.createFromDataURL(`data:image/png;base64,${expected}`).toBitmap()
        if (left.length !== right.length) return 255
        let maximum = 0
        for (let i = 0; i < left.length; i++)
          maximum = Math.max(maximum, Math.abs(left[i] - right[i]))
        return maximum
      },
      { actual: actual.toString('base64'), expected: direct.toString('base64') }
    )
    // Skia can round an antialiased corner by one 8-bit level after a scroll repaint.
    // Every pixel must still match; no shifted edges or missing content are tolerated.
    expect(maximumChannelDifference).toBeLessThanOrEqual(1)
  }
  await sameRaster(sequential)
  // Theme changes outside the Stage cannot change a frozen export configuration.
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await sameRaster(await stage.screenshot({ scale: 'css' }))
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
  await writeFile(info.outputPath('font-timeout-before.png'), before)
  releaseFont()
  await page.evaluate(() => document.fonts.ready)
  await seek(page, 6100)
  await seek(page, 6000)
  const after = await capture()
  await writeFile(info.outputPath('font-timeout-after.png'), after)
  expect(after.equals(before)).toBe(true)
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
  await panel.getByRole('button', { name: 'Notebook', exact: true }).click()
  const material = panel.getByRole('region', { name: 'Research materials' })
  await expect(material.getByRole('combobox')).toHaveCount(0)
  await panel.getByRole('button', { name: 'View files', exact: true }).click()
  const catalog = panel.getByRole('complementary', { name: 'Files', exact: true })
  const materialBox = (await material.boundingBox())!
  const catalogBox = (await catalog.boundingBox())!
  expect(
    Math.abs(catalogBox.y + catalogBox.height - materialBox.y - materialBox.height + 8)
  ).toBeLessThanOrEqual(1)
  expect(catalogBox.width).toBeLessThanOrEqual(320)
  expect(
    await catalog
      .locator('[data-replay-files-scroll]')
      .evaluate((node) => node.scrollHeight > node.clientHeight)
  ).toBe(true)
  await expect(catalog.locator('[data-replay-material-item]')).toHaveCount(40)
  await expect(catalog.getByText('Page 1 of 75', { exact: true })).toBeVisible()
  await catalog.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(catalog.locator('[data-replay-material-item]')).toHaveCount(40)
  await expect(catalog.getByText('Page 2 of 75', { exact: true })).toBeVisible()
  await expect(
    catalog.getByRole('button', { name: 'observations-0.svg Version 1', exact: true })
  ).toHaveCount(0)
  await catalog.getByRole('button', { name: 'Previous page', exact: true }).click()
  await expect(
    catalog.getByRole('button', { name: 'observations-0.svg Version 1', exact: true })
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
    await page.goto(`${url}?panel=1&research=1&locale=${locale}`)
    const panel = page.getByTestId('replay-panel')
    const copy =
      locale === 'de'
        ? {
            play: 'Wiedergabe starten',
            rewatch: 'Erneut ansehen',
            expand: 'Vorschau erweitern',
            collapse: 'Vorschau verkleinern',
            materials: 'Notebook',
            close: 'Ursprüngliche Konversation',
            ask: 'Zu diesem Eintrag fragen'
          }
        : {
            play: 'Play replay',
            rewatch: 'Watch again',
            expand: 'Expand preview',
            collapse: 'Collapse preview',
            materials: 'Notebook',
            close: 'Original conversation',
            ask: 'Ask about this record'
          }
    await expect(panel).toBeVisible()
    expect((await panel.boundingBox())!.width).toBe(419)
    expect((await panel.getByTestId('replay-header').boundingBox())!.height).toBeLessThanOrEqual(44)
    const information = panel.getByTestId('replay-information-trigger')
    await information.focus()
    await page.keyboard.press('Enter')
    const popover = page.getByRole('dialog', { name: 'A reproducible observation study' })
    await expect(popover).toBeVisible()
    await expect(popover.getByText('original-project', { exact: true })).not.toBeVisible()
    await popover
      .locator('summary')
      .filter({ hasText: locale === 'de' ? 'Technische Details' : 'Technical details' })
      .click()
    await expect(popover.getByText('original-project', { exact: true })).toBeVisible()
    await expect(popover.getByText('original-session', { exact: true })).toBeVisible()
    const bounds = (await popover.boundingBox())!
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    await popover.screenshot({ path: info.outputPath(`replay-information-${locale}.png`) })
    await page.keyboard.press('Escape')
    await expect(popover).not.toBeVisible()
    await expect(information).toBeFocused()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true
    )
    for (const name of [copy.play, copy.expand, copy.ask]) {
      const button = panel.getByRole('button', { name, exact: true })
      await expect(button).toBeVisible()
      expect(
        await button.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
      ).toBeGreaterThanOrEqual(12)
      expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(28)
    }
    const materialButton = panel.getByRole('tab', { name: copy.materials, exact: true })
    await materialButton.focus()
    await page.keyboard.press('Enter')
    const catalog = panel.getByRole('region', { name: 'Notebook', exact: true })
    await expect(materialButton).toBeFocused()
    await expect(materialButton).toHaveAttribute('aria-selected', 'true')
    await expect(catalog).toBeVisible()
    await panel.getByRole('slider').focus()
    await page.keyboard.press('End')
    await expect(catalog.locator('[data-replay-notebook-run]')).toBeVisible()
    await panel.getByRole('tab', { name: copy.close, exact: true }).click()
    await expect(panel.getByRole('tab', { name: copy.close, exact: true })).toBeFocused()
    const progress = panel.getByRole('slider')
    await progress.focus()
    await page.keyboard.press('End')
    await expect(progress).toHaveAttribute('aria-valuenow', '9000')
    const expand = panel.getByRole('button', { name: copy.expand, exact: true })
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByRole('button', { name: copy.collapse, exact: true })).toBeFocused()
    expect((await panel.boundingBox())!.width).toBeGreaterThan(900)
    await expect(progress).toHaveAttribute('aria-valuenow', '9000')
    await panel.getByRole('button', { name: copy.ask, exact: true }).click()
    await expect(page.getByLabel('Discussion question')).toBeFocused()
    await expect(panel.getByRole('button', { name: copy.expand, exact: true })).toBeVisible()
    await expect(progress).toHaveAttribute('aria-valuenow', '9000')
    await expect(panel.getByRole('button', { name: copy.rewatch, exact: true })).toBeVisible()
    await info.attach(`narrow-replay-${locale}`, {
      body: await page.screenshot({ scale: 'css' }),
      contentType: 'image/png'
    })
  })
}

test('generated files reuse type icons and return to the archived Files list at the exact version', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  const progress = panel.getByRole('slider')
  await progress.focus()
  await page.keyboard.press('End')
  const conversation = panel.getByRole('region', { name: 'Historical conversation' })
  const material = panel.getByRole('region', { name: 'Research materials' })
  const original = conversation.getByRole('button', {
    name: 'Preview generated file observations.svg (Version 1)',
    exact: true
  })
  await expect(conversation.getByText('GENERATED · 2', { exact: true })).toHaveCount(1)
  const generated = conversation.getByRole('button', { name: /^Preview generated file/ })
  const bounds = await generated.evaluateAll((nodes) =>
    nodes.map((node) => ({
      top: node.getBoundingClientRect().top,
      left: node.getBoundingClientRect().left
    }))
  )
  expect(bounds[0].top).toBe(bounds[1].top)
  expect(bounds[1].left).toBeGreaterThan(bounds[0].left)
  await expect(original.locator('img')).toBeVisible()
  await expect(original.locator('[data-slot="generated-artifact-open-icon"]')).toHaveCount(1)
  await expect(original.getByTestId('file-name-extension')).toHaveText('.svg')
  await original.scrollIntoViewIfNeeded()
  const originalScroll = await conversation.evaluate((node) => node.scrollTop)
  await original.click()
  await expect(conversation).not.toBeVisible()
  await expect(material.locator('[data-replay-artifact-version="version-1"] img')).toBeVisible()
  await expect(material.locator('[data-replay-artifact-version="version-2"]')).toHaveCount(0)
  await expect(panel.getByRole('tablist')).toHaveCount(0)
  await expect(progress).toHaveAttribute('aria-valuenow', '11000')
  await panel.screenshot({ path: info.outputPath('replay-file-breadcrumb.png') })
  await material.getByRole('button', { name: 'Back to conversation', exact: true }).click()
  await expect(conversation).toBeVisible()
  await expect(original).toBeFocused()
  await expect(progress).toHaveAttribute('aria-valuenow', '11000')
  await expect.poll(() => conversation.evaluate((node) => node.scrollTop)).toBe(originalScroll)
  await original.click()
  await material.getByRole('button', { name: 'Close preview', exact: true }).click()
  await expect(original).toBeFocused()
  await panel.getByRole('button', { name: 'View files', exact: true }).click()
  const file = panel.getByRole('button', { name: 'observations.svg Version 1', exact: true })
  await expect(file).toBeVisible()
  await panel.getByRole('button', { name: 'Close files' }).click()
  await expect(panel.getByRole('button', { name: 'View files', exact: true })).toBeFocused()
  await expect(page.locator('[data-selected-evidence]')).toHaveAttribute(
    'data-selected-evidence',
    ''
  )
})

test('one inline material pane follows reached records without a scope switch or catalog popup', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  const trigger = panel.getByRole('button', { name: 'Notebook', exact: true })
  const initialHeight = (await panel.getByTestId('replay-stage').boundingBox())!.height
  await trigger.click()
  const material = panel.getByRole('region', { name: 'Research materials' })
  await expect(material.getByText('No materials at this point.', { exact: true })).toBeVisible()
  await expect(material.getByRole('button', { name: 'Close research materials' })).toBeVisible()
  await expect(material.getByRole('heading', { name: 'Notebook' })).toBeVisible()
  await expect(material.getByRole('combobox')).toHaveCount(0)
  await material.screenshot({ path: info.outputPath('replay-materials-empty.png') })
  await expect(material.locator('[data-replay-notebook-run]')).toHaveCount(0)
  await material.getByRole('button', { name: 'Jump to first material' }).click()
  await expect(material.locator('[data-replay-notebook-run]')).toBeVisible()
  await expect(material.getByText('No materials at this point.')).toHaveCount(0)
  await panel.getByRole('slider').focus()
  await page.keyboard.press('End')
  await expect(material.locator('[data-replay-notebook-run]')).toBeVisible()
  expect((await panel.getByTestId('replay-stage').boundingBox())!.height).toBe(initialHeight)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await panel.getByRole('button', { name: 'View files', exact: true }).click()
  await panel.getByRole('button', { name: 'observations.svg Version 2', exact: true }).click()
  await expect(material.locator('[data-replay-artifact-version="version-2"] img')).toBeVisible()
  await expect(material).toBeFocused()
  await expect(panel.getByRole('slider')).toHaveAttribute('aria-valuenow', '11000')
  await material.getByRole('button', { name: 'Back to files', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: 'observations.svg Version 2', exact: true })
  ).toBeFocused()
  await expect(material.getByRole('combobox')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('replay-archive-inline.png') })
  await panel.getByRole('slider').focus()
  await page.keyboard.press('Home')
  await expect(material.getByText('No materials at this point.', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Close files' }).click()
  await material.focus()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(material).not.toBeVisible()
})

test('Files floats independently in narrow panels and forms a third column in wide replay', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  const material = panel.getByRole('region', { name: 'Research materials' })
  const conversation = panel.getByRole('region', { name: 'Historical conversation' })
  const files = panel.getByRole('complementary', { name: 'Files' })
  await panel.getByRole('slider').focus()
  await page.keyboard.press('End')
  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  await expect(material).toBeVisible()
  await expect(conversation).toBeVisible()
  await expect(files).toBeVisible()
  const left = (await conversation.boundingBox())!
  const middle = (await material.boundingBox())!
  expect(
    (await panel.getByRole('button', { name: 'Browse steps', exact: true }).boundingBox())!.width
  ).toBeLessThanOrEqual(576)
  const right = (await files.boundingBox())!
  expect(middle.x).toBe(left.x + left.width)
  expect(right.x).toBe(middle.x + middle.width)
  expect(right.width).toBe(256)
  await panel.screenshot({ path: info.outputPath('replay-three-columns.png') })
  const file = files.getByRole('button', { name: 'observations.svg Version 2', exact: true })
  await file.click()
  await expect(file).toHaveAttribute('aria-current', 'true')
  await expect(conversation).not.toBeVisible()
  expect((await material.boundingBox())!.width).toBeGreaterThan(middle.width)
  await panel.screenshot({ path: info.outputPath('replay-wide-file-preview.png') })
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click()
  await expect(conversation).toBeVisible()
  await files.getByRole('button', { name: 'Close files' }).click()
  await material.getByRole('button', { name: 'Close research materials' }).click()
  await panel.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  await expect(files).toBeVisible()
  await expect(material).toBeVisible()
  const notebookTitle = (await material.getByRole('heading', { name: 'Notebook' }).boundingBox())!
  const filesTitle = (await files.getByRole('heading', { name: 'Files' }).boundingBox())!
  expect(notebookTitle.y).toBe(filesTitle.y)
  expect(notebookTitle.height).toBe(filesTitle.height)
  await files.getByRole('button', { name: 'Close files' }).click()
  await material.getByRole('button', { name: 'Close research materials' }).click()
  for (const width of [320, 375, 414, 768, 960, 1100]) {
    await panel.evaluate((element, width) => {
      const container = element.closest('[data-replay-container]') as HTMLElement
      container.style.inset = '0'
      container.style.width = `${width}px`
    }, width)
    await expect(material).not.toBeVisible()
    const notebookButton = panel.getByRole('button', { name: 'Notebook', exact: true })
    const filesButton = panel.getByRole('button', { name: 'View files', exact: true })
    await notebookButton.hover()
    const tip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Notebook' })
    await expect(tip).toBeVisible()
    await expect(tip).toHaveAttribute('data-side', 'bottom')
    const buttonBox = (await notebookButton.boundingBox())!
    const tipBox = (await tip.boundingBox())!
    expect(tipBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height)
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(width)
    await notebookButton.click()
    await filesButton.click()
    await expect(files).toBeVisible()
    await expect(material).toBeVisible()
    const paneBox = (await material.boundingBox())!
    const floatBox = (await files.boundingBox())!
    expect(floatBox.width).toBeLessThanOrEqual(Math.min(320, width - 16))
    expect(floatBox.x).toBeGreaterThan(paneBox.x)
    const scrollTop = await material
      .locator('[data-replay-notebook-scroll]')
      .evaluate((node) => node.scrollTop)
    await panel.screenshot({ path: info.outputPath(`replay-files-floating-${width}.png`) })
    const file = files.getByRole('button', { name: 'observations.svg Version 2', exact: true })
    await file.click()
    await expect(files).not.toBeVisible()
    await expect(material.locator('[data-replay-artifact-version="version-2"] img')).toBeVisible()
    await material.getByRole('button', { name: 'Back to files', exact: true }).click()
    await expect(file).toBeFocused()
    expect(
      await material.locator('[data-replay-notebook-scroll]').evaluate((node) => node.scrollTop)
    ).toBe(scrollTop)
    await page.keyboard.press('Escape')
    await expect(filesButton).toBeFocused()
    await expect(files).not.toBeVisible()
    await expect(material).toBeVisible()
    await material.getByRole('button', { name: 'Close research materials' }).click()
    await expect(notebookButton).toBeFocused()
    await page.mouse.move(0, 800)
    await expect(tip).not.toBeVisible()
  }
})

test('keeps chrome and conversation width stable through tool and Agent message transitions', async ({
  page
}) => {
  await page.goto(`${url}?panel=1&research=1&transitions=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: 'Expand preview', exact: true }).click()
  const header = panel.getByTestId('replay-header')
  const material = panel.getByRole('tabpanel')
  const controls = panel.getByTestId('replay-controls')
  const transcript = panel.getByRole('region', { name: 'Historical conversation' })
  const initial = await Promise.all([
    header.boundingBox(),
    material.boundingBox(),
    controls.boundingBox(),
    transcript.boundingBox()
  ])
  const stableNodes = await page.evaluateHandle(() => [
    ...document.querySelectorAll(
      '[data-testid="replay-header"], [role="tabpanel"], [data-testid="replay-controls"]'
    )
  ])
  await panel.getByRole('combobox', { name: 'Playback speed' }).click()
  await page.getByRole('option', { name: '1×', exact: true }).click()
  const progress = panel.getByRole('slider')
  await progress.focus()
  // Real playback covers input -> tool -> output -> agent, including async material readiness.
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  const samples = await page.evaluate(async () => {
    const result = []
    const started = performance.now()
    while (performance.now() - started < 8300) {
      await new Promise(requestAnimationFrame)
      const pauseIcon = document.querySelector(
        '[data-testid="replay-controls"] button[aria-label="Pause replay"] .lucide-pause'
      )
      if (!pauseIcon) throw new Error('Playback action changed while advancing between steps')
      const selectors = [
        '[data-testid="replay-header"]',
        '[role="tabpanel"]',
        '[data-testid="replay-controls"]',
        '[aria-label="Historical conversation"]'
      ]
      result.push(
        selectors.map((selector) => {
          const node = document.querySelector(selector)
          if (!node) throw new Error(`Replay surface missing: ${selector}`)
          const box = node.getBoundingClientRect()
          return { x: box.x, y: box.y, width: box.width, height: box.height }
        })
      )
    }
    return result
  })
  // Pause before checking hundreds of samples so assertion time cannot finish playback.
  await panel.getByRole('button', { name: 'Pause replay', exact: true }).click()
  for (const sample of samples) {
    for (let index = 0; index < sample.length; index++) {
      expect(sample[index]).toEqual(initial[index])
    }
  }
  expect(await stableNodes.evaluate((nodes) => nodes.every((node) => node.isConnected))).toBe(true)
  await expect(transcript).toBeVisible()
  const scroll = await transcript.evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight
  }))
  expect(scroll.max - scroll.top).toBeLessThan(3)
  await transcript.hover()
  await page.mouse.wheel(0, -200)
  await expect
    .poll(() => transcript.evaluate((node) => node.scrollTop))
    .toBeLessThan(scroll.top - 50)
})

test('completion is a plain status without resizing content and replay can restart', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&research=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 850 })
    await panel.evaluate((element, width) => {
      const container = element.closest('[data-replay-container]') as HTMLElement
      container.style.position = 'fixed'
      container.style.inset = '0'
      container.style.width = `${width}px`
    }, width)
    const progress = panel.getByRole('slider')
    await progress.focus()
    await page.keyboard.press('Home')
    const controls = panel.getByTestId('replay-controls')
    const conversation = panel.getByRole('region', { name: 'Historical conversation' })
    const before = await Promise.all([controls.boundingBox(), conversation.boundingBox()])
    await page.keyboard.press('End')
    await expect(panel.getByRole('button', { name: 'Watch again', exact: true })).toBeVisible()
    expect(await Promise.all([controls.boundingBox(), conversation.boundingBox()])).toEqual(before)
    const completed = panel.getByText('Completed', { exact: true })
    await expect(completed).toBeVisible()
    expect(await completed.evaluate((node) => node.closest('button'))).toBeNull()
    await expect(
      page.getByRole('dialog', { name: 'Replay complete', exact: true })
    ).not.toBeVisible()
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: info.outputPath(`replay-completion-${width}.png`) })
    await panel.getByRole('button', { name: 'Watch again', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Pause replay', exact: true }).click()
    expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThan(11000)
  }
})

test('long generated filenames preserve the extension beside the image icon and separate version metadata', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1&longName=1`)
  const panel = page.getByTestId('replay-panel')
  await page.setViewportSize({ width: 320, height: 850 })
  await panel.evaluate((element) => {
    const container = element.closest('[data-replay-container]') as HTMLElement
    container.style.position = 'fixed'
    container.style.inset = '0'
  })
  await panel.getByRole('slider').focus()
  await page.keyboard.press('End')
  // Adjacent generated versions share one gallery; select the immutable version, not its old step.
  const card = panel.getByRole('button', { name: /^Preview generated file .* \(Version 1\)$/ })
  await expect(card.locator('img')).toBeVisible()
  await expect(card.getByTestId('file-name-extension')).toHaveText('.png')
  const extension = (await card.getByTestId('file-name-extension').boundingBox())!
  await expect(card).toHaveAttribute('title', /Version 1/)
  expect(extension.x + extension.width).toBeLessThanOrEqual(320)
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await panel.screenshot({ path: info.outputPath('replay-generated-long-file.png') })
  await card.click()
  await expect(panel.getByRole('button', { name: 'Back to conversation' })).toBeVisible()
  const preview = panel.locator('[data-replay-artifact-version="version-1"]')
  await expect(preview.locator('.lucide-file-image')).toBeVisible()
  await expect(preview.getByTestId('file-name-extension')).toHaveText('.png')
  expect(await preview.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
})

test('Files opens over the conversation without opening Notebook and closes independently', async ({
  page
}) => {
  await page.goto(`${url}?panel=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('slider').focus()
  await page.keyboard.press('End')
  const notebook = panel.getByRole('button', { name: 'Notebook', exact: true })
  const trigger = panel.getByRole('button', { name: 'View files', exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const files = panel.getByRole('complementary', { name: 'Files' })
  await expect(files).toBeFocused()
  await expect(notebook).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.getByRole('region', { name: 'Historical conversation' })).toBeVisible()
  const row = files.getByRole('button', { name: 'observations.svg Version 2', exact: true })
  await row.click()
  await panel.getByRole('button', { name: 'Back to files', exact: true }).click()
  await expect(row).toBeFocused()
  await expect(notebook).toHaveAttribute('aria-expanded', 'false')
  await files.getByRole('button', { name: 'Close files' }).click()
  await expect(trigger).toBeFocused()
  await expect(files).not.toBeVisible()
  await expect(panel.getByRole('slider')).toHaveAttribute('aria-valuenow', '11000')
})

test('wide Notebook follows playback, preserves manual scrolling and respects collapsed records', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&followNotebook=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  const material = panel.getByRole('region', { name: 'Research materials' })
  const notebookScroll = material.locator('[data-replay-notebook-scroll]')
  const progress = panel.getByRole('slider')
  const headerBefore = await panel.getByTestId('replay-header').boundingBox()
  const controlsBefore = await panel.getByTestId('replay-controls').boundingBox()
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expect(material.locator('[data-replay-notebook-run]')).toBeVisible()
  const initialTop = await notebookScroll.evaluate((node) => node.scrollTop)
  await expect
    .poll(() => notebookScroll.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(initialTop + 150)
  await notebookScroll.hover()
  // Playback can advance while Playwright moves the pointer. Measure at the wheel boundary,
  // before the native scroll, rather than comparing against an earlier playback frame.
  await notebookScroll.evaluate((node) => {
    node.addEventListener(
      'wheel',
      () => {
        node.setAttribute('data-wheel-start', String(node.scrollTop))
      },
      { once: true }
    )
  })
  await page.mouse.wheel(0, -100)
  await expect(panel.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
  await expect(notebookScroll).toHaveAttribute('data-wheel-start', /^\d+(?:\.\d+)?$/)
  const followingTop = Number(await notebookScroll.getAttribute('data-wheel-start'))
  await expect
    .poll(() => notebookScroll.evaluate((node) => node.scrollTop))
    .toBeLessThan(followingTop - 40)
  const pausedTime = await progress.getAttribute('aria-valuenow')
  const manualTop = await notebookScroll.evaluate((node) => node.scrollTop)
  await page.waitForTimeout(250)
  expect(await notebookScroll.evaluate((node) => node.scrollTop)).toBe(manualTop)
  await expect(progress).toHaveAttribute('aria-valuenow', pausedTime!)
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expect
    .poll(() => notebookScroll.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(manualTop + 60)
  await panel.getByRole('button', { name: 'Pause replay', exact: true }).click()
  await material.getByRole('button', { name: 'Close research materials' }).click()
  await expect(material.locator('[data-replay-notebook-run]')).not.toBeVisible()
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  await page.waitForTimeout(250)
  await expect(material.locator('[data-replay-notebook-run]')).not.toBeVisible()
  expect(await panel.getByTestId('replay-header').boundingBox()).toEqual(headerBefore)
  expect(await panel.getByTestId('replay-controls').boundingBox()).toEqual(controlsBefore)
  await panel.screenshot({ path: info.outputPath('replay-notebook-follow.png') })
})

test('archived branches retain progress and show Reviewer and submitted choices without live actions', async ({
  page
}, info) => {
  await page.goto(`${url}?panel&branchesReview`)
  const progress = page.getByRole('slider', { name: 'Replay progress' })
  await progress.focus()
  await progress.press('End')
  const originalPosition = await progress.getAttribute('aria-valuenow')
  const original = page.locator('[data-replay-review="review-original"]')
  await expect(original).toBeVisible()
  await original.getByTestId('tool-group-header').click()
  await expect(original.getByText('Sample size is limited')).toBeVisible()
  await expect(
    original.getByText('Recorded review. No new review is run during replay.')
  ).toBeVisible()
  await expect(page.getByText('Recorded file version', { exact: true })).toHaveCount(0)
  const choice = page.getByTestId('elicitation-answer-summary')
  await expect(choice).toContainText('R analysis')
  await page.getByTestId('elicitation-answer-row').click()
  await expect(page.getByText('Python analysis', { exact: true })).toBeVisible()
  await expect(page.getByText('Reviewer requested corrections', { exact: true })).toBeVisible()
  await expect(page.locator('[data-replay-container] form')).toHaveCount(0)
  const branches = page.getByRole('combobox', { name: 'Replay branch' })
  expect((await branches.boundingBox())!.width).toBe(32)
  await expect(branches.locator('svg.lucide-git-branch')).toBeVisible()
  const triggerBounds = (await branches.boundingBox())!
  await branches.focus()
  await branches.press('Enter')
  const branchMenu = page.getByRole('listbox')
  await expect(branchMenu).toBeVisible()
  await expect(page.getByRole('option', { name: /Branch 1/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  const menuBounds = (await branchMenu.boundingBox())!
  expect(
    Math.abs(menuBounds.x + menuBounds.width - triggerBounds.x - triggerBounds.width)
  ).toBeLessThanOrEqual(2)
  await branchMenu.screenshot({ path: info.outputPath('replay-branch-menu.png') })
  await page.keyboard.press('Escape')
  await expect(branchMenu).toHaveCount(0)
  await expect(branches).toBeFocused()
  await branches.click()
  await page.getByRole('option', { name: /Branch 2/ }).click()
  await progress.focus()
  await progress.press('End')
  await expect(
    page.getByTestId('replay-stage').getByText('Alternative branch uses Python.', { exact: true })
  ).toBeVisible()
  await expect(original).toHaveCount(0)
  await expect(choice).toHaveCount(0)
  await branches.click()
  await page.getByRole('option', { name: /Branch 1/ }).click()
  await expect(progress).toHaveAttribute('aria-valuenow', originalPosition!)
  await expect(page.getByRole('button', { name: 'Pause replay', exact: true })).toHaveCount(0)
  await original.getByTestId('tool-group-header').click()
  for (const width of [320, 375, 414, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('[data-replay-container]')).toBeVisible()
    expect(
      await page
        .locator('[data-replay-container]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true)
  }
  await page.getByRole('button', { name: 'Enter full screen' }).click()
  await expect(original.getByText('Sample size is limited')).toBeVisible()
  await page.screenshot({ path: info.outputPath('replay-branches-reviewer.png') })
})

test('step details expose original records without a dedicated evidence toolbar or moving playback', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1&detailIssue=1`)
  const panel = page.getByTestId('replay-panel')
  const progress = panel.getByRole('slider')
  const position = await progress.getAttribute('aria-valuenow')
  await expect(panel.getByRole('button', { name: 'View step evidence', exact: true })).toHaveCount(
    0
  )
  const steps = panel.getByRole('button', { name: 'Browse steps', exact: true })
  await steps.click()
  const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
  const row = directory.getByRole('listitem').first()
  const details = row.getByRole('button', { name: 'Details for step 1', exact: true })
  await details.hover()
  await expect(page.getByRole('tooltip')).toHaveText('View details')
  await details.focus()
  await page.keyboard.press('Enter')
  await expect(directory.getByText(/^Recorded time:/)).toBeVisible()
  await directory.getByRole('button', { name: 'Open original evidence', exact: true }).click()
  await expect(page.locator('[data-selected-evidence]')).not.toHaveAttribute(
    'data-selected-evidence',
    ''
  )
  await expect(progress).toHaveAttribute('aria-valuenow', position!)
  await page.screenshot({ path: info.outputPath('replay-step-details.png') })
  await expect(directory).not.toBeVisible()
  await expect(steps).toBeFocused()
})

test('step detail actions fit narrow widths with long translated copy', async ({ page }, info) => {
  const { renderer: copy } = JSON.parse(await readFile('src/shared/i18n/locales/fr.json', 'utf8'))
  await page.goto(`${url}?panel=1&artifacts=1&locale=fr&detailIssue=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: copy['Browse steps'], exact: true }).click()
  const directory = page.getByRole('dialog', { name: copy['Browse steps'], exact: true })
  const row = directory.getByRole('listitem').first()
  await row
    .getByRole('button', {
      name: copy['Details for step {{step}}'].replace('{{step}}', '1'),
      exact: true
    })
    .click()
  const action = directory.getByRole('button', {
    name: copy['Open original evidence'],
    exact: true
  })
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 850 })
    await page.locator('[data-replay-container]').evaluate((node, width) => {
      const container = node as HTMLElement
      container.style.width = `${width}px`
      container.style.maxWidth = '100%'
    }, width)
    await expect(action).toBeVisible()
    expect(await directory.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    const text = action.locator('span')
    expect(await text.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(24)
    if (width === 375)
      await page.screenshot({ path: info.outputPath('replay-step-details-fr.png') })
  }
})

test('chapter rail previews and seeks while adjacent sections and Ask retain playback context', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  const progress = panel.getByRole('slider', { name: 'Replay progress' })
  await progress.focus()
  await page.keyboard.press('ArrowRight')
  await expect(progress).toHaveAttribute('aria-valuenow', '5000')
  await page.keyboard.press('ArrowLeft')
  await expect(progress).toHaveAttribute('aria-valuenow', '0')
  const stage = panel.getByTestId('replay-stage')
  const browse = panel.getByRole('button', { name: 'Browse steps', exact: true })
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 850 })
    await page.locator('[data-replay-container]').evaluate((node, width) => {
      Object.assign((node as HTMLElement).style, { width: `${width}px`, maxWidth: '100%' })
    }, width)
    const railBefore = (await panel.getByTestId('replay-progress-track').boundingBox())!
    const oldPosition = await progress.getAttribute('aria-valuenow')
    await page.mouse.move(
      railBefore.x + railBefore.width * 0.25,
      railBefore.y + railBefore.height / 2
    )
    await expect(page.getByTestId('replay-seek-preview')).toContainText(
      'Analyze the saved observations'
    )
    await expect(progress).toHaveAttribute('aria-valuenow', oldPosition!)
    await page.mouse.click(
      railBefore.x + railBefore.width * 0.25,
      railBefore.y + railBefore.height / 2
    )
    expect(Number(await progress.getAttribute('aria-valuenow'))).toBeCloseTo(2750, -1)
    await expect(browse).toContainText('Analyze the saved observations')
    await panel.getByRole('button', { name: 'Next step', exact: true }).click()
    await expect(progress).toHaveAttribute('aria-valuenow', '7000')
    await panel.getByRole('button', { name: 'Previous step', exact: true }).click()
    await expect(progress).toHaveAttribute('aria-valuenow', '2000')
    const ask = panel.getByRole('button', { name: 'Ask about this step', exact: true })
    expect((await ask.boundingBox())!.y).toBe((await browse.boundingBox())!.y)
    await ask.click()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { discussionCapture: { stepId: string } }).discussionCapture.stepId
      )
    ).toBe('analysis')
    await expect(progress).toHaveAttribute('aria-valuenow', '2000')
    if (width === 375)
      await panel.screenshot({ path: info.outputPath('replay-chapter-rail-375.png') })
    const before = await stage.boundingBox()
    await browse.click()
    const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
    await expect(directory).toBeVisible()
    expect(await stage.boundingBox()).toEqual(before)
    expect(await directory.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    if (width === 375) await page.screenshot({ path: info.outputPath('replay-chapters-375.png') })
    await directory.getByRole('button', { name: /^Go to step 3:/ }).click()
    await expect(progress).toHaveAttribute('aria-valuenow', '7000')
    await expect(browse).toBeFocused()
    const rail = await panel.getByTestId('replay-progress-track').boundingBox()
    if (!rail) throw new Error('Missing progress track')
    await page.mouse.move(rail.x + rail.width * 0.65, rail.y + rail.height / 2)
    await page.mouse.down()
    await page.mouse.move(rail.x + rail.width * 0.4, rail.y + rail.height / 2, { steps: 5 })
    await page.mouse.up()
    const value = Number(await progress.getAttribute('aria-valuenow'))
    expect(value).toBeGreaterThan(4000)
    expect(value).toBeLessThan(4800)
    await progress.focus()
    await page.keyboard.press('Home')
    await expect(progress).toHaveAttribute('aria-valuenow', '0')
    await page.keyboard.press('End')
    await expect(progress).toHaveAttribute('aria-valuenow', '11000')
  }
  await panel.getByRole('button', { name: 'Enter full screen' }).click()
  const before = await stage.boundingBox()
  await browse.click()
  const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
  await expect(directory).toBeVisible()
  expect(await stage.boundingBox()).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(directory).not.toBeVisible()
})

test('dense chapter rail keeps the directory exact without separate tiny targets', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&large=1&detailIssue=1`)
  const panel = page.getByTestId('replay-panel')
  const timeline = panel.getByTestId('replay-timeline')
  const breaks = panel.locator('[data-replay-chapter-break]')
  await expect(breaks.first()).toBeAttached()
  expect(await breaks.count()).toBeLessThanOrEqual(
    Math.floor((await timeline.boundingBox())!.width / 8)
  )
  await expect(timeline.getByRole('button')).toHaveCount(0)
  await expect(timeline.getByRole('slider')).toHaveCount(1)
  await panel.getByRole('button', { name: 'Next step', exact: true }).click()
  await expect(panel.getByRole('slider')).toHaveAttribute('aria-valuenow', '1000')
  await panel.getByRole('button', { name: 'Browse steps', exact: true }).click()
  const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
  await expect(directory.getByRole('listitem')).toHaveCount(40)
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 850 })
    const details = directory.getByRole('button', { name: 'Details for step 2', exact: true })
    const buttonBox = (await details.boundingBox())!
    const listBox = (await directory.getByRole('list').boundingBox())!
    expect(listBox.x + listBox.width - buttonBox.x - buttonBox.width).toBeGreaterThanOrEqual(12)
    // Exercise the button's right edge, where an overlay scrollbar used to intercept it.
    await details.click({ position: { x: buttonBox.width - 2, y: buttonBox.height / 2 } })
    await expect(
      directory.getByRole('button', { name: 'Open original evidence', exact: true })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(details).toBeFocused()
    if (width === 375)
      await page.screenshot({ path: info.outputPath('replay-step-scrollbar-375.png') })
  }
  await directory.getByRole('button', { name: /^Go to step 3:/ }).click()
  await expect(panel.getByRole('slider')).toHaveAttribute('aria-valuenow', '2000')
  await expect(directory).not.toBeVisible()
  await page.screenshot({ path: info.outputPath('replay-chapter-rail-dense.png') })
})

test('archived output reuses Notebook collapse and keeps long console tables inside its scroller', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&longOutput=1`)
  const panel = page.getByTestId('replay-panel')
  await page.setViewportSize({ width: 375, height: 850 })
  await panel.getByRole('slider').focus()
  await page.keyboard.press('End')
  await panel.getByRole('button', { name: 'Notebook', exact: true }).click()
  const material = panel.getByRole('region', { name: 'Research materials' })
  const output = material.getByTestId('notebook-text-output')
  await expect(output).toBeVisible()
  await output.scrollIntoViewIfNeeded()
  const pre = output.locator('pre')
  const bounds = await pre.evaluate((node) => ({
    height: node.clientHeight,
    vertical: node.scrollHeight > node.clientHeight,
    horizontal: node.scrollWidth > node.clientWidth,
    whiteSpace: getComputedStyle(node).whiteSpace,
    scrollbarWidth: getComputedStyle(node).scrollbarWidth
  }))
  expect(bounds.height).toBeLessThanOrEqual(256)
  expect(bounds.vertical).toBe(true)
  expect(bounds.horizontal).toBe(true)
  expect(bounds.whiteSpace).toBe('pre')
  expect(bounds.scrollbarWidth).toBe('none')
  const code = material.locator('[data-testid="session-notebook-cell"] .overflow-auto').first()
  expect(await code.evaluate((node) => getComputedStyle(node).scrollbarWidth)).toBe('thin')
  await pre.evaluate((node) => {
    node.scrollLeft = 100
    node.scrollTop = 100
  })
  expect(await pre.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)
  await output.locator('summary').click()
  await expect(pre).not.toBeVisible()
  await expect(output.getByText('Show output')).toBeVisible()
  await output.locator('summary').click()
  await expect(pre).toBeVisible()
  await panel.screenshot({ path: info.outputPath('replay-notebook-output-375.png') })
})

test('file Back returns to its materials origin with output state, scroll and playback position intact', async ({
  page
}) => {
  await page.goto(`${url}?panel=1&artifacts=1&followNotebook=1`)
  const panel = page.getByTestId('replay-panel')
  const progress = panel.getByRole('slider')
  await progress.focus()
  await page.keyboard.press('End')
  await panel.getByRole('button', { name: 'Notebook', exact: true }).click()
  const material = panel.getByRole('region', { name: 'Research materials' })
  const notebookScroll = material.locator('[data-replay-notebook-scroll]')
  await notebookScroll.evaluate((node) => {
    node.scrollTop = 240
  })
  const output = material.getByTestId('notebook-text-output')
  await output.locator('summary').click()
  await panel.getByRole('button', { name: 'View files', exact: true }).click()
  const file = panel.getByRole('button', { name: 'observations.svg Version 1', exact: true })
  await file.scrollIntoViewIfNeeded()
  const position = await progress.getAttribute('aria-valuenow')
  for (const escape of [false, true]) {
    const scrollTop = await notebookScroll.evaluate((node) => node.scrollTop)
    await file.click()
    await expect(material.locator('[data-replay-artifact-version]')).toBeVisible()
    await expect(material.getByRole('button', { name: 'Back to conversation' })).toHaveCount(0)
    if (escape) await page.keyboard.press('Escape')
    else await material.getByRole('button', { name: 'Back to files', exact: true }).click()
    await expect(file).toBeFocused()
    await expect.poll(() => notebookScroll.evaluate((node) => node.scrollTop)).toBe(scrollTop)
    await expect(output).not.toHaveAttribute('open')
    await expect(progress).toHaveAttribute('aria-valuenow', position!)
  }
})

test('original evidence shows a readable file and Notebook with a compact return header', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1&evidencePage=1`)
  const panel = page.getByTestId('replay-panel')
  const progress = panel.getByRole('slider')
  const position = await progress.getAttribute('aria-valuenow')
  for (const number of [4, 2]) {
    await panel.getByRole('button', { name: 'Browse steps', exact: true }).click()
    const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
    await directory
      .getByRole('button', { name: `Open original evidence for step ${number}`, exact: true })
      .click()
    const evidence = page.getByRole('region', { name: 'Original recorded evidence', exact: true })
    await expect(evidence).toBeVisible()
    await expect(directory).not.toBeVisible()
    await expect(evidence.getByRole('img', { name: 'observations.svg', exact: true })).toBeVisible()
    await expect(evidence.getByText('Recorded data', { exact: true })).toHaveCount(0)
    await expect(evidence).not.toContainText('manifestChecksum')
    if (number === 2) {
      await expect(evidence.getByTestId('session-notebook-cell').locator('code')).toContainText(
        'observations ='
      )
      await expect(evidence.getByTestId('notebook-text-output')).toContainText('Mean: 4.50')
    }
    expect(await evidence.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page
      .locator('[data-replay-container]')
      .screenshot({ path: info.outputPath(`readable-original-${number}.png`) })
    await evidence.getByRole('button', { name: 'Back to replay', exact: true }).click()
    await expect(panel).toBeVisible()
    await expect(progress).toHaveAttribute('aria-valuenow', position!)
  }
})

test('profiles Replay playback with long Notebook output and completed transcript records', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&profile=1&followNotebook=1&longOutput=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  const progress = panel.getByRole('slider')
  await progress.focus()
  await page.keyboard.press('Home')
  await panel.getByRole('button', { name: 'Next step', exact: true }).click()
  await expect(panel.locator('[data-replay-notebook-run]')).toBeVisible()
  await expect
    .poll(() => panel.getByTestId('replay-stage').getAttribute('data-replay-frame-ready'))
    .toBe('true')
  await page.evaluate(() => {
    ;(window as unknown as { replayProfile: unknown[] }).replayProfile = []
  })
  const from = Number(await progress.getAttribute('aria-valuenow'))
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expect
    .poll(async () => Number(await progress.getAttribute('aria-valuenow')), { intervals: [100] })
    .toBeGreaterThan(from + 2500)
  await panel.getByRole('button', { name: 'Pause replay', exact: true }).click()
  const metrics = await page.evaluate(() => {
    const samples = (window as unknown as { replayProfile: { actualDuration: number }[] })
      .replayProfile
    const times = samples.map((s) => s.actualDuration).sort((a, b) => a - b)
    return {
      commits: times.length,
      renderMs: times.reduce((a, b) => a + b, 0),
      p95RenderMs: times[Math.floor(times.length * 0.95)],
      maxRenderMs: times.at(-1)
    }
  })
  await info.attach('replay-profile.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json'
  })
  console.log('REPLAY_PROFILE', JSON.stringify(metrics))
  expect(metrics.commits).toBeGreaterThan(0)
  expect(await progress.getAttribute('aria-valuenow')).not.toBe(String(from))
})

test('expanded replay keeps menus, tooltips and Ask above the modal and dismisses one layer at a time', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1&modalLayers=1&branchesReview=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  const assertOnTop = async (selector: import('@playwright/test').Locator): Promise<void> => {
    await expect(selector).toBeVisible()
    expect(
      await selector.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return node.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        )
      })
    ).toBe(true)
  }
  const speed = panel.getByRole('combobox', { name: 'Playback speed' })
  await speed.click()
  await assertOnTop(page.getByRole('listbox'))
  await page.getByRole('option', { name: '4×', exact: true }).click()
  await expect(speed).toContainText('4×')
  await panel.getByRole('combobox', { name: 'Replay branch' }).click()
  await assertOnTop(page.getByRole('listbox'))
  await page.keyboard.press('Escape')
  const steps = panel.getByRole('button', { name: 'Browse steps', exact: true })
  await steps.click()
  await assertOnTop(page.getByRole('dialog', { name: 'Browse steps', exact: true }))
  await page.keyboard.press('Escape')
  const notebook = panel.getByRole('button', { name: 'Notebook', exact: true })
  await notebook.hover()
  const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Notebook' })
  await expect(tooltip).toBeVisible()
  expect(await tooltip.evaluate((node) => Number(getComputedStyle(node).zIndex))).toBeGreaterThan(
    56
  )
  await panel.getByRole('button', { name: 'Ask about this step', exact: true }).click()
  const ask = page.getByRole('dialog', { name: 'Ask in a conversation', exact: true })
  await assertOnTop(ask)
  await expect(ask.getByRole('combobox', { name: 'Search conversations' })).toBeFocused()
  await expect(ask).toHaveCSS('opacity', '1')
  await ask.getByRole('combobox', { name: 'Search conversations' }).fill('Research')
  await page.screenshot({ path: info.outputPath('replay-ask-above-modal.png') })
  await page.keyboard.press('Escape')
  await expect(ask).not.toBeVisible()
  await expect(panel.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible()
})

test('Notebook and Files header toggles preserve the advancing replay clock', async ({ page }) => {
  await page.goto(`${url}?panel=1&artifacts=1`)
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  for (const name of ['Notebook', 'View files', 'Notebook', 'View files']) {
    await panel.getByRole('button', { name, exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible()
  }
  const before = Number(await panel.getByRole('slider').getAttribute('aria-valuenow'))
  await expect
    .poll(async () => Number(await panel.getByRole('slider').getAttribute('aria-valuenow')))
    .toBeGreaterThan(before)
})

test('interactive history reaches the first message and preserves conversation and Notebook anchors', async ({
  page
}) => {
  await page.goto(`${url}?panel=1&history=1`)
  const panel = page.getByTestId('replay-panel')
  const slider = panel.getByRole('slider')
  await slider.focus()
  await page.keyboard.press('End')
  const conversation = panel.getByRole('region', { name: 'Historical conversation' })
  await expect(conversation.locator('[data-replay-step]')).toHaveCount(12)
  await conversation.hover()
  await page.mouse.wheel(0, -100000)
  await expect.poll(() => conversation.evaluate((element) => element.scrollTop)).toBe(0)
  const historyButton = await conversation
    .getByRole('button', { name: 'Load earlier messages' })
    .boundingBox()
  // Native scrollbars consume client width on CI runners with persistent scrollbars.
  const conversationCenter = await conversation.evaluate(
    (node) => node.getBoundingClientRect().x + node.clientLeft + node.clientWidth / 2
  )
  expect(historyButton!.x + historyButton!.width / 2).toBeCloseTo(conversationCenter, 0)
  const anchor = conversation.locator('[data-replay-step="history-18"]')
  const top = (await anchor.boundingBox())!.y
  await conversation.getByRole('button', { name: 'Load earlier messages' }).click()
  await expect(conversation.locator('[data-replay-step]')).toHaveCount(24)
  await expect.poll(async () => (await anchor.boundingBox())!.y).toBeCloseTo(top, 0)
  await conversation.hover()
  await page.mouse.wheel(0, -100000)
  await expect.poll(() => conversation.evaluate((element) => element.scrollTop)).toBe(0)
  await conversation.getByRole('button', { name: 'Load earlier messages' }).click()
  await expect(conversation.locator('[data-replay-step]')).toHaveCount(30)
  await conversation.hover()
  await page.mouse.wheel(0, -100000)
  await expect.poll(() => conversation.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(conversation.locator('[data-replay-step="history-0"]')).toBeInViewport()
  await conversation.getByRole('button', { name: 'Return to current step' }).click()
  await expect(conversation.locator('[data-replay-step]')).toHaveCount(12)
  await expect(conversation.locator('[data-replay-active]')).toBeInViewport()

  await panel.getByRole('button', { name: 'Notebook', exact: true }).click()
  await expect(panel.locator('[data-replay-notebook-heading]').locator('..')).toHaveCSS(
    'height',
    '36px'
  )
  const notebook = panel.locator('[data-replay-notebook-scroll]')
  await expect(notebook.locator('[data-replay-notebook-run]')).toHaveCount(4)
  await notebook.hover()
  await page.mouse.wheel(0, -100000)
  await expect.poll(() => notebook.evaluate((element) => element.scrollTop)).toBe(0)
  const runAnchor = notebook.locator('[data-replay-run-item="run-18"]')
  const runTop = (await runAnchor.boundingBox())!.y
  await notebook.getByRole('button', { name: 'Load earlier runs' }).click()
  await expect(notebook.locator('[data-replay-notebook-run]')).toHaveCount(8)
  await expect.poll(async () => (await runAnchor.boundingBox())!.y).toBeCloseTo(runTop, 0)
})

test('conversation follows uninterrupted replay and resumes after manual reading, play and seek', async ({
  page
}) => {
  await page.goto(`${url}?panel=1&history=1`)
  const panel = page.getByTestId('replay-panel')
  const conversation = panel.getByRole('region', { name: 'Historical conversation' })
  const progress = panel.getByRole('slider', { name: 'Replay progress' })
  const returnToCurrent = conversation.getByRole('button', { name: 'Return to current step' })
  const bottomGap = (): Promise<number> =>
    conversation.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)
  const expectFollowing = async (): Promise<void> => {
    await expect(returnToCurrent).toHaveCount(0)
    await expect.poll(bottomGap).toBeLessThanOrEqual(8)
  }
  const readEarlier = async (): Promise<void> => {
    await conversation.hover()
    await page.mouse.wheel(0, -240)
    await expect(returnToCurrent).toBeVisible()
    await expect.poll(bottomGap).toBeGreaterThan(100)
    await expect(panel.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
  }

  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  // Native scroll and ResizeObserver callbacks can straddle growing text commits. Sample
  // every painted frame, including eviction of older rows after the twelve-step window fills.
  const playback = await conversation.evaluate(async (node) => {
    const started = performance.now()
    let samples = 0
    let maximumRows = 0
    let falseReturn:
      | {
          position: number
          top: number
          gap: number
          step: string | undefined
          preceding: unknown[]
        }
      | undefined
    const preceding: unknown[] = []
    const record = (event: string): void => {
      preceding.push({
        event,
        position: document
          .querySelector('[data-testid="replay-stage"]')
          ?.getAttribute('data-replay-position'),
        top: node.scrollTop,
        height: node.scrollHeight,
        viewport: node.clientHeight,
        first: node.querySelector<HTMLElement>('[data-replay-step]')?.dataset.replayStep,
        rows: node.querySelectorAll('[data-replay-step]').length
      })
      if (preceding.length > 4) preceding.shift()
    }
    const onScroll = (): void => record('scroll')
    node.addEventListener('scroll', onScroll, { passive: true })
    while (performance.now() - started < 20000) {
      await new Promise(requestAnimationFrame)
      samples++
      maximumRows = Math.max(maximumRows, node.querySelectorAll('[data-replay-step]').length)
      const position = Number(
        document.querySelector('[data-testid="replay-stage"]')?.getAttribute('data-replay-position')
      )
      if (
        !falseReturn &&
        Array.from(node.querySelectorAll('button')).some(
          (button) => button.textContent?.trim() === 'Return to current step'
        )
      ) {
        falseReturn = {
          position,
          top: node.scrollTop,
          gap: node.scrollHeight - node.clientHeight - node.scrollTop,
          step: node.querySelector<HTMLElement>('[data-replay-active]')?.dataset.replayStep,
          preceding: [...preceding]
        }
      }
      record('frame')
      if (position >= 16000) {
        node.removeEventListener('scroll', onScroll)
        return { samples, maximumRows, falseReturn, position }
      }
    }
    throw new Error('Replay did not advance past the bounded conversation history window')
  })
  await panel.getByRole('button', { name: 'Pause replay', exact: true }).click()
  expect(playback.samples).toBeGreaterThan(20)
  expect(playback.maximumRows).toBe(12)
  expect(playback.falseReturn).toBeUndefined()
  await expectFollowing()

  await readEarlier()
  const pausedTime = await progress.getAttribute('aria-valuenow')
  const readingTop = await conversation.evaluate((node) => node.scrollTop)
  const originalHeight = (await conversation.boundingBox())!.height
  // A native viewport resize while reading must not pull the reader back to the latest text.
  await panel.evaluate((node) => {
    const container = node.closest('[data-replay-container]') as HTMLElement
    container.style.bottom = '10vh'
  })
  await expect
    .poll(async () => (await conversation.boundingBox())!.height)
    .toBeLessThan(originalHeight)
  await expect.poll(() => conversation.evaluate((node) => node.scrollTop)).toBe(readingTop)
  await expect(progress).toHaveAttribute('aria-valuenow', pausedTime!)
  await conversation.hover()
  await page.mouse.wheel(0, 100000)
  await expectFollowing()
  // Returning to the bottom itself resumes follow, without a Play/seek reset masking it.
  await panel.evaluate((node) => {
    const container = node.closest('[data-replay-container]') as HTMLElement
    container.style.bottom = '15vh'
  })
  await expectFollowing()
  await expect(progress).toHaveAttribute('aria-valuenow', pausedTime!)

  await readEarlier()
  await returnToCurrent.click()
  await expectFollowing()
  await expect(progress).toHaveAttribute('aria-valuenow', pausedTime!)

  await readEarlier()
  await panel.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expectFollowing()
  await expect
    .poll(async () => Number(await progress.getAttribute('aria-valuenow')))
    .toBeGreaterThan(Number(pausedTime) + 250)
  await readEarlier()
  const beforeSeek = Number(await progress.getAttribute('aria-valuenow'))
  await panel.getByRole('button', { name: 'Next step', exact: true }).click()
  await expectFollowing()
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(beforeSeek)
})

test('reveals recorded files immediately and keeps the gallery stable through delayed thumbnails without horizontal overflow', async ({
  page
}) => {
  await page.goto(`${url}?panel=1&artifacts=1&longName=1&previewRegressions=1&delayedArtifacts=1`)
  const panel = page.getByTestId('replay-panel')
  const progress = panel.getByRole('slider', { name: 'Replay progress' })
  const transcript = panel.getByRole('region', { name: 'Historical conversation' })
  const seekPanel = async (position: number): Promise<void> => {
    const track = (await panel.getByTestId('replay-progress-track').boundingBox())!
    await page.mouse.click(track.x + (track.width * position) / 12000, track.y + track.height / 2)
    await expect(progress).toHaveAttribute('aria-valuenow', String(position))
  }
  await seekPanel(10000)
  await expect(transcript.getByText('GENERATED · 2', { exact: true })).toHaveCount(1)
  const cards = transcript.getByRole('button', { name: /^Preview generated file/ })
  await expect(cards.nth(0)).toBeEnabled()
  await expect(cards.nth(1)).toBeEnabled()
  await seekPanel(10300)
  await expect(transcript.getByText('GENERATED · 2', { exact: true })).toHaveCount(1)
  await expect(cards.nth(0)).toBeEnabled()
  await expect(cards.nth(1)).toBeEnabled()
  await seekPanel(10600)
  await expect(cards.nth(1)).toBeEnabled()
  await progress.focus()
  await page.keyboard.press('End')
  await expect(progress).toHaveAttribute('aria-valuenow', '12000')
  await expect(transcript.getByText('GENERATED · 3', { exact: true })).toHaveCount(1)
  await expect(cards).toHaveCount(3)
  await expect(cards.locator('img')).toHaveCount(0)
  expect(await transcript.evaluate((node) => node.scrollWidth)).toBe(
    await transcript.evaluate((node) => node.clientWidth)
  )
  const before = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })
  )
  await page.evaluate(() => {
    const fixture = window as unknown as { releaseReplayResource: (id: string) => void }
    for (const id of ['plot-v1', 'plot-v2', 'plot-v3']) fixture.releaseReplayResource(id)
  })
  await expect(cards.locator('img')).toHaveCount(2)
  expect(
    await cards.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })
    )
  ).toEqual(before)
  expect(await transcript.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('restores Notebook and its code scrollbar after returning from a generated image', async ({
  page
}, info) => {
  await page.goto(`${url}?panel=1&artifacts=1&longName=1&previewRegressions=1`)
  await page.setViewportSize({ width: 1500, height: 900 })
  const panel = page.getByTestId('replay-panel')
  await panel.getByRole('button', { name: 'Enter full screen' }).click()
  const progress = panel.getByRole('slider')
  await progress.focus()
  await page.keyboard.press('End')
  const notebook = panel.getByRole('button', { name: 'Notebook', exact: true })
  const transcript = panel.getByRole('region', { name: 'Historical conversation' })
  const codeViewport = panel.locator('[data-replay-notebook-run] pre').first().locator('..')
  await expect(codeViewport).toHaveClass(/scrollbar-auto-hide/)
  await codeViewport.hover()
  expect(await codeViewport.evaluate((node) => getComputedStyle(node).scrollbarWidth)).toBe('thin')
  expect(await codeViewport.evaluate((node) => getComputedStyle(node).scrollbarColor)).not.toBe(
    'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)'
  )
  await page.mouse.wheel(500, 0)
  await expect.poll(() => codeViewport.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)
  expect(await transcript.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  const card = transcript.getByRole('button', { name: /^Preview generated file/ }).first()
  for (const notebookOpen of [true, false]) {
    if (!notebookOpen) await notebook.click()
    for (const action of ['back', 'escape']) {
      await card.click()
      const back = panel.getByRole('button', { name: 'Back to conversation' })
      await expect(back).toBeVisible()
      if (action === 'back') await back.click()
      else await page.keyboard.press('Escape')
      await expect(back).toHaveCount(0)
      await expect(notebook).toHaveAttribute('aria-expanded', String(notebookOpen))
      await expect(card).toBeFocused()
      await expect(transcript).toBeVisible()
    }
  }
  await notebook.click()
  await codeViewport.hover()
  await panel.screenshot({ path: info.outputPath('replay-notebook-generated-preview.png') })
})

test('research fullscreen retains one clock and all portaled controls without remounting evidence', async ({
  page,
  stageApp
}) => {
  await stageApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await page.goto(`${url}?panel=1&research=1`)
  const panel = page.getByTestId('replay-panel')
  const stage = await panel.getByTestId('replay-stage').elementHandle()
  const progress = panel.getByRole('slider', { name: 'Replay progress', exact: true })
  await progress.focus()
  await page.keyboard.press('End')
  const position = await progress.getAttribute('aria-valuenow')
  // On macOS HTML fullscreen enters a native Space asynchronously. Wait for the real
  // native transition before interacting; exiting mid-transition can leave Chromium pending.
  const entered = stageApp.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.once('enter-full-screen', () => resolve())
      })
  )
  await panel.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  await entered
  await expect
    .poll(() => panel.evaluate((element) => document.fullscreenElement === element))
    .toBe(true)
  await expect(panel.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible()
  await panel.getByRole('combobox', { name: 'Playback speed', exact: true }).click()
  await expect(panel.getByRole('option', { name: '1×', exact: true })).toBeVisible()
  await panel.getByRole('option', { name: '1×', exact: true }).click()
  await panel.getByTestId('replay-information-trigger').click()
  await expect(
    panel.getByRole('dialog', { name: 'A reproducible observation study', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await panel.getByRole('button', { name: 'Question options', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: 'Ask about this step', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await panel.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !document.fullscreenElement)).toBe(true)
  await expect(progress).toHaveAttribute('aria-valuenow', position!)
  expect(await stage!.evaluate((element) => element.isConnected)).toBe(true)
})
