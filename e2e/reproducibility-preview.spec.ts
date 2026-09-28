import { resolve } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, test as base, _electron, type ElectronApplication } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import de from '../src/shared/i18n/locales/de.json'

let server: ViteDevServer
let url: string
const test = base.extend<{ previewApp: ElectronApplication }>({
  // Playwright requires the destructured fixture argument even with no dependencies.
  // eslint-disable-next-line no-empty-pattern
  previewApp: async ({}, provide) => {
    const userData = await mkdtemp(resolve(tmpdir(), 'repro-preview-'))
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'
      )
    )
    let app: ElectronApplication | undefined
    try {
      app = await _electron.launch({
        args: [resolve('e2e/fixtures/reproducibility-preview/electron.mjs')],
        env: { ...environment, REPRO_PREVIEW_USER_DATA: userData }
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
  page: async ({ previewApp }, provide) => {
    await provide(await previewApp.firstWindow())
  }
})
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: resolve('out/reproducibility-preview-vite'),
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [
      {
        name: 'preview-file-fixture',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === './PreviewFileSurface' && importer?.endsWith('/FilePreviewDialog.tsx'))
            return resolve('e2e/fixtures/reproducibility-preview/surface.jsx')
          return null
        }
      },
      react(),
      tailwindcss()
    ],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  })
  await server.listen()
  url = `${server.resolvedUrls!.local[0]}e2e/fixtures/reproducibility-preview/index.html`
})
test.afterAll(async () => {
  await server?.close()
})

for (const { width, locale, zoom } of [
  { width: 414, locale: 'en', zoom: 1 },
  { width: 1280, locale: 'en', zoom: 1 },
  { width: 414, locale: 'de', zoom: 1.25 }
]) {
  test(`comparison controls work above the Preview dialog at ${width}px (${locale}, ${zoom})`, async ({
    page,
    previewApp
  }) => {
    const copy = (key: string): string =>
      locale === 'de' ? (Reflect.get(de.renderer, key) ?? key) : key
    // Chromium CSS zoom is not Electron zoom: use the actual webContents scale.
    await page.goto(`${url}?locale=${locale}`)
    await previewApp.evaluate(
      ({ BrowserWindow }, { width, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setContentSize(width, 900)
        window.webContents.setZoomFactor(zoom)
      },
      { width, zoom }
    )
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(width / zoom + 1)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.getByText(copy('Comparison rules'), { exact: true }).click()
    // Exercise the space reserved by non-overlay scrollbars even on overlay-scrollbar hosts.
    if (locale === 'de') {
      await page.addStyleTag({
        content: '.overflow-auto { scrollbar-gutter: stable; } ::-webkit-scrollbar { width: 12px; }'
      })
    }
    // Font loading and Electron zoom settle asynchronously, especially on cold CI runners.
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await expect
      .poll(() => page.locator('form').evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1)
    await expect
      .poll(() =>
        page.locator('form').evaluate((el) => {
          const form = el.getBoundingClientRect()
          const card = el.closest('[data-reproducibility-check-state]')!.getBoundingClientRect()
          return form.left >= card.left && form.right <= card.right
        })
      )
      .toBe(true)
    const help = page.locator('[data-slot="field-help"]').first()
    await help.hover()
    const tooltip = page.locator('[data-slot="tooltip-content"]')
    await expect(tooltip).toBeVisible()
    // Visibility alone ignores occlusion: verify the actual painted hit target too.
    await expect
      .poll(() =>
        tooltip.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })
      )
      .toBe(true)
    await page.mouse.move(0, 0)
    const keys = page.locator('input[name="keys"]')
    await keys.fill('id, id')
    await page.getByRole('button', { name: copy('Apply comparison rules'), exact: true }).click()
    await expect(keys).toBeFocused()
    await expect(keys).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert')).toBeVisible()
    await keys.fill('sample')
    await expect(keys).toHaveAttribute('aria-invalid', 'false')
    const scientific = page.getByRole('combobox', { name: copy('Scientific comparison') })
    await scientific.click()
    const menu = page.getByRole('listbox')
    await expect(menu).toBeVisible()
    expect(
      await menu.evaluate(
        (el) =>
          Number(getComputedStyle(el).zIndex) >
          Number(
            getComputedStyle(document.querySelector('[data-slot="file-preview-dialog"]')!).zIndex
          )
      )
    ).toBe(true)
    const bounds = await menu.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth)
    )
    const screenshot = test.info().outputPath('comparison-menu.png')
    const pixels = await previewApp.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64')
    )
    await writeFile(screenshot, Buffer.from(pixels, 'base64'))
    await test.info().attach('comparison-menu', { path: screenshot, contentType: 'image/png' })
    await page.getByRole('option', { name: copy('Differential expression'), exact: true }).click()
    const gene = page.getByLabel(copy('Gene identifier column'), { exact: true })
    await gene.fill('gene_id')
    await scientific.click()
    await page.getByRole('option', { name: copy('Single-cell clusters'), exact: true }).click()
    await page.getByLabel(copy('Cell identifier column'), { exact: true }).fill('barcode')
    await scientific.click()
    await page.getByRole('option', { name: copy('Differential expression'), exact: true }).click()
    await expect(gene).toHaveValue('gene_id')
    const start = page.getByRole('combobox', { name: copy('Start from'), exact: true })
    await start.click()
    const checkpointTitle = await page.getByRole('option').last().innerText()
    await page.getByRole('option').last().click()
    await expect(start).toContainText(checkpointTitle)
    await start.press('ArrowDown')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(start).toBeFocused()
    await expect(dialog).toBeVisible()
  })
}

