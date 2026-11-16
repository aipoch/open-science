import { expect, test } from '@playwright/test'

for (const width of [320, 375, 414, 768])
  for (const dark of [false, true]) {
    test(`readable summary, inline disclosure and recovery at ${width}px ${dark ? 'dark' : 'light'}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 850 })
      await page.goto(`/composer-notices.html?category=configuration&fold${dark ? '&dark' : ''}`)
      const slot = page.getByTestId('composer-notice-slot')
      await expect(slot).toBeVisible()
      const summary = slot.locator('summary').first()
      const details = slot.getByTestId('composer-error-details')
      const retry = slot.getByRole('button', { name: 'Retry', exact: true })
      await expect(retry).toBeVisible()
      await expect(details).not.toBeVisible()
      await expect(slot.getByRole('button', { name: 'Copy error' })).not.toBeVisible()
      await summary.focus()
      await page.keyboard.press('Enter')
      await expect(details).toBeVisible()
      const detailBounds = (await details.boundingBox())!
      const summaryParentBounds = (await summary.locator('..').locator('..').boundingBox())!
      expect(detailBounds.width).toBeGreaterThan(summaryParentBounds.width - 2)
      await expect(summary).toBeFocused()
      await expect(details).not.toContainText('request-request-')
      await expect(slot.locator('pre')).toHaveCount(0)
      expect(
        await slot
          .getByRole('status')
          .evaluate((element) => !element.querySelector('details, button'))
      ).toBe(true)
      for (const button of await slot.getByRole('button').all()) {
        if (!(await button.isVisible())) continue
        const bounds = (await button.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      }
      await page.keyboard.press('Space')
      await expect(details).not.toBeVisible()
      await expect(summary).toBeFocused()
      await slot.getByRole('button', { name: '2 more notices' }).click()
      await slot.locator('[data-select-notice]').first().click()
      await expect(slot).toHaveAttribute('data-notice-category', 'internal')
      await expect(slot.getByRole('heading')).toHaveText("Couldn't complete your request")
      await page.getByRole('button', { name: 'Simulate disconnection' }).click()
      await expect(slot).toHaveAttribute('data-notice-category', 'session')
      await slot.getByRole('button', { name: 'Dismiss error' }).click()
      const entry = page.getByTestId('composer-notice-recovery-entry')
      await expect(entry).toBeVisible()
      await expect(entry.getByRole('button', { name: 'Details', exact: true })).toBeFocused()
      await entry.getByRole('button', { name: 'Retry', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('action-count')).toHaveText('1')
      await entry.getByRole('button', { name: 'Details', exact: true }).click()
      const restored = page.locator('[data-slot="session-recovery-notice"]')
      await expect(restored).toBeVisible()
      await expect(restored.locator('summary')).toBeFocused()
      await expect(restored.locator('details')).toHaveAttribute('open', '')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
    })
  }

test('copy exposes readable actual fields while pending/error states retain Retry', async ({
  page
}) => {
  await page.setViewportSize({ width: 768, height: 850 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedDiagnostic = text
        }
      }
    })
  })
  await page.goto('/composer-notices.html?category=configuration')
  await page.locator('summary').click()
  await page.getByRole('button', { name: 'Copy error' }).click()
  await expect(page.getByText('Copied', { exact: true })).toBeVisible()
  const copied = await page.evaluate(() => document.documentElement.dataset.copiedDiagnostic)
  expect(copied).toContain('Status: 401')
  expect(copied).not.toContain('request-request-')
  expect(copied?.match(/Example diagnostic/g)).toHaveLength(1)
  for (const state of ['disabled', 'loading']) {
    await page.goto(`/composer-notices.html?category=configuration&state=${state}`)
    const retry = page.locator('[data-notice-action="retry"]')
    await expect(retry).toBeDisabled()
    if (state === 'loading') {
      await expect(retry).toHaveAttribute('aria-busy', 'true')
      await expect(retry).toHaveText('Retrying…')
    }
  }
  await page.goto('/composer-notices.html?category=configuration&state=error')
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await retry.click()
  await expect(page.getByRole('alert')).toContainText('The action could not be completed.')
  await page.locator('summary').click()
  await expect(page.locator('details')).toContainText('The retry operation failed in this fixture.')
  await expect(retry).toBeEnabled()
})

test('localized summary wraps at narrow width without raw diagnostic announcements', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 850 })
  await page.goto('/composer-notices.html?category=internal&locale=zh-Hans')
  const slot = page.getByTestId('composer-notice-slot')
  await expect(slot.getByRole('heading')).toHaveText('无法完成您的请求')
  await expect(slot.getByRole('status')).not.toContainText('Example diagnostic')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
