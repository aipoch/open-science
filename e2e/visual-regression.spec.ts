import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const prepareVisualPage = async (page: Page): Promise<void> => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content:
      '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }'
  })
  // The first-message jump chip reveals on upward scroll and auto-hides after idle.
  await page.addStyleTag({
    content:
      '[data-slot="message-scroller-button"][data-direction="start"] { visibility: hidden !important; }'
  })
}

const setTheme = async (page: Page, theme: 'Dark' | 'Light'): Promise<void> => {
  const homeThemeMenu = page.getByRole('button', { name: /^Theme:/ })
  const workspaceNavigation = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(homeThemeMenu.or(workspaceNavigation)).toBeVisible()
  if (await homeThemeMenu.isVisible()) {
    await homeThemeMenu.click()
    await page.getByRole('menuitem', { name: new RegExp(`^${theme}`) }).click()
  } else {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: 'General', exact: true })
      .click()
    await settings
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: theme })
      .click()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
  }
  if (theme === 'Dark') await expect(page.locator('html')).toHaveClass(/dark/)
  else await expect(page.locator('html')).not.toHaveClass(/dark/)
}

const setViewport = async (page: Page, width: number, height = 800): Promise<void> => {
  await page.setViewportSize({ width, height })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}

const setVisualState = async (
  page: Page,
  { theme, width }: { theme: 'Dark' | 'Light'; width: number }
): Promise<void> => {
  await setTheme(page, theme)
  await setViewport(page, width)
}

// MessageScroller only leaves follow-output on reader input (wheel, touch, or
// movement keys). Assigning scrollTop is treated as autoscroll and snaps back
// to the end, which is ~500px under the narrow Files overlay.
const pinConversationToStart = async (page: Page): Promise<void> => {
  const conversationViewport = page.locator('[data-slot="message-scroller-viewport"]')
  await expect
    .poll(async () => {
      await conversationViewport.evaluate((element) => {
        element.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })
        )
        element.scrollTo({ top: 0 })
      })
      return conversationViewport.evaluate((element) => element.scrollTop)
    })
    .toBe(0)
}

const pinConversationToEnd = async (page: Page): Promise<void> => {
  const conversationViewport = page.locator('[data-slot="message-scroller-viewport"]')
  await expect
    .poll(async () => {
      await conversationViewport.evaluate((element) => {
        element.scrollTo({ top: element.scrollHeight })
      })
      return conversationViewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop
      )
    })
    .toBeLessThanOrEqual(1)
}

const expectStableScreenshot = async (
  page: Page,
  name: string,
  maxDiffPixelRatio = 0.002
): Promise<void> => {
  await page.locator('a[aria-label*="GitHub"]').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await page
    .locator('button[aria-label^="Messages,"] > span[aria-hidden="true"]')
    .evaluateAll((elements) => {
      for (const element of elements) element.style.visibility = 'hidden'
    })
  await page
    .locator('[data-slot="user-message-footer"] time, [data-slot="assistant-message-footer"] time')
    .evaluateAll((timestamps) => {
      for (const timestamp of timestamps) {
        const label = timestamp.textContent?.trim().split(/\s+/, 1)[0]
        if (label) timestamp.textContent = `${label} Jan 1, 12:00 PM`
      }
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
          status: 'waiting-for-user',
          messages: [],
          activities: [
            {
              id: 'mobile-needs-you-activity',
              kind: 'tool',
              title: 'Waiting for an answer',
              status: 'in_progress',
              sortIndex: 1,
              eventIds: [],
              elicitation: {
                message: 'Choose one',
                fields: [{ id: 'choice', label: 'Choice', kind: 'text' }],
                state: 'pending',
                durable: {
                  kind: 'agent-user-choice',
                  requestId: 'mobile-needs-you-choice'
                }
              },
              createdAt: now - 2_000,
              updatedAt: now - 1_000
            }
          ],
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
  await setVisualState(page, { theme: 'Light', width: 1280 })
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
    const cardGrid = updates.locator(':scope > div')
    const cards = updates.getByRole('button')
    const availableWidth = await page.getByRole('main').evaluate((element) => element.clientWidth)
    const expectedInset = width < 768 ? 16 : 32
    const expectedCardWidth =
      width < 768
        ? availableWidth - expectedInset * 2
        : (availableWidth - expectedInset * 2 - 12) / 2

    await expect(updates).toBeVisible()
    await expect(cards.first()).toBeVisible()
    await expect
      .poll(() => cardGrid.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true)
    await expect(cards.first()).toHaveCSS('cursor', 'pointer')

    const firstCardBox = await cards.first().boundingBox()
    const secondCardBox = await cards.nth(1).boundingBox()
    expect(firstCardBox?.x).toBeCloseTo(expectedInset, 0)
    expect(firstCardBox?.width).toBeCloseTo(expectedCardWidth, 0)
    expect((firstCardBox?.x ?? 0) + (firstCardBox?.width ?? 0)).toBeLessThanOrEqual(
      availableWidth - expectedInset + 1
    )
    if (width < 768) {
      expect(secondCardBox?.x).toBeCloseTo(expectedInset, 0)
      expect(secondCardBox?.y).toBeGreaterThan((firstCardBox?.y ?? 0) + (firstCardBox?.height ?? 0))
    } else {
      expect(secondCardBox?.x).toBeCloseTo(expectedInset + expectedCardWidth + 12, 0)
      expect(secondCardBox?.y).toBeCloseTo(firstCardBox?.y ?? 0, 0)
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      )
      .toBe(true)
  }
})

