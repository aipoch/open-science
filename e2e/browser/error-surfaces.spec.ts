import { expect, test } from '@playwright/test'

for (const theme of ['', '&dark']) {
  test(`narrow notices keep recovery reachable${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 })
    await page.goto(`/error-surfaces.html?locale=zh-Hans${theme}`)
    await expect(page.getByTestId('error-gallery')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const storage = page.getByTestId('session-persistence-alert')
    await storage.getByTestId('session-persistence-retry').click()
    await expect(page.getByTestId('retry-count')).toHaveText('1')
    await storage.getByTestId('session-persistence-dismiss').click()
    await expect(storage).toHaveCount(0)
    const diagnostics = page.locator('details')
    await expect(diagnostics).not.toHaveAttribute('open')
    await diagnostics.locator('summary').click()
    await expect(diagnostics).toHaveAttribute('open')
    expect(await diagnostics.evaluate((el) => el.closest('[role="alert"]') === null)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('long destructive confirmation keeps safe focus and buttons inside the viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 400 })
  await page.goto('/error-surfaces.html')
  const trigger = page.getByRole('button', { name: 'Open dangerous action' })
  await trigger.click()
  const dialog = page.getByRole('alertdialog')
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeFocused()
  const confirm = dialog.getByRole('button', { name: 'Delete permanently' })
  const rect = await confirm.boundingBox()
  expect(rect!.y).toBeGreaterThanOrEqual(0)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(400)
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.keyboard.press('Shift+Tab')
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('confirm-count')).toHaveText('0')
  await trigger.click()
  await confirm.click()
  await expect(page.getByTestId('confirm-count')).toHaveText('1')
})

test('simultaneous global notices stack without fixed-offset overlap', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 600 })
  await page.goto('/error-surfaces.html?toasts')
  const notices = page.locator('[data-action-toast-stack] > [role="status"]')
  await expect(notices).toHaveCount(2)
  const first = (await notices.nth(0).boundingBox())!
  const second = (await notices.nth(1).boundingBox())!
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
  for (const rect of [first, second]) {
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(360)
  }
  await notices.nth(0).getByRole('button', { name: 'Open Storage' }).click()
  await expect(page.getByTestId('retry-count')).toHaveText('1')
})

test('storage recovery and Undo share the global stack without horizontal overflow', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 500 })
  await page.goto('/error-surfaces.html?toasts&undo')
  const stack = page.locator('[data-action-toast-stack]')
  const undo = stack.getByTestId('archive-undo-snackbar')
  await expect(undo).toBeVisible()
  await undo.scrollIntoViewIfNeeded()
  expect(await stack.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  const close = undo.locator('button[aria-label]')
  await close.click()
  await expect(undo).toHaveCount(0)
  const recovery = stack.getByTestId('session-persistence-alert')
  await recovery.getByTestId('session-persistence-retry').click()
  await expect(page.getByTestId('retry-count')).toHaveText('1')
})
