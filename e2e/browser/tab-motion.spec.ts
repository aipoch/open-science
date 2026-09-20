import { expect, test, type Locator } from '@playwright/test'

type MotionFrame = { x: number; y: number; width: number; bottomOffset: number }

// Observe actual painted geometry across frames, not only final selected styles.
const recordMotion = async (list: Locator): Promise<void> => {
  await list.evaluate((element) => {
    const frames: MotionFrame[] = []
    Object.assign(element, { motionFrames: frames })
    element.addEventListener(
      'pointerdown',
      () => {
        const start = performance.now()
        const sample = (): void => {
          const tab = element.querySelector('[aria-selected="true"]')
          const box = tab?.querySelector(':scope > span[aria-hidden]')?.getBoundingClientRect()
          if (box && tab)
            frames.push({
              x: box.x,
              y: box.y,
              width: box.width,
              bottomOffset: box.bottom - tab.getBoundingClientRect().bottom
            })
          if (performance.now() - start < 400) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      },
      { once: true }
    )
  })
}
const frames = (list: Locator): Promise<MotionFrame[]> =>
  list.evaluate(
    (element) => (element as typeof element & { motionFrames: MotionFrame[] }).motionFrames
  )
const expectAligned = async (list: Locator): Promise<void> => {
  await expect
    .poll(async () =>
      list.evaluate((element) => {
        const tab = element.querySelector('[aria-selected="true"]')!.getBoundingClientRect()
        const indicator = element
          .querySelector('[aria-selected="true"] > span[aria-hidden]')!
          .getBoundingClientRect()
        return Math.max(Math.abs(tab.x - indicator.x), Math.abs(tab.width - indicator.width))
      })
    )
    .toBeLessThan(1)
}

test('slides both indicators without overshoot or moving the hit targets', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/tab-motion.html?duplicate')
  for (const selector of ['[data-models]', '[data-capabilities]']) {
    const list = page.locator(selector).getByRole('tablist')
    const tabs = list.getByRole('tab')
    const from = (await tabs.first().boundingBox())!
    const to = (await tabs.last().boundingBox())!
    await recordMotion(list)
    await tabs.last().click()
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
    await expectAligned(list)
    const samples = await frames(list)
    expect(samples.some(({ x }) => x > from.x + 2 && x < to.x - 2)).toBe(true)
    expect(samples.every(({ x }) => x >= from.x - 1 && x <= to.x + 1)).toBe(true)
    expect((await tabs.first().boundingBox())!.x).toBeCloseTo(from.x, 0)
    await tabs.first().click()
    await tabs.last().click()
    await tabs.first().click()
    await expectAligned(list)
  }
  await expect(page.locator('[data-second-models]').getByRole('tab').first()).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expectAligned(page.locator('[data-second-models]').getByRole('tablist'))
})

test('preserves manual keyboard activation and full-access disabling', async ({ page }) => {
  await page.goto('/tab-motion.html')
  const section = page.locator('[data-capabilities]')
  const tabs = section.getByRole('tab')
  await tabs.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.last()).toBeFocused()
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
  await expectAligned(section.getByRole('tablist'))
  await section.getByRole('switch').click()
  await expect(tabs.first()).toBeDisabled()
  await expect(tabs.last()).toBeDisabled()
  await section.getByRole('switch').click()
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
})

for (const locale of ['en', 'de', 'zh-Hans']) {
  test(`aligns after scrolling with reduced motion and ${locale} labels`, async ({
    page
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 640, height: 760 })
    await page.goto(`/tab-motion.html?dark&locale=${locale}`)
    await page.locator('[data-scroll-frame]').evaluate((element) => {
      element.scrollTop = 24
    })
    for (const selector of ['[data-models]', '[data-capabilities]']) {
      const list = page.locator(selector).getByRole('tablist')
      await recordMotion(list)
      await list.getByRole('tab').last().click()
      await expectAligned(list)
      const target = (await list.getByRole('tab').last().boundingBox())!
      const samples = await frames(list)
      // Frames may include the old state before React commits, but never an intermediate slide.
      const oldX = (await list.getByRole('tab').first().boundingBox())!.x
      expect(samples.every(({ x }) => Math.abs(x - oldX) < 1 || Math.abs(x - target.x) < 1)).toBe(
        true
      )
    }
    await page.screenshot({ path: testInfo.outputPath(`tabs-${locale}-dark.png`) })
  })
}

test('animates model selection through the production SettingsPage history', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/tab-motion.html?settings')
  const list = page.getByRole('tablist', { name: 'Models', exact: true })
  const tabs = list.getByRole('tab')
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await list.evaluate((element) => {
    element.setAttribute('data-original-list', 'true')
  })
  const from = (await tabs.first().boundingBox())!
  const to = (await tabs.last().boundingBox())!
  await recordMotion(list)
  await tabs.last().click()
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
  await expect(list).toHaveAttribute('data-original-list', 'true')
  await expectAligned(list)
  expect((await frames(list)).some(({ x }) => x > from.x + 2 && x < to.x - 2)).toBe(true)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
  await expect(list).toHaveAttribute('data-original-list', 'true')
  await expectAligned(list)
})

test('keeps a capability indicator level when switching after a scroll', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 900, height: 600 })
  await page.goto('/tab-motion.html')
  const scroller = page.locator('[data-scroll-frame]')
  await scroller.evaluate((element) => {
    element.scrollTop = 120
  })
  const list = page.locator('[data-capabilities]').getByRole('tablist')
  const from = (await list.getByRole('tab').first().boundingBox())!
  await recordMotion(list)
  await list.getByRole('tab').last().click()
  await expectAligned(list)
  const samples = await frames(list)
  expect(samples.length).toBeGreaterThan(1)
  expect(samples.every(({ y }) => Math.abs(y - from.y) < 1)).toBe(true)
})

test('tracks the actual settings scroller while animating a partially scrolled model tab', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 900, height: 360 })
  await page.goto('/tab-motion.html?settings')
  const list = page.getByRole('tablist', { name: 'Models', exact: true })
  await list.getByRole('tab').last().click()
  await expectAligned(list)
  const scroller = page.locator('[data-slot="settings-content-scroll"]')
  await scroller.evaluate((element) => {
    element.scrollTop = 12
  })
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(12)
  const target = (await list.getByRole('tab').first().boundingBox())!
  await recordMotion(list)
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
  await expect(list.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await expectAligned(list)
  const samples = await frames(list)
  expect(samples.length).toBeGreaterThan(1)
  expect(samples.every(({ bottomOffset }) => Math.abs(bottomOffset) < 1)).toBe(true)
})
