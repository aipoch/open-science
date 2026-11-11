import { expect, test } from '@playwright/test'

for (const width of [320, 375, 414, 768])
  for (const dark of [false, true]) {
    test(`notice truncation, disclosure and folding at ${width}px ${dark ? 'dark' : 'light'}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 850 })
      await page.goto(`/composer-notices.html?category=configuration&fold${dark ? '&dark' : ''}`)
      const slot = page.getByTestId('composer-notice-slot')
      await expect(slot).toBeVisible()
      const heading = slot.locator('h2 span').first()
      const typography = await heading.evaluate((element) => {
        const title = getComputedStyle(element)
        const slot = element.closest('[data-testid="composer-notice-slot"]')!
        return {
          color: title.color,
          foreground: getComputedStyle(slot).color,
          size: title.fontSize,
          weight: title.fontWeight,
          lineHeight: title.lineHeight
        }
      })
      expect(typography).toEqual({
        color: typography.foreground,
        foreground: typography.foreground,
        size: '14px',
        weight: '600',
        lineHeight: '20px'
      })
      expect(await heading.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe(
        'nowrap'
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      const feedback = slot.getByRole('button', { name: 'Still need help? Report this error' })
      const primary = slot.getByRole('button', { name: 'Model settings', exact: true })
      if (width === 768) {
        const feedbackBox = (await feedback.boundingBox())!
        const primaryBox = (await primary.boundingBox())!
        expect(
          Math.abs(feedbackBox.y + feedbackBox.height / 2 - primaryBox.y - primaryBox.height / 2)
        ).toBeLessThan(2)
        expect(feedbackBox.x + feedbackBox.width).toBeLessThan(primaryBox.x)
      }
      // Current-error details belong to diagnostics, before actions and the separate notice list.
      expect(
        await slot
          .locator('summary > span')
          .last()
          .evaluate((element) => getComputedStyle(element).textDecorationLine)
      ).toContain('underline')
      const detailsBox = (await slot.locator('summary').boundingBox())!
      expect(detailsBox.y).toBeLessThan((await feedback.boundingBox())!.y)
      await expect(slot.locator('summary span[aria-hidden="true"]')).toHaveCount(3)
      await slot.locator('summary').click()
      expect(
        await slot.locator('pre').evaluate((element) => element.clientHeight)
      ).toBeLessThanOrEqual(160)
      expect(
        await slot.locator('pre').evaluate((element) => element.scrollHeight > element.clientHeight)
      ).toBe(true)
      await slot.getByRole('button', { name: '2 more notices' }).click()
      await slot.locator('[data-select-notice]').first().click()
      await expect(slot).toHaveAttribute('data-notice-category', 'internal')
      await page.getByRole('button', { name: 'Simulate disconnection' }).click()
      await expect(slot).toHaveAttribute('data-notice-category', 'session')
      await expect(slot.getByRole('button', { name: 'Dismiss error' })).toHaveCount(0)
      await slot.getByRole('button', { name: 'Resume session' }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('action-count')).toHaveText('1')
    })
  }

test('tooltip tracks actual truncation after resizing in both directions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 })
  await page.goto('/composer-notices.html?category=internal')
  const heading = page.getByTestId('composer-notice-slot').locator('h2 span').first()
  await heading.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.mouse.move(0, 0)
  await page.setViewportSize({ width: 1100, height: 850 })
  await expect
    .poll(() => heading.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(false)
  await heading.hover()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.mouse.move(0, 0)
  await page.setViewportSize({ width: 320, height: 850 })
  await heading.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
})

test('action affordances cover hover, focus, pressed, disabled, loading, error and copied states', async ({
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
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  const resting = await retry.boundingBox()
  await retry.hover()
  await retry.focus()
  await expect(retry).toBeFocused()
  await page.mouse.down()
  expect(await retry.evaluate((element) => element.matches(':active'))).toBe(true)
  await page.mouse.up()
  expect(await retry.boundingBox()).toEqual(resting)
  await page.getByRole('button', { name: 'Copy error' }).click()
  await expect(page.getByText('Copied', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.copiedDiagnostic)).toContain(
    'request-request-'
  )
  for (const state of ['disabled', 'loading']) {
    await page.goto(`/composer-notices.html?category=configuration&state=${state}`)
    await expect(retry).toBeDisabled()
    if (state === 'loading') await expect(retry).toHaveAttribute('aria-busy', 'true')
  }
  await page.goto('/composer-notices.html?category=configuration&state=error')
  await retry.click()
  await expect(page.getByRole('alert')).toContainText('The action could not be completed.')
  await page.locator('summary').click()
  await expect(page.locator('pre')).toContainText('The retry operation failed in this fixture.')
  await expect(retry).toBeEnabled()
})
