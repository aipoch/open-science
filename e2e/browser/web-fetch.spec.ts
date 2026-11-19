import { expect, test } from '@playwright/test'
import { captureExternalRequests, useNarrowViewport } from './web-activity-helpers'

test('reads saved fetch evidence safely at narrow widths and replays offline after reload', async ({
  page
}, testInfo) => {
  const externalRequests = captureExternalRequests(page)
  await useNarrowViewport(page)
  await page.goto('/web-activity.html?tool=fetch')
  const chip = page.getByTestId('tool-chip')
  await expect(chip).toContainText('Completed · 123 ms')
  await expect(chip).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Tab')
  await expect(chip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  await expect(chip).toBeFocused()
  const details = page.getByTestId('tool-web-fetch-details')
  await expect(details).toContainText('Page excerpt')
  await expect(details).toContainText('Partial page text')
  const excerpt = details.getByRole('region', { name: 'Page excerpt' })
  await expect(excerpt).toContainText('<script>fetch(')
  expect(await excerpt.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await excerpt.evaluate((element) => element.clientHeight)
  )
  await excerpt.focus()
  await page.keyboard.press('End')
  await expect.poll(() => excerpt.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(details.locator('img, iframe, script')).toHaveCount(0)
  await expect(details.locator('details')).toHaveCount(1)
  await expect(details.locator('details')).not.toHaveAttribute('open', '')
  await details.getByText('Details', { exact: true }).click()
  await expect(details.locator('time[datetime="2026-11-16T11:59:00.000Z"]')).toBeVisible()
  await expect(details.locator('dt')).toHaveText(['Original URL', 'Final URL', 'Fetched at'])
  const originalText = await details.locator('pre').textContent()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  await page.screenshot({ path: testInfo.outputPath('fetch-success-narrow.png'), fullPage: true })
  await page.route('https://**/*', (route) => route.abort())
  await page.route('http://example.org/**', (route) => route.abort())
  await page.reload()
  await page.getByTestId('tool-chip').click()
  await expect(details.locator('pre')).toHaveText(originalText!)
  expect(externalRequests).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('fetch-offline-replay.png'), fullPage: true })
})

test('shows failure impact before folded diagnostics and retains cancellation despite late success', async ({
  page
}, testInfo) => {
  await page.goto('/web-activity.html?tool=fetch&scenario=failure')
  await page.getByTestId('tool-chip').click()
  const details = page.getByTestId('tool-web-fetch-details')
  await expect(details).toContainText('No readable page text was found.')
  await expect(details.locator('details')).not.toHaveAttribute('open', '')
  await expect(details.locator('pre')).not.toBeVisible()
  await details.getByText('Details', { exact: true }).click()
  await expect(details.locator('details')).toContainText('EXTRACTION_FAILED')
  await expect(details.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('fetch-extraction-failure.png'),
    fullPage: true
  })
  await page.goto('/web-activity.html?tool=fetch&scenario=cancelled')
  await page.getByTestId('tool-chip').click()
  await expect(page.getByTestId('tool-web-fetch-details')).toContainText('Cancelled')
  await expect(page.getByTestId('tool-web-fetch-details')).not.toContainText('Saved evidence')
})
