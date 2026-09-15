import { expect, test } from '@playwright/test'

test('reveals the update label without turning activation into a two-step action', async ({
  page
}) => {
  await page.goto('/button-feedback.html')
  const update = page.getByTestId('update').getByRole('button')
  await expect(update).toBeVisible()
  const collapsed = (await update.boundingBox())!
  await update.hover()
  await expect
    .poll(async () => (await update.boundingBox())!.width)
    .toBeGreaterThan(collapsed.width + 20)
  await expect(update).not.toHaveAttribute('aria-expanded')
  await update.click()
  await expect(page.getByTestId('update-open')).toHaveText('true')
  await page.mouse.move(0, 0)
  await update.blur()
  await expect.poll(async () => (await update.boundingBox())!.width).toBeCloseTo(collapsed.width, 0)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(update).toBeFocused()
  await expect
    .poll(async () => (await update.boundingBox())!.width)
    .toBeGreaterThan(collapsed.width + 20)
})

test('keeps copy geometry and focus through success, error and retry', async ({ page }) => {
  await page.goto('/button-feedback.html')
  const copy = page.getByTestId('code-copy-button')
  const documentBox = (): Promise<{ x: number; y: number; width: number; height: number }> =>
    copy.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        x: box.x + window.scrollX,
        y: box.y + window.scrollY,
        width: box.width,
        height: box.height
      }
    })
  const initial = await documentBox()
  await copy.click()
  await expect(copy).toHaveAccessibleName('Copied')
  await expect(copy.locator('.lucide-check')).toBeVisible()
  await expect(copy).toBeFocused()
  expect(await documentBox()).toEqual(initial)
  await page.getByRole('button', { name: 'Reject next copy', exact: true }).click()
  await copy.click()
  await expect(copy).toHaveAccessibleName('Could not copy code. Try again.')
  await expect(copy.locator('.lucide-circle-alert')).toBeVisible()
  expect(await documentBox()).toEqual(initial)
  await page.getByRole('button', { name: 'Allow copy', exact: true }).click()
  await copy.click()
  await expect(copy).toHaveAccessibleName('Copied')
})

test('preserves real save and Radix confirmation lifecycles during feedback', async ({ page }) => {
  await page.goto('/button-feedback.html')
  const save = page
    .getByRole('region', { name: 'Proxy form' })
    .getByRole('button', { name: 'Save', exact: true })
  await save.click()
  const saving = page.getByRole('button', { name: 'Saving…', exact: true })
  await expect(saving).toBeDisabled()
  await expect(saving).toHaveAttribute('aria-busy', 'true')
  await page.getByRole('button', { name: 'Finish save', exact: true }).click()
  await expect(save).toBeEnabled()
  await page.getByRole('button', { name: 'Open confirmation', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  const working = page.getByRole('button', { name: 'Working…', exact: true })
  await expect(working).toBeDisabled()
  await expect(working).toHaveAttribute('aria-busy', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page.getByTestId('confirm-count')).toHaveText('1')
})

test('respects reduced motion and exposes progress without hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/button-feedback.html')
  const animations = await page
    .locator('.button-feedback, .button-feedback .animate-spin')
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).animationName))
  expect(animations.length).toBeGreaterThan(4)
  expect(animations.every((animation) => animation === 'none')).toBe(true)
  const label = page.locator('.update-action-label')
  expect(await label.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s')
  await page.getByRole('button', { name: 'Download progress', exact: true }).click()
  await expect(label).toHaveText('42%')
  await expect(label).toHaveCSS('opacity', '1')
})

for (const locale of ['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru']) {
  test(`keeps ${locale} action labels readable on a narrow enlarged page`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 })
    await page.goto(`/button-feedback.html?locale=${locale}&dark`)
    await page.getByRole('region', { name: 'Action states' }).waitFor()
    await page.addStyleTag({ content: 'html { font-size: 20px; }' })
    const overflow = await page
      .locator('.button-feedback')
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent)
      )
    expect(overflow).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
}

test('keeps the update label visible on touch', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 900 }
  })
  const page = await context.newPage()
  await page.goto('/button-feedback.html')
  await expect(page.locator('.update-action-label')).toHaveCSS('opacity', '1')
  await context.close()
})

test('fits the real Home header when the update action expands', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.goto('/button-feedback.html?home&locale=zh-Hans')
  const update = page.locator('.update-reminder[data-variant="home"]')
  await expect(update).toBeVisible()
  const collapsed = (await update.boundingBox())!
  await update.hover()
  await expect
    .poll(async () => (await update.boundingBox())!.width)
    .toBeGreaterThan(collapsed.width + 15)
  const expanded = (await update.boundingBox())!
  expect(expanded.x).toBeGreaterThanOrEqual(0)
  expect(expanded.x + expanded.width).toBeLessThanOrEqual(1024)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024)
})

for (const locale of ['unknown', '__proto__', 'constructor', 'toString']) {
  test(`rejects unsupported fixture locale ${locale}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/button-feedback.html?locale=${locale}`)
    await expect(page.getByTestId('code-copy-button')).toHaveAccessibleName('Copy code')
    expect(errors).toEqual([])
  })
}
