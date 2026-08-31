import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from './fixtures/electron-app'

const createProject = async (
  page: Page,
  name: string,
  description: string,
  fromWorkspace: boolean
): Promise<void> => {
  if (fromWorkspace) {
    await page
      .locator('button[title]')
      .filter({ hasText: /^Project \d+$/ })
      .click()
    await page
      .locator('[aria-label="Project actions"]')
      .getByRole('menuitem', { name: 'New project', exact: true })
      .click()
  } else {
    await page.getByRole('button', { name: 'New project', exact: true }).click()
  }

  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Description').fill(description)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.locator(`button[title="${name}"]`)).toBeVisible()
  const starDialog = page.getByRole('dialog', { name: 'Star on GitHub' })
  if (await starDialog.isVisible()) {
    await starDialog.getByRole('button', { name: 'Close' }).click()
  }
}

test('switches projects from the Workspace project menu and expands remaining projects locally', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  for (let index = 1; index <= 16; index += 1) {
    await createProject(page, `Project ${index}`, `Description ${index}`, index > 1)
  }

  await page.setViewportSize({ width: 1280, height: 600 })
  await page.locator('button[title="Project 16"]').click()
  const menu = page.locator('[aria-label="Project actions"]')
  const projectItems = menu.locator('[data-project-id]')
  await expect(projectItems).toHaveCount(5)
  await expect(projectItems).toHaveText([
    'Project 15Description 15',
    'Project 14Description 14',
    'Project 13Description 13',
    'Project 12Description 12',
    'Project 11Description 11'
  ])

  const showRemaining = menu.getByRole('menuitem', {
    name: 'Show remaining 10 projects',
    exact: true
  })
  const newProject = menu.getByRole('menuitem', { name: 'New project', exact: true })
  await expect(showRemaining).toBeVisible()
  await expect(newProject).toBeVisible()
  const [showRemainingBounds, newProjectBounds] = await Promise.all([
    showRemaining.boundingBox(),
    newProject.boundingBox()
  ])
  expect(showRemainingBounds).not.toBeNull()
  expect(newProjectBounds).not.toBeNull()
  expect(showRemainingBounds?.y).toBeLessThan(newProjectBounds?.y ?? 0)

  const showRemainingPresentation = await showRemaining.evaluate((element) => {
    const style = getComputedStyle(element)
    const menuElement = element.closest<HTMLElement>('[aria-label="Project actions"]')
    const newProjectElement = Array.from(
      menuElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
    ).find((item) => item.textContent?.trim() === 'New project')
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      fontSize: style.fontSize,
      hasChevronIcon: element.querySelector('.lucide-chevron-down') !== null,
      height: element.getBoundingClientRect().height,
      menuWidth: menuElement?.getBoundingClientRect().width ?? 0,
      newProjectColor: newProjectElement ? getComputedStyle(newProjectElement).color : '',
      newProjectHeight: newProjectElement?.getBoundingClientRect().height ?? 0,
      tagName: element.tagName,
      width: element.getBoundingClientRect().width
    }
  })
  expect(showRemainingPresentation).toMatchObject({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontSize: '11px',
    hasChevronIcon: true,
    tagName: 'BUTTON'
  })
  expect(showRemainingPresentation.color).not.toBe(showRemainingPresentation.newProjectColor)
  expect(showRemainingPresentation.height).toBeLessThan(showRemainingPresentation.newProjectHeight)
  expect(showRemainingPresentation.width).toBeLessThan(showRemainingPresentation.menuWidth)

  const collapsedScreenshotPath = testInfo.outputPath('workspace-project-switcher-collapsed.png')
  await page.screenshot({ path: collapsedScreenshotPath })
  await testInfo.attach('Workspace project switcher collapsed', {
    path: collapsedScreenshotPath,
    contentType: 'image/png'
  })

  await showRemaining.click()
  await expect(menu).toBeVisible()
  await expect(projectItems).toHaveCount(15)

  const layout = await menu.evaluate((element) => {
    const menuRect = element.getBoundingClientRect()
    return {
      fitsHorizontally: Array.from(
        element.querySelectorAll<HTMLElement>('[data-project-id]')
      ).every((item) => {
        const rect = item.getBoundingClientRect()
        return (
          item.scrollWidth <= item.clientWidth &&
          rect.left >= menuRect.left - 1 &&
          rect.right <= menuRect.right + 1
        )
      }),
      bottom: menuRect.bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      viewportHeight: window.innerHeight
    }
  })
  expect(layout.fitsHorizontally).toBe(true)
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight - 8)
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight)

  await newProject.scrollIntoViewIfNeeded()
  await expect(newProject).toBeVisible()

  const screenshotPath = testInfo.outputPath('workspace-project-switcher-expanded.png')
  await page.screenshot({ path: screenshotPath })
  await testInfo.attach('Workspace project switcher expanded', {
    path: screenshotPath,
    contentType: 'image/png'
  })

  await projectItems.filter({ hasText: /^Project 1Description 1$/ }).click()
  await expect(page.locator('button[title="Project 1"]')).toBeVisible()

  await page.locator('button[title="Project 1"]').click()
  await expect(menu.locator('[data-project-id]')).toHaveCount(5)
})
