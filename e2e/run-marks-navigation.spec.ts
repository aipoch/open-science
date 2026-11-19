import { expect } from '@playwright/test'
import { waitForStableOffset } from './fixtures/scroll-geometry'
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
      messages: Array.from({ length: 240 }, (_, index) => {
        const turn = Math.floor(index / 2)
        const user = index % 2 === 0
        return {
          id: `navigation-${user ? 'user' : 'agent'}-${turn}`,
          role: user ? ('user' as const) : ('agent' as const),
          responseToMessageId: user ? undefined : `navigation-user-${turn}`,
          content: `${user ? 'PROMPT' : 'REPLY'} ${turn + 1}\n\n${'Historical message with variable height.\n'.repeat(1 + ((turn + (user ? 0 : 5)) % 13))}`,
          status: 'complete' as const,
          eventIds: [],
          createdAt: now + index,
          updatedAt: now + index
        }
      }),
      activities: Array.from({ length: 120 }, (_, turn) => ({
        id: `navigation-tool-${turn}`,
        kind: 'tool' as const,
        title: `Inspect history ${turn + 1}`,
        promptMessageId: `navigation-user-${turn}`,
        status: 'completed' as const,
        eventIds: [],
        sortIndex: turn * 2 + 1,
        createdAt: now + turn * 2 + 1,
        updatedAt: now + turn * 2 + 1
      }))
    })
  }, cwd)
  page = await app.restart()
  const rendererErrors: string[] = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await openProjectSession(page, 'Run navigation', 'Variable history')
  await page.getByRole('button', { name: 'Load full conversation', exact: true }).click()
  const viewport = page.getByRole('region', { name: 'Conversation' })
  const rail = page.getByRole('navigation', { name: 'Run marks' }).locator('ol')
  await expect(viewport.locator('[data-message-id="navigation-user-119"]')).toBeAttached()
  const waitFrame = (): Promise<void> =>
    page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await waitFrame()
  // Keyboard focus exposes each rail window; clicking still uses real pointer hit testing.
  await rail.locator('[data-run-index="119"]').focus()
  for (const index of [110, 0, 30, 119]) {
    if (index === 0 || index === 119) await rail.locator(`[data-run-index="${index}"]`).focus()
    const mark = rail.locator(`[data-run-index="${index}"]`)
    await mark.hover()
    await page.screenshot({ path: testInfo.outputPath(`before-${index}.png`) })
    await mark.click()
    const offset = (): Promise<number | null> =>
      viewport.evaluate((el, index) => {
        const target = el.querySelector(`[data-message-id="navigation-user-${index}"]`)
        return target ? target.getBoundingClientRect().top - el.getBoundingClientRect().top : null
      }, index)
    await waitForStableOffset(offset, waitFrame, index === 0 ? 0 : 8)
    await page.screenshot({ path: testInfo.outputPath(`after-${index}.png`) })
    expect(await viewport.locator('[data-message-id^="navigation-"]').count()).toBeLessThanOrEqual(
      160
    )
  }
  const storage = await page.evaluate(() => window.api.storage.getInfo())
  expect((await realpath(storage.dataRoot)).startsWith((await realpath(tmpdir())) + sep)).toBe(true)
  expect(rendererErrors).toEqual([])
})
