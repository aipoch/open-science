import { expect, test } from '@playwright/test'

for (const { count, expandHistory, notices } of [
  { count: 40, expandHistory: false, notices: false },
  { count: 400, expandHistory: false, notices: false },
  { count: 400, expandHistory: true, notices: false },
  { count: 1000, expandHistory: true, notices: false },
  { count: 400, expandHistory: false, notices: true },
  { count: 400, expandHistory: true, notices: true }
]) {
  test(`jumps to the first of ${count} messages (expanded history: ${expandHistory}, notices: ${notices})`, async ({
    page
  }) => {
    await page.goto(`/first-message.html?count=${count}${notices ? '&notices' : ''}`)
    const viewport = page.getByLabel('Conversation', { exact: true })
    const rows = viewport.locator('[data-message-id^="history-"]')
    if (notices) await expect(viewport.getByRole('alert')).toHaveCount(2)
    await expect(rows).toHaveCount(Math.min(80, count))
    if (count > 80) {
      await expect(viewport.locator('[data-message-id="history-0"]')).toHaveCount(0)
    }

    await viewport.hover()
    await page.mouse.wheel(0, expandHistory ? -100_000 : -150)
    if (expandHistory) {
      // A real wheel expands 80 mounted rows to 160. Returning to the first window then
      // halves the content height, which used to interrupt the button's smooth scroll.
      await expect(rows).toHaveCount(160)
      if (notices) {
        // The persistent notices can anchor expansion at the physical top. Move into
        // history and scroll upward again so the shortcut becomes eligible.
        await page.mouse.wheel(0, 1200)
        await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(1000)
        await page.mouse.wheel(0, -150)
      }
    }
    const firstMessage = page.getByRole('button', { name: 'Scroll to first message' })
    await expect(firstMessage).toBeVisible()
    await firstMessage.click()
    const firstRow = viewport.locator('[data-message-id="history-0"]')
    const firstRowOffset = (): Promise<number> =>
      firstRow.evaluate((node) => {
        const viewport = node.closest('[data-slot="message-scroller-viewport"]')!
        return Math.abs(node.getBoundingClientRect().top - viewport.getBoundingClientRect().top)
      })
    await expect(firstRow).toBeInViewport()
    await expect.poll(firstRowOffset).toBeLessThanOrEqual(1)

    // Let content-visibility and the primitive's resize/mutation observers settle. The
    // first row must stay visible, rather than briefly appearing before following resumes.
    await page.waitForTimeout(1000)
    await expect(firstRow).toBeInViewport()
    await expect.poll(firstRowOffset).toBeLessThanOrEqual(1)
    await expect(rows).toHaveCount(Math.min(80, count))

    await page.getByRole('button', { name: 'Scroll to end', exact: true }).click()
    await expect(viewport.locator(`[data-message-id="history-${count - 1}"]`)).toBeInViewport()
    await expect(rows).toHaveCount(Math.min(80, count))
  })
}
