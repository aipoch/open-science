import { expect, test } from '@playwright/test'

test('keeps recorded sources readable through updates and offline reload', async ({
  page
}, testInfo) => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4178')) externalRequests.push(request.url())
  })
  await page.setViewportSize({ width: 375, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/web-search.html')
  const chip = page.getByTestId('tool-chip')
  await expect(chip).toContainText('10 results')
  await page.keyboard.press('Tab')
  await expect(chip).toBeFocused()
  await page.keyboard.press('Enter')
  const details = page.getByTestId('tool-search-details')
  await expect(details.getByTestId('web-search-source')).toHaveCount(10)
  await expect(chip).toBeFocused()
  await expect(details).toContainText('Scientific source text.')
  await expect(details.locator('img, script, iframe')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
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
  await expect(details.getByTestId('web-search-source')).toHaveCount(10)
  await expect(details).toContainText('Scientific source text.')
  expect(externalRequests).toEqual([])
})

test('uses actual pending query, preserves open panel on completion and distinguishes empty and limited', async ({
  page
}, testInfo) => {
  await page.goto('/web-search.html?scenario=pending')
  const chip = page.getByTestId('tool-chip')
  await expect(chip).toContainText('open science reproducibility')
  await expect(chip).toContainText('Searching the web…')
  await expect(chip).not.toContainText('0 results')
  await chip.click()
  await page.evaluate(() =>
    (window as unknown as { updateSearchFixture: () => void }).updateSearchFixture()
  )
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('web-search-source')).toHaveCount(10)
  await page.goto('/web-search.html?scenario=empty')
  await page.getByTestId('tool-chip').click()
  await expect(page.getByTestId('tool-search-details')).toContainText(
    'No search results were returned.'
  )
  await page.goto('/web-search.html?scenario=limited')
  await page.getByTestId('tool-chip').click()
  const details = page.getByTestId('tool-search-details')
  await expect(details).toContainText('The search service is temporarily limiting requests.')
  await expect(details).not.toContainText('No search results were returned.')
  await expect(details.locator('details').first()).not.toHaveAttribute('open', '')
  await page.screenshot({ path: testInfo.outputPath('search-rate-limited.png'), fullPage: true })
  await page.goto('/web-search.html?scenario=cancelled')
  await page.getByTestId('tool-chip').click()
  await expect(page.getByTestId('tool-search-details')).toContainText('Cancelled')
  await expect(page.getByTestId('web-search-source')).toHaveCount(0)
})
