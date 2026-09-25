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
  await page.goto('/run-marks.html?count=100')
  const conversation = page.getByRole('region', { name: 'Conversation' })
  const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
  const marks = rail.getByRole('button')
  expect(await marks.count()).toBeLessThanOrEqual(75)
  const pitch = (): Promise<number> =>
    marks.evaluateAll(
      (buttons) => buttons[2].getBoundingClientRect().top - buttons[1].getBoundingClientRect().top
    )
  expect(await pitch()).toBe(8)
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
  await readRun(75)
  await expect.poll(railTop).toBeGreaterThan(60)
  const before = await railTop()
  await readRun(75, 60)
  await expect.poll(railTop).toBeGreaterThan(before)
  expect((await railTop()) - before).toBeLessThan(8)
  expect(await pitch()).toBe(8)
  await page.getByRole('button', { name: /^Go to run 76:/ }).hover()
  await expect(page.getByRole('tooltip')).toContainText('76. Compare')
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
  await readRun(99)
  await expect.poll(railTop).toBe(320)
  await marks.last().focus()
  await expect(marks.last()).toBeFocused()
  await readRun(0)
  await expect.poll(railTop).toBe(0)
  expect(await pitch()).toBe(8)
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
      .locator('li:not([role="presentation"])')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height)
  ).toBe(8)
  await page.setViewportSize({ width: 600, height: 800 })
  await expect(rail).toBeHidden()
})

for (const [count, pitch] of [
  [4, 8],
  [30, 8],
  [60, 8]
]) {
  test(`uses ${pitch}px spacing for ${count} messages`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 820 })
    await page.goto(`/run-marks.html?count=${count}`)
    const marks = page
      .getByRole('navigation', { name: 'Run marks' })
      .locator('li:not([role="presentation"])')
    expect(await marks.count()).toBeLessThanOrEqual(count + 1)
    expect(await marks.first().evaluate((el) => el.getBoundingClientRect().height)).toBe(pitch)
  })
}

test('keeps visible conversation segments dark without hover and updates them on scroll', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html?count=100')
  const conversation = page.getByRole('region', { name: 'Conversation' })
  const marks = page.getByRole('navigation', { name: 'Run marks' }).getByRole('button')
  const visible = page.locator('nav button[data-visible="true"]')
  await expect(visible).toHaveCount(2)
  await expect(marks.nth(0)).toHaveAttribute('data-visible', 'true')
  await expect(marks.nth(1)).toHaveAttribute('data-visible', 'true')
  await expect(marks.nth(0).locator('span')).toHaveClass(/bg-text-000/)
  await expect(marks.nth(2).locator('span')).toHaveClass(/bg-text-300\/60/)
  await conversation.evaluate((el) => {
    const reply = el.querySelector('[data-message-id="agent-75"]')!
    el.scrollTop += reply.getBoundingClientRect().top - el.getBoundingClientRect().top + 40
  })
  await expect(page.getByRole('button', { name: /^Go to run 76:/ })).toHaveAttribute(
    'data-visible',
    'true'
  )
  await expect(marks.nth(0)).not.toHaveAttribute('data-visible')
  await expect(page.getByRole('button', { name: /^Go to run 76:/ }).locator('span')).toHaveClass(
    /bg-text-000/
  )
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
  await expect(
    page.getByRole('button', { name: /^Go to run 76:/ }).and(page.locator('[data-visible]'))
  ).toHaveCount(0)
  await expect.poll(() => page.locator('nav ol').evaluate((el) => el.scrollTop)).toBe(0)
  await page.screenshot({
    path: testInfo.outputPath('visible-marks-start.png'),
    animations: 'disabled'
  })
})

test('moves one preview card between marks and disables motion when requested', async ({
  page
}) => {
  await page.goto('/run-marks.html?count=4')
  const marks = page.getByRole('navigation', { name: 'Run marks' }).getByRole('button')
  await marks.nth(0).hover()
  const preview = page.getByRole('tooltip')
  await expect(preview).toBeVisible()
  await preview.evaluate((element) => element.setAttribute('data-test-retained', 'true'))
  await expect(preview).toHaveCSS('width', '256px')
  const initialTop = await preview.evaluate((element) => element.getBoundingClientRect().top)
  await marks.nth(3).hover()
  await expect(preview).toHaveAttribute('data-test-retained', 'true')
  await expect(preview).toContainText('4. Compare')
  await expect
    .poll(() => preview.evaluate((element) => element.getBoundingClientRect().top))
    .toBeGreaterThan(initialTop + 20)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await marks.nth(1).focus()
  await expect(preview).toBeVisible()
  await expect(preview).toHaveCSS('transition-property', 'none')
  await expect(marks.nth(1)).toHaveAttribute(
    'aria-describedby',
    await preview.evaluate((element) => element.id)
  )
})

