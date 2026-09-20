import { expect, test } from '@playwright/test'

for (const key of ['PageUp', 'ArrowUp']) {
  for (const streaming of ['none', 'growth', 'anchored-growth'] as const) {
    test(`native ${key} releases follow before an appended message (${streaming})`, async ({
      page
    }) => {
      await page.goto('/transcript-follow.html')
      const viewport = page.getByLabel('Transcript')
      await viewport.focus()
      await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(7700)
      if (streaming !== 'none') {
        await viewport.evaluate((node, anchorGrowth) => {
          node.addEventListener(
            'keydown',
            () => {
              // Model a streamed reply gaining a line between input and native movement.
              requestAnimationFrame(() => {
                ;(node.lastElementChild as HTMLElement).style.height = '140px'
                if (anchorGrowth) node.scrollTop += 40
              })
            },
            { once: true }
          )
        }, streaming === 'anchored-growth')
      }
      // Playwright sends real keyboard input. Chromium starts its native scrolling after
      // the first animation frame; synthetic keydown + scroll cannot reproduce this.
      await page.keyboard.press(key)
      const bottom = streaming === 'none' ? 7700 : 7740
      await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(bottom)
      await expect(page.getByTestId('following')).toHaveText('false')
      await page.getByRole('button', { name: 'Append', exact: true }).click()
      await expect(viewport.locator('[data-message-id]')).toHaveCount(80)
      await expect(viewport.locator('[data-message-id="item-121"]')).toHaveCount(0)
      await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(bottom)
    })
  }
}

for (const key of ['ArrowDown', 'PageDown', 'End']) {
  test(`native ${key} at the bottom keeps following`, async ({ page }) => {
    await page.goto('/transcript-follow.html')
    const viewport = page.getByLabel('Transcript')
    await viewport.focus()
    await page.keyboard.press(key)
    await page.getByRole('button', { name: 'Append', exact: true }).click()
    await expect(page.getByTestId('following')).toHaveText('true')
    await expect(viewport.locator('[data-message-id]')).toHaveCount(80)
    await expect(viewport.locator('[data-message-id="item-121"]')).toHaveCount(1)
  })
}

test('a downward wheel at the physical bottom keeps new messages mounted', async ({ page }) => {
  await page.goto('/transcript-follow.html')
  const viewport = page.getByLabel('Transcript')
  await viewport.hover()
  await page.mouse.wheel(0, 100)
  await page.getByRole('button', { name: 'Append', exact: true }).click()
  await expect(page.getByTestId('following')).toHaveText('true')
  await expect(viewport.locator('[data-message-id]')).toHaveCount(80)
  await expect(viewport.locator('[data-message-id="item-121"]')).toHaveCount(1)
})

test('PageUp with no room to scroll preserves following', async ({ page }) => {
  await page.goto('/transcript-follow.html')
  const viewport = page.getByLabel('Transcript')
  await viewport.evaluate((node) => {
    node.style.height = '10000px'
  })
  await viewport.focus()
  await page.keyboard.press('PageUp')
  await page.getByRole('button', { name: 'Append', exact: true }).click()
  await expect(page.getByTestId('following')).toHaveText('true')
  await expect(viewport.locator('[data-message-id="item-121"]')).toHaveCount(1)
})

test('layout clamping after cancelled keyboard input does not release follow', async ({ page }) => {
  await page.goto('/transcript-follow.html')
  const viewport = page.getByLabel('Transcript')
  await viewport.focus()
  // Cancel the default action after React records the input, leaving a pending signal.
  await page.evaluate(() => document.addEventListener('keydown', (event) => event.preventDefault()))
  await page.keyboard.press('PageUp')
  await viewport.evaluate((node) => {
    node.style.height = '600px'
  })
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(7400)
  await page.getByRole('button', { name: 'Append', exact: true }).click()
  await expect(page.getByTestId('following')).toHaveText('true')
  await expect(viewport.locator('[data-message-id]')).toHaveCount(80)
  await expect(viewport.locator('[data-message-id="item-121"]')).toHaveCount(1)
})
