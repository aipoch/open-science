import { expect, test } from '@playwright/test'

const plotSelector = '[aria-label="Stacked daily token usage for the last 30 days"]'
const tooltipSelector = '[data-slot="token-usage-inspection"]'

test('continuously inspects columns and zero days without remounting or changing bars', async ({
  page
}, testInfo) => {
  await page.goto('/usage-inspection.html')
  const plot = page.locator(plotSelector)
  await plot.scrollIntoViewIfNeeded()
  const bounds = (await plot.boundingBox())!
  const bar = plot.getByRole('button').nth(15).locator('[aria-hidden=true]')
  const height = await bar.evaluate((el) => el.getBoundingClientRect().height)
  const move = async (index: number): Promise<void> =>
    page.mouse.move(bounds.x + (bounds.width * (index + 0.5)) / 30, bounds.y + 15)
  await move(5)
  const tooltip = page.locator(tooltipSelector)
  await expect(tooltip).toContainText('2026-09-08')
  await expect(tooltip).toContainText('Input (uncached)0')
  await expect(plot.locator('[data-inspected]')).toHaveAttribute(
    'aria-label',
    /0 input, 0 cache, 0 output/
  )
  await tooltip.evaluate((el) => el.setAttribute('data-same-surface', 'yes'))
  await move(15)
  await expect(tooltip).toHaveAttribute('data-same-surface', 'yes')
  await expect(tooltip).toContainText('2026-09-18')
  await expect(tooltip).toContainText('280,000,000')
  await expect(plot.locator('[data-inspected]')).toHaveAttribute('aria-label', /160,000,000 input/)
  expect(await bar.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)
  // The exact boundary formerly occupied by a grid gap is inspectable too.
  await page.mouse.move(bounds.x + (bounds.width * 16) / 30 + 0.1, bounds.y + 10)
  await expect(tooltip).toContainText('2026-09-19')
  await expect(tooltip).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await page.mouse.move(bounds.x + (bounds.width * 16.6) / 30, bounds.y + 20)
  await expect(tooltip).toHaveCount(0)
  await move(17)
  await expect(tooltip).toContainText('2026-09-20')
  await page.screenshot({ path: testInfo.outputPath('usage-light.png') })
})

test('keeps the tooltip hoverable and dismisses stale inspection on scroll and resize', async ({
  page
}) => {
  await page.goto('/usage-inspection.html')
  const plot = page.locator(plotSelector)
  await plot.getByRole('button').nth(12).hover()
  const tooltip = page.locator(tooltipSelector)
  await expect(tooltip).toBeVisible()
  await tooltip.hover()
  await page.waitForTimeout(160) // Beyond the pointer-transfer grace period.
  await expect(tooltip).toBeVisible()
  // A wheel event over the tooltip can be consumed by its own scroll container.
  const scrollBefore = await page.evaluate(() => window.scrollY)
  await page.evaluate(() => window.scrollBy(0, 150))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore)
  await expect(tooltip).toHaveCount(0)
  await plot.getByRole('button').last().hover()
  await expect(tooltip).toContainText('2026-10-02')
  await page.setViewportSize({ width: 900, height: 720 })
  await expect(tooltip).toHaveCount(0)
})

test('supports keyboard inspection, Escape and outside dismissal', async ({ page }) => {
  await page.goto('/usage-inspection.html')
  const plot = page.locator(plotSelector)
  const buttons = plot.getByRole('button')
  await buttons.nth(5).focus()
  const tooltip = page.locator(tooltipSelector)
  await expect(tooltip).toContainText('2026-09-08')
  await expect(buttons.nth(5)).toHaveAttribute(
    'aria-describedby',
    (await tooltip.getAttribute('id')) as string
  )
  await page.keyboard.press('Tab')
  await expect(buttons.nth(6)).toBeFocused()
  await expect(tooltip).toContainText('2026-09-09')
  await expect(tooltip).toHaveCSS('transition-duration', '0s')
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(buttons.nth(6)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tooltip).toBeVisible()
  await page.mouse.click(2, 2)
  await expect(tooltip).toHaveCount(0)
})

test('interpolates pointer position only, and disables motion for reduced motion', async ({
  page
}) => {
  await page.goto('/usage-inspection.html')
  const plot = page.locator(plotSelector)
  await plot.scrollIntoViewIfNeeded()
  const bounds = (await plot.boundingBox())!
  await page.mouse.move(bounds.x + 10, bounds.y + 30)
  const tooltip = page.locator(tooltipSelector)
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toHaveCSS('transition-duration', '0s')
  const samples = await page.evaluate(
    ({ x, y, selector, tooltipSelector }) => {
      const plot = document.querySelector(selector)!
      const tooltip = document.querySelector(tooltipSelector)!
      const before = tooltip.getBoundingClientRect().x
      plot.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: x + 250,
          clientY: y + 30
        })
      )
      // Sample the actual CSS transition independently of the runner's frame scheduling.
      const transition = tooltip
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === 'transform'
        )
      const endTime = transition?.effect?.getComputedTiming().endTime
      if (!transition || typeof endTime !== 'number')
        throw new Error('Tooltip did not start a timed transform transition.')
      transition.pause()
      transition.currentTime = endTime / 2
      const during = tooltip.getBoundingClientRect().x
      transition.finish()
      return { before, during, after: tooltip.getBoundingClientRect().x }
    },
    { x: bounds.x, y: bounds.y, selector: plotSelector, tooltipSelector }
  )
  expect(samples.during).toBeGreaterThan(samples.before)
  expect(samples.during).toBeLessThan(samples.after)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.move(bounds.x + 400, bounds.y + 30)
  await expect(tooltip).toHaveCSS('transition-property', 'none')
})

test('fits localized narrow and dark layouts and permits touch inspection', async ({
  browser
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce'
  })
  const page = await context.newPage()
  await page.goto('/usage-inspection.html?lang=de&dark=1')
  const plot = page.locator('[data-slot="token-usage-bars"] [role="group"]')
  for (const index of [0, 29]) {
    await plot.getByRole('button').nth(index).tap()
    const tooltip = page.locator(tooltipSelector)
    await expect(tooltip).toBeVisible()
    await page.waitForTimeout(160) // Touch selection persists beyond hover leave grace.
    await expect(tooltip).toBeVisible()
    const bounds = (await tooltip.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(15)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
    expect(await tooltip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('usage-dark-narrow.png') })
  await context.close()
})
