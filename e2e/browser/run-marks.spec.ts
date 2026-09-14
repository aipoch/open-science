import { expect, test } from '@playwright/test'

test('shows four runs, hides three, and previews the hovered message', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html?count=3')
  await expect(page.getByRole('navigation', { name: 'Run marks' })).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('three-runs.png') })
  await page.goto('/run-marks.html?count=4')
  const marks = page.getByRole('button', { name: /Go to run/ })
  await expect(marks).toHaveCount(4)
  await marks.nth(2).hover()
  await expect(page.getByRole('tooltip')).toContainText('3. Compare the RNA family')
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('four-runs-hover.png')
  })
})

test('follows transcript reading at both edges with bounded spacing and no independent scrolling', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html')
  const conversation = page.getByRole('region', { name: 'Conversation' })
  const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
  const marks = rail.getByRole('button')
  await expect(marks).toHaveCount(60)
  const pitch = (): Promise<number> =>
    marks.evaluateAll(
      (buttons) => buttons[1].getBoundingClientRect().top - buttons[0].getBoundingClientRect().top
    )
  expect(await pitch()).toBe(12)
  const railTop = (): Promise<number> => rail.evaluate((el) => el.scrollTop)
  const readRun = async (index: number, extra = 0): Promise<void> => {
    await conversation.evaluate(
      (el, { index, extra }) => {
        const message = el.querySelector(`[data-message-id="user-${index}"]`)!
        el.scrollTop += message.getBoundingClientRect().top - el.getBoundingClientRect().top + extra
      },
      { index, extra }
    )
  }
  await readRun(10)
  await expect(marks.nth(10)).toHaveAttribute('aria-current', 'location')
  expect(await railTop()).toBe(0)
  await readRun(45)
  await expect.poll(railTop).toBeGreaterThan(60)
  const before = await railTop()
  await readRun(45, 60)
  await expect.poll(railTop).toBeGreaterThan(before)
  expect((await railTop()) - before).toBeLessThan(12)
  expect(await pitch()).toBe(12)
  await marks.nth(45).hover()
  await expect(page.getByRole('tooltip')).toContainText('46. Compare')
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('long-conversation-hover.png')
  })
  const stationaryTop = await railTop()
  await page.mouse.wheel(0, 500)
  // Wait on subsequent input processing before observing the absence of independent scrolling.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  expect(await railTop()).toBe(stationaryTop)
  const readingTop = await conversation.evaluate((el) => el.scrollTop)
  await marks.last().focus()
  await expect(marks.last()).toBeFocused()
  await expect.poll(railTop).toBeGreaterThan(stationaryTop)
  expect(await conversation.evaluate((el) => el.scrollTop)).toBe(readingTop)
  await readRun(59)
  await expect.poll(railTop).toBe(240)
  await marks.last().focus()
  await expect(marks.last()).toBeFocused()
  await readRun(0)
  await expect.poll(railTop).toBe(0)
  expect(await pitch()).toBe(12)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await marks.nth(3).click()
  await expect(marks.nth(3)).toHaveAttribute('aria-current', 'location')
  await expect(marks.nth(3).locator('span')).toHaveCSS('transition-property', 'none')
})

test('keeps mark spacing when the window shrinks and hides the rail on mobile', async ({
  page
}) => {
  await page.setViewportSize({ width: 1100, height: 300 })
  await page.goto('/run-marks.html')
  const rail = page.getByRole('navigation', { name: 'Run marks' })
  expect(await rail.locator('ol').evaluate((el) => el.clientHeight)).toBe(204)
  expect(
    await rail
      .locator('li')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height)
  ).toBe(12)
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(rail).toBeHidden()
})

for (const [count, pitch] of [
  [4, 20],
  [30, 16],
  [60, 12]
]) {
  test(`uses ${pitch}px spacing for ${count} messages`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 })
    await page.goto(`/run-marks.html?count=${count}`)
    const marks = page.getByRole('navigation', { name: 'Run marks' }).locator('li')
    await expect(marks).toHaveCount(count)
    expect(await marks.first().evaluate((el) => el.getBoundingClientRect().height)).toBe(pitch)
  })
}

test('keeps visible conversation segments dark without hover and updates them on scroll', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html')
  const conversation = page.getByRole('region', { name: 'Conversation' })
  const marks = page.getByRole('navigation', { name: 'Run marks' }).getByRole('button')
  const visible = page.locator('nav button[data-visible="true"]')
  await expect(visible).toHaveCount(2)
  await expect(marks.nth(0)).toHaveAttribute('data-visible', 'true')
  await expect(marks.nth(1)).toHaveAttribute('data-visible', 'true')
  await expect(marks.nth(0).locator('span')).toHaveClass(/bg-text-000/)
  await expect(marks.nth(2).locator('span')).toHaveClass(/bg-text-300\/60/)
  await conversation.evaluate((el) => {
    const reply = el.querySelector('[data-message-id="agent-45"]')!
    el.scrollTop += reply.getBoundingClientRect().top - el.getBoundingClientRect().top + 40
  })
  await expect(marks.nth(45)).toHaveAttribute('data-visible', 'true')
  await expect(marks.nth(0)).not.toHaveAttribute('data-visible')
  await expect(marks.nth(45).locator('span')).toHaveClass(/bg-text-000/)
  const forwardTop = await page.locator('nav ol').evaluate((el) => el.scrollTop)
  expect(forwardTop).toBeGreaterThan(0)
  await page.screenshot({
    path: testInfo.outputPath('visible-marks-forward.png'),
    animations: 'disabled'
  })
  await conversation.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(marks.nth(0)).toHaveAttribute('data-visible', 'true')
  await expect(marks.nth(45)).not.toHaveAttribute('data-visible')
  await expect.poll(() => page.locator('nav ol').evaluate((el) => el.scrollTop)).toBe(0)
  await page.screenshot({
    path: testInfo.outputPath('visible-marks-start.png'),
    animations: 'disabled'
  })
})
