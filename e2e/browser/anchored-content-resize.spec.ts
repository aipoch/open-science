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
      // Streaming presentation can change height during an animation frame. Sample the next
      // frame before a deferred resize repair can hide a one-frame jump.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          button.click()
          resolve()
        })
      )
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

test('scrolls overflowing content without rescanning its padding or rewriting unchanged state', async ({
  page
}) => {
  const viewport = page.getByRole('region')
  await page.locator('[data-message-id="tail"] > div').evaluate((element) => {
    ;(element as HTMLElement).style.height = '2000px'
  })
  await expect(page.locator('[data-message-scroller-spacer]')).toHaveAttribute('hidden', '')
  await viewport.hover()
  const initial = await viewport.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, -200)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(initial)
  // Let the initial native wheel and autoscroll flag settle before measuring a stable range.
  await page.waitForTimeout(300)
  await viewport.evaluate((element) => {
    const content = element.querySelector('[data-slot="message-scroller-content"]')!
    const state = { styleReads: 0, repeatedStateWrites: 0 }
    Object.assign(window, { __scrollWork: state })
    const getComputedStyle = window.getComputedStyle
    window.getComputedStyle = (...args) => {
      if (args[0] === content) state.styleReads++
      return getComputedStyle(...args)
    }
    const observer = new MutationObserver((records) => {
      state.repeatedStateWrites += records.filter(
        (record) => record.oldValue === element.getAttribute(record.attributeName!)
      ).length
    })
    observer.observe(element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-scrollable']
    })
  })
  const before = await viewport.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, -160)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(before)
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __scrollWork: { styleReads: number; repeatedStateWrites: number } })
          .__scrollWork
    )
  ).toEqual({ styleReads: 0, repeatedStateWrites: 0 })
})