for (const scenario of ['import', 'export']) {
  test(`keeps package ${scenario} evidence inspectable without execution`, async ({
    page
  }, testInfo) => {
    await page.goto(`${url}?package=${scenario}`)
    await expect(
      page.getByText(
        scenario === 'import'
          ? 'Checks from the source installation'
          : 'This Session is being exported. Try again when export finishes.',
        { exact: true }
      )
    ).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: scenario === 'import' ? 'Check again' : 'Check reproducibility',
        exact: true
      })
    ).toBeDisabled()
    await page.getByRole('heading', { name: 'Dependency', exact: true }).click()
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`package-${scenario}-reproducibility.png`) })
  })
}

test('cancels, retries and inspects comparison results in the Preview dialog', async ({ page }) => {
  await page.goto(`${url}?package=lifecycle`)
  const card = page.locator('[data-reproducibility-check-state]')
  await page.getByRole('button', { name: 'Check reproducibility', exact: true }).click()
  await expect(card).toHaveAttribute('data-reproducibility-check-state', 'running')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card).toHaveAttribute('data-reproducibility-check-state', 'cancelled')
  await expect(page.getByRole('heading', { name: 'Check cancelled', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Check again', exact: true }).click()
  await expect(card).toHaveAttribute('data-reproducibility-check-state', 'running')
  await page.evaluate(async () => {
    const request = {
      projectId: 'import-project',
      appSessionId: 'import-session',
      artifactId: 'local-artifact',
      versionId: 'local-version'
    }
    const state = await window.api.artifacts.getReproducibilityCheck!(request)
    window.dispatchEvent(
      new CustomEvent('e2e-reproducibility-change', {
        detail: {
          ...state,
          revision: 2,
          status: 'failed',
          errorMessage: 'Fixture execution failed'
        }
      })
    )
  })
  await expect(page.getByRole('button', { name: 'Retry check', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Retry check', exact: true }).click()
  await expect(card).toHaveAttribute('data-reproducibility-check-state', 'running')
  await page.evaluate(async () => {
    const scope = {
      projectId: 'import-project',
      appSessionId: 'import-session',
      artifactId: 'local-artifact',
      versionId: 'local-version'
    }
    const state = (await window.api.artifacts.getReproducibilityCheck!(scope))!
    const receipt = {
      schemaVersion: 1,
      receiptId: 'preview-check',
      receiptChecksum: 'e'.repeat(64),
      artifactVersion: { ...scope, targetChecksum: 'a'.repeat(64) },
      startedAt: state.startedAt,
      completedAt: '2026-09-28T00:01:00.000Z',
      outcome: 'different',
      frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
      recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
      environmentLocks: [],
      completedStepIds: ['run-1', 'run-2'],
      comparisons: [
        {
          stepId: 'run-2',
          entityId: 'output',
          relativePath: 'result.csv',
          expectedChecksum: 'a'.repeat(64),
          actualChecksum: 'b'.repeat(64),
          expectedSizeBytes: 20,
          actualSizeBytes: 20,
          status: 'different'
        }
      ]
    }
    window.dispatchEvent(
      new CustomEvent('e2e-reproducibility-change', {
        detail: { ...state, revision: 2, status: 'different', completedSteps: 2, receipt }
      })
    )
  })
  await expect(page.getByRole('heading', { name: 'Result differs', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View details', exact: true }).click()
  const history = page.locator('[data-reproducibility-history]')
  await expect(history).toHaveAttribute('open', '')
  await expect(history.locator('[data-receipt-checksum]')).toHaveAttribute('open', '')
  await expect(history.getByText('result.csv', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toBeVisible()
})
