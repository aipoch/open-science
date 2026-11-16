import { expect } from '@playwright/test'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'
import { test } from './fixtures/electron-app'
import { openProjectSession } from './certification/helpers'

test.use({ windowMode: 'normal' })

test('run marks land on the selected prompt in a real variable-height transcript', async ({
  app
}, testInfo) => {
  let page = await app.completeOnboarding()
  const cwd = await app.createTestDirectory('run-navigation')
  await page.evaluate(async (cwd) => {
    const project = await window.api.projects.create({ name: 'Run navigation', description: '' })
    const now = Date.now() - 400_000
    await window.api.sessions.saveSession({
      id: 'run-navigation',
      projectId: project.id,
      title: 'Variable history',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now + 240,
      messages: Array.from({ length: 240 }, (_, index) => ({
        id: `navigation-${index}`,
        role: 'user' as const,
        content: `PROMPT ${index + 1}\n\n${'Historical message with variable height.\n'.repeat(1 + (index % 13))}`,
        status: 'complete' as const,
        eventIds: [],
        createdAt: now + index,
        updatedAt: now + index
      }))
    })
  }, cwd)
  page = await app.restart()
  const rendererErrors: string[] = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await openProjectSession(page, 'Run navigation', 'Variable history')
  const viewport = page.getByRole('region', { name: 'Conversation' })
  const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
  await expect(viewport.locator('[data-message-id="navigation-239"]')).toBeAttached()
  await page.waitForTimeout(1000)
  // Keyboard focus exposes each rail window; clicking still uses real pointer hit testing.
  for (const index of [210, 0, 30, 239]) {
    if (index === 0 || index === 239) await rail.locator(`[data-run-index="${index}"]`).focus()
    const mark = rail.locator(`[data-run-index="${index}"]`)
    await mark.hover()
    await page.screenshot({ path: testInfo.outputPath(`before-${index}.png`) })
    await mark.click()
    const offset = (): Promise<number | null> =>
      viewport.evaluate((el, index) => {
        const target = el.querySelector(`[data-message-id="navigation-${index}"]`)
        return target ? target.getBoundingClientRect().top - el.getBoundingClientRect().top : null
      }, index)
    await expect.poll(offset).toBeCloseTo(index === 0 ? 0 : 8, 0)
    await page.waitForTimeout(1200)
    expect(await offset()).toBeCloseTo(index === 0 ? 0 : 8, 0)
    await page.screenshot({ path: testInfo.outputPath(`after-${index}.png`) })
    expect(await viewport.locator('[data-message-id^="navigation-"]').count()).toBeLessThanOrEqual(
      160
    )
  }
  const storage = await page.evaluate(() => window.api.storage.getInfo())
  expect((await realpath(storage.dataRoot)).startsWith((await realpath(tmpdir())) + sep)).toBe(true)
  expect(rendererErrors).toEqual([])
})
