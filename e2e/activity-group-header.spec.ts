import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

let server: ViteDevServer
let url: string
let app: ElectronApplication
let page: Page
let dataRoot: string

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: resolve('out/activity-group-header-vite'),
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      entries: ['e2e/fixtures/activity-group-header/index.html'],
      include: [
        '@aipoch/diagnostics',
        '@aipoch/skills/document',
        '@aipoch/notebook-analysis/contracts',
        '@aipoch/environment/contracts',
        '@aipoch/providers',
        '@aipoch/providers/errors',
        '@aipoch/providers/transport'
      ]
    },
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  })
  await server.listen()
  url = `${server.resolvedUrls!.local[0]}e2e/fixtures/activity-group-header/index.html`
})
test.afterAll(async () => {
  await server?.close()
})
test.beforeEach(async () => {
  dataRoot = await mkdtemp(resolve(tmpdir(), 'activity-group-header-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'
    )
  )
  app = await _electron.launch({
    args: [resolve('e2e/fixtures/activity-group-header/electron.mjs')],
    env: {
      ...env,
      OPEN_SCIENCE_USER_DATA: dataRoot,
      TMPDIR: dataRoot,
      TMP: dataRoot,
      TEMP: dataRoot
    }
  })
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(dataRoot)
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
})
test.afterEach(async () => {
  await app?.close()
  await rm(dataRoot, { recursive: true, force: true })
})

test('separates group progress from the left disclosure and preserves individual results', async () => {
  await page.goto(url)
  const header = page.getByTestId('tool-group-header')
  const meta = header.getByTestId('tool-group-meta')
  await expect(meta).toContainText('Ran 3 steps · 1 step running')
  await expect(meta.locator('.animate-spin')).toHaveCount(1)
  const arrow = await header.locator('.lucide-chevron-right').boundingBox()
  const title = await header.getByTestId('tool-group-title').boundingBox()
  const progress = await meta.boundingBox()
  expect(arrow!.x + arrow!.width).toBeLessThan(title!.x)
  expect(title!.x + title!.width).toBeLessThanOrEqual(progress!.x)

  await header.focus()
  await page.keyboard.press('Space')
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('tool-chip')).toHaveCount(4)
  await page.getByRole('button', { name: 'completed', exact: true }).click()
  await expect(meta).toContainText('Ran 4 steps')
  await expect(meta).not.toContainText('running')
  await expect(header.locator('.lucide-check, .animate-spin')).toHaveCount(0)
  await expect(page.getByTestId('tool-chip').locator('.lucide-check')).toHaveCount(4)

  await page.getByRole('button', { name: 'failed', exact: true }).click()
  await expect(meta).toContainText('Ran 4 steps · 1 failed')
  await expect(meta.locator('.lucide-circle-alert')).toHaveCount(1)
  await expect(page.getByTestId('tool-chip').locator('.lucide-circle-alert')).toHaveCount(1)
  await header.focus()
  await page.keyboard.press('Enter')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('tool-chip').first()).not.toBeVisible()
})

test('keeps long translated progress and a truncated summary inside a narrow header', async () => {
  await page.setViewportSize({ width: 420, height: 700 })
  await page.goto(`${url}?locale=de`)
  const header = page.getByTestId('tool-group-header')
  await expect(header.getByRole('status')).toContainText('3 Schritte ausgeführt')
  await page.getByRole('button', { name: 'failed', exact: true }).click()
  await expect(header.getByRole('status')).toContainText('4 Schritte ausgeführt')
  const geometry = await header.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const title = element.querySelector<HTMLElement>('[data-testid="tool-group-title"]')!
    const meta = element.querySelector<HTMLElement>('[data-testid="tool-group-meta"]')!
    return {
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: rect.left,
      right: rect.right,
      metaRight: meta.getBoundingClientRect().right,
      titleWidth: title.clientWidth,
      titleScrollWidth: title.scrollWidth
    }
  })
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width)
  expect(geometry.metaRight).toBeLessThanOrEqual(geometry.right)
  expect(geometry.titleWidth).toBeGreaterThan(0)
  expect(geometry.titleScrollWidth).toBeGreaterThan(geometry.titleWidth)
})

test('shows Chinese executed counts and captures the expanded multi-tool group', async () => {
  await page.goto(`${url}?locale=zh-Hans`)
  const header = page.getByTestId('tool-group-header')
  await expect(header.getByRole('status')).toHaveText('已运行 3 步 · 1 步执行中')
  await page.getByRole('button', { name: 'completed', exact: true }).click()
  await expect(header.getByRole('status')).toHaveText('已运行 4 步')
  await header.click()
  await expect(page.getByTestId('tool-chip')).toHaveCount(4)
  await page.mouse.move(0, 0)
  await page.getByTestId('tool-group').screenshot({
    path: test.info().outputPath('completed.png'),
    animations: 'disabled'
  })
  await page.getByRole('button', { name: 'failed', exact: true }).click()
  await expect(header.getByRole('status')).toHaveText('已运行 4 步 · 1 个失败')
  await page.getByTestId('tool-group').screenshot({
    path: test.info().outputPath('failed.png'),
    animations: 'disabled'
  })
})
