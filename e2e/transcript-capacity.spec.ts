import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'
import { openGeneralSettings } from './fixtures/settings-preferences'

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

test('does not force unannotated transcript geometry during native layout changes', async ({
  app
}, testInfo) => {
  let page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('layout-history')
  await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({ name: 'Layout history', description: '' })
    const now = Date.now() - 400_000
    await window.api.sessions.saveSession({
      id: 'layout-history',
      projectId: project.id,
      title: 'Layout history',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now + 400,
      messages: Array.from({ length: 400 }, (_, index) => ({
        id: `layout-${index}`,
        role: index % 2 ? ('agent' as const) : ('user' as const),
        content:
          index % 2
            ? `## Result ${index}\n\n${'Historical paragraph for resizing. '.repeat(20)}\n\n| Column | Value |\n| --- | --- |\n| Data | 123 |\n\n\`\`\`python\nprint("layout")\n\`\`\``
            : index === 380
              ? 'Long historical prompt line.\n'.repeat(30)
              : `Historical question ${index}. ${'Explain the data. '.repeat(10)}`,
        status: 'complete' as const,
        eventIds: [],
        createdAt: now + index,
        updatedAt: now + index
      }))
    })
  }, cwd)
  page = await app.restart()
  await openProjectSession(page, 'Layout history', 'Layout history')
  await expect(page.locator('[data-message-id="layout-399"]')).toBeVisible()
  await expect(page.locator('[data-slot="message-scroller-item"]')).toHaveCount(80)
  await expect(page.locator('[data-annotation-surface]').first()).toBeAttached()

  // Count the synchronous geometry reads identified by the issue's CPU reproduction.
  // Work counts are deterministic; wall-clock/CPU thresholds would vary across CI runners.
  await page.evaluate(() => {
    const original = Element.prototype.getBoundingClientRect
    let reads = 0
    Object.defineProperty(window, '__unannotatedLayoutProbe', {
      configurable: true,
      value: {
        count: () => reads,
        restore: () => {
          Element.prototype.getBoundingClientRect = original
        }
      }
    })
    Element.prototype.getBoundingClientRect = function () {
      if (
        this.matches(
          '[data-annotation-surface]:not([data-annotation-active]):not([data-bookmark-active])'
        )
      )
        reads++
      return original.call(this)
    }
  })
  const counts: Record<string, number> = {}
  const readCount = (): Promise<number> =>
    page.evaluate(() =>
      (
        window as unknown as { __unannotatedLayoutProbe: { count: () => number } }
      ).__unannotatedLayoutProbe.count()
    )
  try {
    const settings = await openGeneralSettings(page)
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await expect(settings).toBeHidden()
    counts.settings = await readCount()
    for (let i = 0; i < 12; i++) {
      await app.setMainWindowSize(1050 + i * 15, 800 + (i % 5) * 10)
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      )
    }
    counts.resize = (await readCount()) - counts.settings
    await testInfo.attach('unannotated-geometry-reads', {
      body: JSON.stringify(counts),
      contentType: 'application/json'
    })
    expect(counts, 'empty marker surfaces must not force offscreen layout').toEqual({
      settings: 0,
      resize: 0
    })
    await page.screenshot({ path: testInfo.outputPath('resized-history.png') })
  } finally {
    await page.evaluate(() => {
      ;(
        window as unknown as { __unannotatedLayoutProbe: { restore: () => void } }
      ).__unannotatedLayoutProbe.restore()
      Reflect.deleteProperty(window, '__unannotatedLayoutProbe')
    })
  }

  // An offscreen user row must still measure and offer disclosure on entry.
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  const longRow = viewport.locator('[data-message-id="layout-380"]')
  await longRow.scrollIntoViewIfNeeded()
  await expect(longRow).toBeInViewport()
  await longRow.getByRole('button', { name: 'Show more', exact: true }).click()
  await expect(longRow.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  await longRow.getByRole('button', { name: 'Show less', exact: true }).click()
  await expect(longRow.getByRole('button', { name: 'Show more', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})
