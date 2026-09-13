import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'

test.use({ windowMode: 'normal' })

test('bounds history scrolling and preserves native find across the transcript', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('transcript-capacity')
  await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({
      name: 'Transcript capacity',
      description: ''
    })
    const now = Date.now() - 400_000
    await window.api.sessions.saveSession({
      id: 'capacity-history',
      projectId: project.id,
      title: 'Capacity history',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now + 400,
      messages: Array.from({ length: 400 }, (_, index) => ({
        id: `capacity-${index}`,
        role: 'user' as const,
        content: `CAPACITYTOKEN${String(index).padStart(4, '0')}\n\n${'Historical paragraph for scrolling. '.repeat(5)}`,
        status: 'complete' as const,
        eventIds: [],
        createdAt: now + index,
        updatedAt: now + index
      }))
    })
  }, cwd)
  page = await app.restart()
  const openedAt = performance.now()
  await openProjectSession(page, 'Transcript capacity', 'Capacity history')
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  const rows = viewport.locator('[data-message-id^="capacity-"]')
  await expect(rows).toHaveCount(80)
  const openMs = performance.now() - openedAt
  const scrollMs: number[] = []
  const counts: number[] = [80]
  await viewport.hover()
  for (let i = 0; i < 4; i++) {
    const first = await rows.first().getAttribute('data-message-id')
    const startedAt = performance.now()
    await page.mouse.wheel(0, -100_000)
    await expect.poll(() => rows.first().getAttribute('data-message-id')).not.toBe(first)
    scrollMs.push(performance.now() - startedAt)
    counts.push(await rows.count())
    expect(counts.at(-1)).toBeLessThanOrEqual(160)
  }
  await expect(rows.first()).toHaveAttribute('data-message-id', 'capacity-0')
  const modifiers = process.platform === 'darwin' ? (['meta'] as const) : (['control'] as const)
  await app.pressMainWindowShortcut('F', [...modifiers])
  await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  await expect
    .poll(() =>
      page
        .context()
        .pages()
        .some((p) => p.url().includes('/find-overlay/'))
    )
    .toBe(true)
  const overlay = page
    .context()
    .pages()
    .find((p) => p.url().includes('/find-overlay/'))!
  for (const index of [0, 200, 399]) {
    await overlay.getByRole('textbox').fill(`CAPACITYTOKEN${String(index).padStart(4, '0')}`)
    await expect(viewport.locator(`[data-message-id="capacity-${index}"]`)).toBeInViewport()
    // Native find must keep its match visible when deferred transcript layout settles.
    await viewport.evaluate((element) => {
      element.style.height = `${element.clientHeight - 20}px`
    })
    await expect(viewport.locator(`[data-message-id="capacity-${index}"]`)).toBeInViewport()
  }
  await overlay.getByRole('button', { name: 'Close find' }).click()
  await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
  await expect.poll(() => rows.count()).toBeLessThanOrEqual(160)
  const screenshot = testInfo.outputPath('transcript-capacity.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('transcript-capacity', { path: screenshot, contentType: 'image/png' })
  const timingsPath = testInfo.outputPath('transcript-timings.json')
  await writeFile(
    timingsPath,
    JSON.stringify({
      messageCount: 400,
      mountedRows: counts,
      openMs,
      scrollMs,
      measurement:
        'Playwright wall time from wheel to changed first row; includes automation and polling latency, not frame time'
    })
  )
  await testInfo.attach('transcript-timings', {
    path: timingsPath,
    contentType: 'application/json'
  })
})
