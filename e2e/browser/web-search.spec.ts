import { expect, test } from '@playwright/test'
import { captureExternalRequests, useNarrowViewport } from './web-activity-helpers'

test('keeps recorded sources readable through updates and offline reload', async ({
  page
}, testInfo) => {
  const externalRequests = captureExternalRequests(page)
  await useNarrowViewport(page)
  await page.goto('/web-activity.html?tool=search')
  const chip = page.getByTestId('tool-chip')
  await expect(chip).toContainText('10 results')
  await expect(chip).toContainText('125 ms')
  await page.keyboard.press('Tab')
  await expect(chip).toBeFocused()
  await page.keyboard.press('Enter')
  const details = page.getByTestId('tool-search-details')
  await expect(details.getByTestId('web-search-source')).toHaveCount(8)
  await expect(chip).toBeFocused()
  await expect(details).toContainText('Scientific source text.')
  await expect(details.locator('img, script, iframe')).toHaveCount(0)
  const firstSource = details.getByTestId('web-search-source').first()
  await expect(firstSource.locator('time')).toBeVisible()
  const showMore = firstSource.getByRole('button', { name: 'Show more' })
  await expect(showMore).toBeVisible()
  await showMore.click()
  const showLess = firstSource.getByRole('button', { name: 'Show less' })
  await expect(showLess).toHaveAttribute('aria-expanded', 'true')
  await showLess.click()
  await expect(showMore).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  await details.getByRole('button', { name: 'Show all results' }).click()
  await expect(details.getByTestId('web-search-source')).toHaveCount(10)
  await chip.focus()
  await page.evaluate(() =>
    (window as unknown as { updateSearchFixture: () => void }).updateSearchFixture()
  )
  await expect(chip).toBeFocused()
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  await expect(details.getByTestId('web-search-source')).toHaveCount(10)
  await page.screenshot({
    path: testInfo.outputPath('search-all-results-narrow.png'),
    fullPage: true
  })
  await page.route('https://**/*', (route) => route.abort())
  await page.reload()
  await page.getByTestId('tool-chip').click()
  await expect(details.getByTestId('web-search-source')).toHaveCount(8)
  await expect(details).toContainText('Scientific source text.')
  expect(externalRequests).toEqual([])
})

test('uses actual pending query, preserves open panel on completion and distinguishes empty and limited', async ({
  page
}, testInfo) => {
  await page.goto('/web-activity.html?tool=search&scenario=pending')
  const chip = page.getByTestId('tool-chip')
  await expect(chip).toContainText('open science reproducibility')
  await expect(chip).toContainText('Searching the web…')
  await expect(chip).not.toContainText('0 results')
  await chip.click()
  await page.evaluate(() =>
    (window as unknown as { updateSearchFixture: () => void }).updateSearchFixture()
  )
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('web-search-source')).toHaveCount(8)
  await page.goto('/web-activity.html?tool=search&scenario=empty')
  await page.getByTestId('tool-chip').click()
  await expect(page.getByTestId('tool-search-details')).toContainText('No results found')
  await page.goto('/web-activity.html?tool=search&scenario=limited')
  await page.getByTestId('tool-chip').click()
  const details = page.getByTestId('tool-search-details')
  await expect(details).toContainText('The search service is temporarily limiting requests.')
  await expect(details).not.toContainText('No results found')
  await expect(details.locator('details').first()).not.toHaveAttribute('open', '')
  await page.screenshot({ path: testInfo.outputPath('search-rate-limited.png'), fullPage: true })
  await page.goto('/web-activity.html?tool=search&scenario=cancelled')
  await page.getByTestId('tool-chip').click()
  await expect(page.getByTestId('tool-search-details')).toContainText('Cancelled')
  await expect(page.getByTestId('web-search-source')).toHaveCount(0)
})

test('only repeats the full query when the row clips it', async ({ page }) => {
  const query = 'open science reproducibility and reusable computational workflows'
  await useNarrowViewport(page)
  await page.goto('/web-activity.html?tool=search&scenario=ordinary')
  const chip = page.getByTestId('tool-chip')
  await expect(chip).toContainText(query)
  await chip.click()
  const details = page.getByTestId('tool-search-details')
  await expect(details).toContainText(query)
  await expect(
    details.locator('time[datetime="2026-11-16T12:00:00.000Z"]').locator('..')
  ).toHaveText(/^Exa · /)
  await expect(details.locator('details')).toHaveCount(0)
  await page.setViewportSize({ width: 1180, height: 810 })
  await expect(details).not.toContainText(query)
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
})
