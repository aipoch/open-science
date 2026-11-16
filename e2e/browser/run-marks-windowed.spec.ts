import { expect, test } from '@playwright/test'

for (const noContainment of [false, true]) {
  for (const index of [70, 10]) {
    test(`settles on history row ${index + 1}, containment=${!noContainment}`, async ({ page }) => {
      await page.goto(`/run-marks-windowed.html?count=120${noContainment ? '&no-containment' : ''}`)
      const viewport = page.getByRole('region', { name: 'Conversation' })
      const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
      // Wait for the initial tail and its deferred layout to settle before navigation.
      await expect(viewport.locator('[data-message-id="user-119"]')).toBeAttached()
      await page.waitForTimeout(1000)
      const mark = rail.locator(`[data-run-index="${index}"]`)
      // Keyboard focus reveals marks outside the rail's currently visible range.
      if (index === 10) {
        await rail.locator('[data-run-index="0"]').focus()
        await page.keyboard.press('ArrowDown')
      }
      await mark.hover()
      await mark.click()
      const offset = (): Promise<number | null> =>
        viewport.evaluate((el, id) => {
          const target = el.querySelector(`[data-message-id="user-${id}"]`)
          return target ? target.getBoundingClientRect().top - el.getBoundingClientRect().top : null
        }, index)
      await expect.poll(offset).toBeCloseTo(8, 0)
      // A transient correct frame is insufficient: late layout/anchoring must not undo the jump.
      await page.waitForTimeout(1200)
      expect(await offset()).toBeCloseTo(8, 0)
    })
  }
}

test('keeps the last requested target, both endpoints, and resumed following stable', async ({
  page
}) => {
  await page.goto('/run-marks-windowed.html?count=240')
  const viewport = page.getByRole('region', { name: 'Conversation' })
  const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
  await expect(viewport.locator('[data-message-id="user-239"]')).toBeAttached()
  await page.waitForTimeout(1000)
  const offset = (index: number): Promise<number | null> =>
    viewport.evaluate((el, index) => {
      const target = el.querySelector(`[data-message-id="user-${index}"]`)
      return target ? target.getBoundingClientRect().top - el.getBoundingClientRect().top : null
    }, index)
  // Endpoints are always keyboard reachable even when their rail window is off screen.
  const first = rail.locator('[data-run-index="0"]')
  await first.focus()
  await first.click()
  await expect.poll(() => offset(0)).toBe(0)
  const middle = rail.locator('[data-run-index="30"]')
  await middle.hover()
  await page.locator('button[data-slot="run-mark-preview"][data-open]').click()
  // A second click replaces the preview target without retaining a previous animation.
  const newer = rail.locator('[data-run-index="35"]')
  await newer.click()
  await expect.poll(() => offset(35)).toBeCloseTo(8, 0)
  await page.waitForTimeout(1200)
  expect(await offset(35)).toBeCloseTo(8, 0)
  await viewport.hover()
  await page.mouse.wheel(0, -1000)
  await expect.poll(() => offset(35)).toBeGreaterThan(100)
  await newer.hover()
  await page.locator('button[data-slot="run-mark-preview"][data-open]').click()
  await expect.poll(() => offset(35)).toBeCloseTo(8, 0)
  await page.waitForTimeout(1200)
  expect(await offset(35)).toBeCloseTo(8, 0)
  await page.getByRole('button', { name: 'Scroll to end', exact: true }).click()
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThanOrEqual(1)
  await expect(viewport.locator('[data-message-id="user-239"]')).toHaveCSS(
    'content-visibility',
    'auto'
  )
  const last = rail.locator('[data-run-index="239"]')
  await last.focus()
  await last.click()
  await expect.poll(() => offset(239)).toBeCloseTo(8, 0)
  await page.waitForTimeout(1200)
  expect(await offset(239)).toBeCloseTo(8, 0)
  await expect.poll(() => viewport.locator('[data-message-id]').count()).toBeLessThanOrEqual(160)
})