test('keeps representative conversation, project, and recovery states visually stable', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await prepareVisualPage(page)
  await setVisualState(page, { theme: 'Light', width: 1280 })
  const projectId = await createProject(page, 'Visual state matrix')

  const prompts = [
    'Summarize how reproducible research benefits from keeping inputs, code, environment details, and outputs together for later inspection.',
    'Compare a quick exploratory analysis with a documented workflow that another researcher can audit, rerun, and extend.',
    'List the practical checks a team should make before sharing a computational result with collaborators or reviewers.'
  ]
  for (const prompt of prompts) {
    await sendPrompt(page, prompt, 'Deterministic reply: Summarize the deterministic fixture.')
  }
  await setVisualState(page, { theme: 'Dark', width: 1280 })
  await expect(page.locator('[data-slot="assistant-message-footer"]')).toHaveCount(prompts.length)
  await pinConversationToEnd(page)
  // Text-heavy conversation surfaces need a slightly wider budget for macOS font rasterization.
  await expectStableScreenshot(page, 'workspace-long-dark.png', 0.008)

  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.locator('[data-testid="files-view"]')).toBeVisible()
  await setVisualState(page, { theme: 'Light', width: 767 })
  await pinConversationToStart(page)
  await expectStableScreenshot(page, 'files-narrow-light.png')

  await setViewport(page, 1280)
  await page
    .locator('[data-testid="files-view"]')
    .getByRole('button', { name: 'Preview generated file provenance-evidence.txt' })
    .click()
  const preview = page.getByRole('dialog', { name: 'Preview provenance-evidence.txt' })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Open Provenance for provenance-evidence.txt' }).click()
  const provenance = page.locator('[data-testid="artifact-provenance"]')
  await expect(provenance).toBeVisible()
  await expect(provenance.getByLabel('Loading Provenance')).toBeHidden({ timeout: 30_000 })
  await expectStableScreenshot(page, 'provenance-desktop-light.png')
  await provenance.getByRole('button', { name: 'Close Provenance' }).click()
  await preview.getByRole('button', { name: 'Close preview of provenance-evidence.txt' }).click()
  await page
    .getByRole('tablist', { name: 'Open previews' })
    .getByRole('tab', { name: 'Files' })
    .press('Delete')

  await setVisualState(page, { theme: 'Dark', width: 1280 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Compute', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'SSH hosts' })).toBeVisible()
  await setViewport(page, 767)
  await expectStableScreenshot(page, 'compute-narrow-dark.png')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toBeHidden()

  page = await app.restartWithCorruptHistoricalSessionFile(projectId)
  await prepareVisualPage(page)
  await setVisualState(page, { theme: 'Light', width: 1280 })
  const recoveryAlert = page
    .getByRole('alert')
    .filter({ hasText: 'Project archive needs attention' })
  await expect(recoveryAlert).toBeVisible()
  const completedSessionDismiss = page.getByRole('button', {
    name: /Mark completed session .* as read/
  })
  if (await completedSessionDismiss.isVisible()) {
    await completedSessionDismiss.click()
    await expect(completedSessionDismiss).toBeHidden()
  }
  await expectStableScreenshot(page, 'session-recovery-warning.png')
})
