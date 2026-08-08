import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const prepareVisualPage = async (page: Page): Promise<void> => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content:
      '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }'
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

test('keeps core desktop surfaces visually stable', async ({ app }) => {
  const page = await app.completeOnboarding()
  await prepareVisualPage(page)
  await setVisualState(page, { theme: 'Light', width: 1280 })
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
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
  const conversationViewport = page.locator('[data-slot="message-scroller-viewport"]')
  await conversationViewport.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect.poll(() => conversationViewport.evaluate((element) => element.scrollTop)).toBe(0)
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

  await app.writeCorruptSessionFile(projectId)
  page = await app.restart()
  await prepareVisualPage(page)
  await setVisualState(page, { theme: 'Light', width: 1280 })
  const recoveryAlert = page
    .getByRole('alert')
    .filter({ hasText: 'Saved conversation data was damaged' })
  await expect(recoveryAlert).toBeVisible()
  await expectStableScreenshot(page, 'session-recovery-warning.png')
})
