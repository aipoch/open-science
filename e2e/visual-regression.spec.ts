import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { test } from './fixtures/electron-app'

const prepareVisualPage = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content:
      '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }'
  })

  await page.getByRole('button', { name: /^Theme:/ }).click()
  await page.getByRole('menuitem', { name: /^Light/ }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
}

const expectStableScreenshot = async (
  page: Page,
  name: string,
  maxDiffPixelRatio = 0.002
): Promise<void> => {
  await page.locator('a[aria-label*="GitHub"]').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await expect(page).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: process.platform === 'darwin' ? maxDiffPixelRatio : 0.035
  })
}

const seedHomeActivitySessions = async (page: Page, cwd: string): Promise<void> => {
  await page.evaluate(
    async ({ sessionCwd }) => {
      const bridge = globalThis as unknown as {
        api: {
          projects: {
            create: (request: { name: string; description: string }) => Promise<{ id: string }>
          }
          sessions: {
            saveSession: (session: PersistedChatSession) => Promise<unknown>
          }
        }
      }
      const project = await bridge.api.projects.create({
        name: 'Mobile activity project',
        description: 'Responsive activity-card fixture.'
      })
      const now = Date.now()
      const sessions: PersistedChatSession[] = [
        {
          id: 'mobile-needs-you-session',
          projectId: project.id,
          title: 'Review a long session result on iPhone',
          cwd: sessionCwd,
          status: 'waiting-permission',
          messages: [],
          createdAt: now - 2_000,
          updatedAt: now - 1_000
        },
        {
          id: 'mobile-running-session',
          projectId: project.id,
          title: 'Run a long analysis on iPhone',
          cwd: sessionCwd,
          status: 'running',
          messages: [],
          createdAt: now - 1_000,
          updatedAt: now
        },
        {
          id: 'mobile-running-secondary-session',
          projectId: project.id,
          title: 'Run another active analysis on iPhone',
          cwd: sessionCwd,
          status: 'running',
          messages: [],
          createdAt: now,
          updatedAt: now + 1_000
        }
      ]

      for (const session of sessions) await bridge.api.sessions.saveSession(session)
    },
    { sessionCwd: cwd }
  )

  await expect(
    page.getByRole('region', { name: 'Session updates' }).getByRole('button')
  ).toHaveCount(3)
}

test('keeps core desktop surfaces visually stable', async ({ app }) => {
  const page = await app.completeOnboarding()
  await prepareVisualPage(page)
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()

  await page.getByRole('button', { name: 'Theme: Light' }).click()
  const systemDescription = page.getByText('Match your device', { exact: true })
  await expect(systemDescription).toBeVisible()
  await expect(systemDescription).toHaveCSS('white-space', 'nowrap')
  await page.keyboard.press('Escape')

  await expectStableScreenshot(page, 'home-empty.png')

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(projectDialog).toBeVisible()
  await expectStableScreenshot(page, 'project-create-dialog.png')

  await projectDialog.getByLabel('Name').fill('Visual baseline project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await expectStableScreenshot(page, 'workspace-empty.png')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  const appVersion = settings.getByRole('region', { name: 'App version' })
  await appVersion.getByRole('button').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await appVersion.locator(':scope > p').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  // The text-dense settings surface has slightly different font antialiasing on macos-14 runners.
  await expectStableScreenshot(page, 'settings-general.png', 0.004)
})

test('keeps home actions and content inside compact viewports', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seedHomeActivitySessions(page, await app.createTestDirectory('mobile-activity-project'))

  for (const width of [320, 375, 390, 414, 768]) {
    await page.setViewportSize({ width, height: 800 })

    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
    const updates = page.getByRole('region', { name: 'Session updates' })
    const scroller = updates.locator(':scope > div')
    const cards = updates.getByRole('button')
    const expectedInset = width < 768 ? 16 : 32
    const expectedCardWidth =
      width < 768 ? width - expectedInset * 2 : (width - expectedInset * 2 - 12) / 2

    await expect(updates).toBeVisible()
    await expect(cards.first()).toBeVisible()
    await scroller.evaluate((element) => element.scrollTo({ left: 0, behavior: 'instant' }))
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true)

    const firstCardBox = await cards.first().boundingBox()
    expect(firstCardBox?.x).toBeCloseTo(expectedInset, 0)
    expect(firstCardBox?.width).toBeCloseTo(expectedCardWidth, 0)
    expect((firstCardBox?.x ?? 0) + (firstCardBox?.width ?? 0)).toBeLessThanOrEqual(
      width - expectedInset + 1
    )

    await scroller.evaluate((element) => {
      const secondCard = element.querySelectorAll<HTMLElement>('button')[1]
      if (!secondCard) throw new Error('Expected a second activity card.')
      element.scrollTo({
        left: secondCard.offsetLeft - Number.parseFloat(getComputedStyle(element).paddingLeft),
        behavior: 'instant'
      })
    })
    await expect
      .poll(async () => (await cards.nth(1).boundingBox())?.x)
      .toBeCloseTo(expectedInset, 0)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      )
      .toBe(true)
  }
})
