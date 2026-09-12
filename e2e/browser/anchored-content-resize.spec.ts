import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/anchored-content-resize.html')
  await expect(page.getByText('First reply')).toBeVisible()
  await page.getByText('Append turn', { exact: true }).click()
  await expect(page.getByText('Completed tool')).toBeVisible()
  await expect
    .poll(() => page.getByRole('region').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(300)
})

test('keeps the current turn anchored when trailing content shrinks or grows', async ({ page }) => {
  const tool = page.locator('[data-message-id="tool"]')
  for (const transition of ['shrink', 'grow']) {
    const positions = await tool.evaluate(async (element) => {
      const positions = [element.getBoundingClientRect().top]
      const button = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Toggle trailing height'
      )!
      button.click()
      for (let frame = 0; frame < 20; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        positions.push(element.getBoundingClientRect().top)
      }
      return positions
    })
    expect(
      Math.max(...positions) - Math.min(...positions),
      `${transition}: ${positions.join(', ')}`
    ).toBeLessThanOrEqual(2)
  }
  await page.screenshot({ path: test.info().outputPath('anchored-content-resize.png') })
})

test('does not reanchor after the user scrolls away', async ({ page }) => {
  const viewport = page.getByRole('region')
  await viewport.hover()
  await page.mouse.wheel(0, -300)
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(100)
  const before = await viewport.evaluate((node) => node.scrollTop)
  await page.getByText('Toggle trailing height', { exact: true }).click()
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(before)
  await expect(page.getByText('Completed tool')).toBeVisible()
})
