import { expect } from '@playwright/test'
import { test as base } from './fixtures/electron-app'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

const test = base.extend<{ useCaseNetwork: void }>({
  useCaseNetwork: [
    // Playwright requires fixture dependencies to use object destructuring.
    // eslint-disable-next-line no-empty-pattern
    async ({}, runFixture, info) => {
      const previous = {
        gate: process.env.OPEN_SCIENCE_E2E_USE_CASE_GATE
      }
      const gate = info.outputPath('download-continue')
      await mkdir(dirname(gate), { recursive: true })
      await writeFile(`${gate}.fail`, '')
      process.env.OPEN_SCIENCE_E2E_USE_CASE_GATE = gate
      try {
        await runFixture()
      } finally {
        if (previous.gate === undefined) delete process.env.OPEN_SCIENCE_E2E_USE_CASE_GATE
        else process.env.OPEN_SCIENCE_E2E_USE_CASE_GATE = previous.gate
      }
    },
    { auto: true }
  ]
})
test.use({ windowMode: 'normal' })

test('downloads on the card, retries and cancels, then imports verified bytes through the real Electron bridge', async ({
  app
}, info) => {
  test.setTimeout(180000)
  const bytes = await readFile(
    'src/main/session-package/fixtures/session-package-v0.31.1-minimal.science'
  )
  const manifest = Array.from({ length: 7 }, (_, index) => ({
    name: `example-${index + 1}`,
    title: `Example ${index + 1}`,
    cover: { file_name: 'cover.png' },
    case: {
      file_name: 'example.science',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  }))
  await app.page.route('https://statics.aipoch.com/open-science/usecases/**', (route) =>
    route.request().url().endsWith('manifest.json')
      ? route.fulfill({ json: manifest })
      : route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e7e5df"/></svg>'
        })
  )
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const section = page.getByRole('region', { name: 'Use Case Gallery' })
  await section.getByRole('button', { name: 'Next examples' }).click()
  const card = section.getByRole('article', { name: 'Example 4', exact: true })
  await expect(
    section.getByRole('link', { name: 'Use Case Gallery', exact: true })
  ).toHaveAttribute('href', 'https://aipoch.com/open-science/use-cases')
  await card.hover()
  const cardSizes = async (): Promise<{ width: number; height: number }[]> =>
    section.getByRole('article').evaluateAll((cards) =>
      cards.map((card) => {
        const { width, height } = card.getBoundingClientRect()
        return { width, height }
      })
    )
  const initialSizes = await cardSizes()
  await card.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('Could not download this example.')
  expect(await cardSizes()).toEqual(initialSizes)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await rm(`${info.outputPath('download-continue')}.fail`)
  await card.getByRole('button', { name: 'Try again' }).click()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /2[45]/)
  expect(await cardSizes()).toEqual(initialSizes)
  const progressBounds = (await card.getByRole('progressbar').boundingBox())!
  const cardBounds = (await card.boundingBox())!
  expect(progressBounds.x - cardBounds.x).toBeGreaterThanOrEqual(0)
  expect(progressBounds.x - cardBounds.x).toBeLessThanOrEqual(2)
  const cancelBounds = (await card
    .getByRole('button', { name: 'Cancel', exact: true })
    .boundingBox())!
  const statusBounds = (await card.getByRole('status').boundingBox())!
  expect(cancelBounds.x - progressBounds.x - progressBounds.width).toBeGreaterThanOrEqual(8)
  expect(progressBounds.y).toBeLessThanOrEqual(statusBounds.y)
  expect(progressBounds.y + progressBounds.height).toBeGreaterThanOrEqual(
    statusBounds.y + statusBounds.height
  )
  await expect
    .poll(async () => {
      const filledBounds = (await card.getByRole('progressbar').locator('span').boundingBox())!
      return filledBounds.width / progressBounds.width
    })
    .toBeCloseTo(0.24, 1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('card-download-progress.png') })
  await section.getByRole('button', { name: 'Next examples' }).click()
  await section.getByRole('button', { name: 'Previous examples' }).click()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /2[45]/)
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card.getByRole('progressbar')).toHaveCount(0)
  expect(await cardSizes()).toEqual(initialSizes)
  await card.hover()
  await card.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /2[45]/)
  await writeFile(info.outputPath('download-continue'), '')
  const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
  await expect(dialog).toBeVisible()
  await expect(card.getByRole('progressbar')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'New project', exact: true }).click()
  await dialog.getByLabel('Project name', { exact: true }).fill('Downloaded example')
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: /^Session imported$/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('research-workspace-header')).toContainText(
    'Original record · Read-only'
  )
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await expect(section.getByRole('article')).toHaveCount(3)
  expect(
    await section
      .getByRole('article')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
  ).toEqual(['Example 4', 'Example 5', 'Example 6'])
  expect(await card.evaluate((element) => element.parentElement!.getAnimations().length)).toBe(0)
})

test('refreshes the catalog once per launch and reuses the disk cache silently offline', async ({
  app
}, info) => {
  test.setTimeout(180000)
  let page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await expect(
    page.getByRole('region', { name: 'Use Case Gallery' }).getByRole('article')
  ).toHaveCount(3)
  await page.evaluate(() => window.api.sessions.useCaseCatalog('refreshed'))
  const requestCount = async (): Promise<number> =>
    (await readFile(`${info.outputPath('download-continue')}.catalog-requests`, 'utf8'))
      .trim()
      .split('\n').length
  expect(await requestCount()).toBe(1)
  await page.reload()
  await expect(
    page.getByRole('region', { name: 'Use Case Gallery' }).getByRole('article')
  ).toHaveCount(3)
  await page.evaluate(() => window.api.sessions.useCaseCatalog('refreshed'))
  expect(await requestCount()).toBe(1)
  await writeFile(`${info.outputPath('download-continue')}.catalog-offline`, '')
  page = await app.restart()
  await expect(
    page.getByRole('region', { name: 'Use Case Gallery' }).getByRole('article')
  ).toHaveCount(3)
  const refreshed = await page.evaluate(() => window.api.sessions.useCaseCatalog('refreshed'))
  expect(refreshed).toHaveLength(7)
  expect(await requestCount()).toBe(2)
  await expect(
    page.getByRole('region', { name: 'Use Case Gallery' }).getByRole('alert')
  ).toHaveCount(0)
})