test('dismisses the preview when panel resizing moves the rail without a window resize', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html?count=4')
  const mark = page.getByRole('navigation', { name: 'Run marks' }).getByRole('button').nth(1)
  await mark.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  const previousLeft = await mark.evaluate((element) => element.getBoundingClientRect().left)
  await page.locator('aside').evaluate((element) => {
    element.style.width = '320px'
  })
  await expect
    .poll(() => mark.evaluate((element) => element.getBoundingClientRect().left))
    .toBeGreaterThan(previousLeft)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await mark.evaluate((element) => element.blur())
  await mark.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await expect
    .poll(async () => {
      const markRight = await mark.evaluate((element) => element.getBoundingClientRect().right)
      const previewLeft = await page
        .getByRole('tooltip')
        .evaluate((element) => element.getBoundingClientRect().left)
      return Math.abs(previewLeft - markRight - 8)
    })
    .toBeLessThan(1)
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('resized-panel-preview.png')
  })
})

test('bounds mounted marks for thousands of runs while preserving sequential keyboard navigation', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html?count=2000')
  const rail = page.getByRole('navigation', { name: 'Run marks' })
  const marks = rail.getByRole('button')
  await expect(rail).toBeVisible()
  expect(await marks.count()).toBeLessThanOrEqual(75)
  const conversation = page.getByRole('region', { name: 'Conversation' })
  const readingTop = await conversation.evaluate((element) => element.scrollTop)
  await page.getByRole('button', { name: /^Go to run 1:/ }).focus()
  for (let index = 2; index <= 65; index++) {
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('button', { name: new RegExp(`^Go to run ${index}:`) })
    ).toBeFocused()
  }
  expect(await marks.count()).toBeLessThanOrEqual(75)
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(readingTop)
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: /^Go to run 64:/ })).toBeFocused()
  await conversation.evaluate((element) => {
    element.scrollTop = 100
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(page.getByRole('button', { name: /^Go to run 64:/ })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /^Go to run 65:/ })).toBeFocused()
  await page.getByRole('button', { name: /^Go to run 2000:/ }).focus()
  await expect(page.getByRole('button', { name: /^Go to run 2000:/ })).toBeFocused()
  await page.screenshot({
    path: testInfo.outputPath('bounded-rail-keyboard.png'),
    animations: 'disabled'
  })
  await rail.evaluate((element) => {
    const before = document.createElement('button')
    before.textContent = 'Before rail'
    const after = document.createElement('button')
    after.textContent = 'After rail'
    element.before(before)
    element.after(after)
  })
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'After rail' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: /^Go to run 2000:/ })).toBeFocused()
  await page.getByRole('button', { name: /^Go to run 1:/ }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: 'Before rail' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /^Go to run 1:/ })).toBeFocused()
  await page.getByRole('button', { name: /^Go to run 2000:/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /^Go to run 2000:/ })).toHaveAttribute(
    'aria-current',
    'location'
  )
})

test('keeps a virtualized rail and its preview on the correct side in RTL', async ({ page }) => {
  await page.goto('/run-marks.html?count=2000')
  await page.locator('html').evaluate((element) => {
    element.setAttribute('dir', 'rtl')
  })
  await page.setViewportSize({ width: 1100, height: 800 })
  const mark = page.getByRole('button', { name: /^Go to run 1:/ })
  await mark.focus()
  const preview = page.getByRole('tooltip')
  await expect(preview).toBeVisible()
  expect((await preview.boundingBox())!.x).toBeLessThan((await mark.boundingBox())!.x)
  const railRight = (await page.getByRole('navigation', { name: 'Run marks' }).boundingBox())!
  const viewportRight = (await page.getByRole('region', { name: 'Conversation' }).boundingBox())!
  expect(railRight.x + railRight.width).toBeCloseTo(viewportRight.x + viewportRight.width + 8, 0)
})

test('moves a continuous wave within one target without changing hit geometry', async ({
  page
}, testInfo) => {
  await page.goto('/run-marks.html?count=60')
  const rail = page.getByRole('navigation', { name: 'Run marks' })
  const marks = rail.getByRole('button')
  const mark = marks.nth(30)
  const before = (await mark.boundingBox())!
  const scale = (index: number): Promise<number> =>
    marks
      .nth(index)
      .locator('span')
      .evaluate((element) => parseFloat((element as HTMLElement).style.scale))
  await page.mouse.move(before.x + 12, before.y + 4)
  await expect(page.getByRole('tooltip')).toContainText('31. Compare')
  await expect.poll(() => scale(30)).toBeCloseTo(1)
  await page.mouse.move(before.x + 12, before.y + 6)
  await expect.poll(() => scale(30)).toBeLessThan(1)
  expect(await scale(31)).toBeGreaterThan(await scale(29))
  expect(await scale(30)).toBeGreaterThan(await scale(31))
  expect(await scale(26)).toBeCloseTo(0.4)
  await expect(page.getByRole('tooltip')).toContainText('31. Compare')
  expect(await mark.boundingBox()).toEqual(before)
  await page.screenshot({ path: testInfo.outputPath('dense-wave.png') })
  await page.mouse.move(before.x + 12, before.y + 8)
  await expect.poll(async () => Math.abs((await scale(30)) - (await scale(31)))).toBeLessThan(0.001)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(mark.locator('span')).toHaveCSS('transition-property', 'none')
  await page.mouse.move(before.x + 100, before.y + 100)
  await expect.poll(() => scale(30)).toBe(0.4)
})
