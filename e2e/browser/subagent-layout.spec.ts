import { expect, test } from '@playwright/test'

for (const dark of [false, true]) {
  test(`keeps Subagent states and controls readable at narrow widths (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/subagent-layout.html?${dark ? 'dark' : ''}`)
    const bar = page.getByTestId('subagents-bar')
    const trigger = bar.locator(':scope > button')
    await expect(trigger).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Subagent Frame' })).toHaveCount(0)
    for (const width of [768, 414, 375, 320]) {
      await page.setViewportSize({ width, height: 800 })
      await trigger.click()
      const list = bar.locator('[aria-label="Subagents"]')
      const stripBounds = await page.getByTestId('composer-strip').boundingBox()
      const bounds = await list.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(stripBounds!.x)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(stripBounds!.x + stripBounds!.width)
      await expect(bar.getByRole('button', { name: 'PySin, running' })).toBeVisible()
      const completed = bar.getByRole('button', { name: 'PyCos, completed' })
      await completed.focus()
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      await trigger.click()
      await completed.click()
      const selector = page.getByRole('combobox', { name: 'Subagent Frame' })
      await expect(selector).toContainText('completed')
      await expect(
        page.getByText('Result saved below; check the Main Agent conversation for receipt.')
      ).toBeVisible()
      await selector.click()
      const options = page.getByRole('listbox')
      await expect(options.getByRole('option', { name: 'PySin, running' })).toBeVisible()
      expect(await options.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.getByRole('option', { name: /Review the full statistical analysis/ }).click()
      await expect(selector).toContainText('awaiting user')
      expect(await selector.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      await expect(page.getByRole('button', { name: 'Close Subagents preview' })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    }
    await page.screenshot({ path: testInfo.outputPath('narrow.png') })
    const selector = page.getByRole('combobox', { name: 'Subagent Frame' })
    await selector.click()
    await page.getByRole('listbox').screenshot({ path: testInfo.outputPath('narrow-selector.png') })
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 768, height: 800 })
    await selector.click()
    await page.getByRole('option', { name: 'PyCos, completed' }).click()
    const previewBounds = await page
      .getByRole('region', { name: 'Subagents', exact: true })
      .boundingBox()
    await page.screenshot({
      path: testInfo.outputPath('completed-preview.png'),
      clip: { ...previewBounds!, height: 200 }
    })
    await selector.click()
    await page.getByRole('listbox').screenshot({ path: testInfo.outputPath('selector.png') })
    await page.keyboard.press('Escape')
    await trigger.click()
    const list = bar.locator('[aria-label="Subagents"]')
    await expect(list).not.toContainText('Main Agent')
    await list.screenshot({ path: testInfo.outputPath('list.png') })
    expect(errors).toEqual([])
  })
}

test('fits translated statuses and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/subagent-layout.html?de')
  const bar = page.getByTestId('subagents-bar')
  await bar.locator(':scope > button').click()
  const running = bar.getByRole('button', { name: /^PySin,/ })
  await expect(running.locator('svg.animate-spin')).toHaveCSS('animation-name', 'none')
  await running.click()
  const selector = page.getByRole('combobox')
  await selector.click()
  await page.getByRole('option', { name: /^Review the full/ }).click()
  expect(await selector.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})
