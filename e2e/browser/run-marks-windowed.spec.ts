import { expect, test, type Page, type Locator } from '@playwright/test'
import { waitForStableOffset } from '../fixtures/scroll-geometry'

const waitForStableLayout = async (
  readHeight: () => Promise<number>,
  waitFrame: () => Promise<void>
): Promise<void> => {
  await expect
    .poll(async () => {
      const samples: number[] = []
      for (let frame = 0; frame < 4; frame += 1) {
        await waitFrame()
        samples.push(await readHeight())
      }
      return samples.every((value) => value > 0 && value === samples[0])
    })
    .toBe(true)
}

const openTranscript = async (
  page: Page
): Promise<{
  viewport: Locator
  mark: (index: number) => Locator
  offset: (index: number) => Promise<number | null>
  settle: (index: number) => Promise<void>
  navigate: (index: number) => Promise<void>
}> => {
  await page.goto('/run-marks-windowed.html?count=240')
  const viewport = page.getByRole('region', { name: 'Conversation' })
  const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
  await expect(viewport.locator('[data-message-id="user-239"]')).toBeAttached()
  const waitFrame = (): Promise<void> =>
    page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await waitForStableLayout(() => viewport.evaluate((element) => element.scrollHeight), waitFrame)
  const offset = (index: number): Promise<number | null> =>
    viewport.evaluate((el, index) => {
      const target = el.querySelector(`[data-message-id="user-${index}"]`)
      return target ? target.getBoundingClientRect().top - el.getBoundingClientRect().top : null
    }, index)
  const settle = (index: number): Promise<void> =>
    waitForStableOffset(() => offset(index), waitFrame, index === 0 ? 0 : 8)
  const mark = (index: number): Locator => rail.locator(`[data-run-index="${index}"]`)
  const navigate = async (index: number): Promise<void> => {
    // Keyboard focus exposes off-screen rail windows; activation uses real pointer hit testing.
    if ((await mark(index).count()) === 0) {
      await mark(0).focus()
      for (let step = 0; step < index && (await mark(index).count()) === 0; step += 1) {
        await page.keyboard.press('Tab')
      }
    }
    await mark(index).focus()
    await mark(index).click()
    await settle(index)
  }
  return { viewport, mark, offset, settle, navigate }
}

for (const index of [70, 10]) {
  test(`production transcript settles on history row ${index + 1}`, async ({ page }) => {
    const { navigate } = await openTranscript(page)
    await navigate(index)
  })
}

test('navigates from the first message through preview and subsequent mark clicks', async ({
  page
}) => {
  const { mark, navigate, settle } = await openTranscript(page)
  await navigate(0)
  await mark(30).hover()
  await page.locator('button[data-slot="run-mark-preview"][data-open]').click()
  await settle(30)
  // This covers sequential navigation; pending-target replacement has a controlled interaction test.
  await mark(35).click()
  await settle(35)
})

test('relocates to a message from its preview after manual scrolling', async ({ page }) => {
  const { viewport, mark, offset, navigate, settle } = await openTranscript(page)
  await navigate(35)
  await viewport.hover()
  await page.mouse.wheel(0, -1000)
  await expect.poll(() => offset(35)).toBeGreaterThan(100)
  await mark(35).hover()
  await page.locator('button[data-slot="run-mark-preview"][data-open]').click()
  await settle(35)
})

test('resumes following and navigates to the last message with a bounded window', async ({
  page
}) => {
  const { viewport, navigate } = await openTranscript(page)
  await navigate(35)
  await page.getByRole('button', { name: 'Scroll to end', exact: true }).click()
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThanOrEqual(1)
  await expect(viewport.locator('[data-message-id="user-239"]')).toHaveCSS(
    'content-visibility',
    'auto'
  )
  await navigate(239)
  await expect.poll(() => viewport.locator('[data-message-id]').count()).toBeLessThanOrEqual(160)
})
