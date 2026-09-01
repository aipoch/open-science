import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { suppressWorkspaceStarNudge, test } from './fixtures/electron-app'

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
}

const seedProjects = async (page: Page, count: number): Promise<void> => {
  await page.evaluate(async (projectCount) => {
    const bridge = globalThis as unknown as {
      api: {
        projects: {
          create: (request: { name: string; description: string }) => Promise<{ updatedAt: number }>
        }
      }
    }

    for (let index = 1; index <= projectCount; index += 1) {
      const project = await bridge.api.projects.create({
        name: `Project ${index}`,
        description: `Description ${index}`
      })
      // The menu sorts by updatedAt. Wait for the wall clock to advance so every seeded row has a
      // deterministic order even on Windows clocks with a coarse timer resolution.
      while (Date.now() <= project.updatedAt) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
  }, count)
}

const reloadAndOpenProject = async (page: Page, name: string): Promise<void> => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  const projectButton = page.getByRole('button', { name, exact: true })
  await expect(projectButton).toBeVisible()
  await projectButton.click()
  await expect(page.locator(`button[title="${name}"]`)).toBeVisible()
}

test('switches projects from the Workspace project menu and expands remaining projects locally', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)

  await seedProjects(page, 15)
  page = await app.restart()
  await expect(page.getByText('Project 15', { exact: true })).toBeVisible()
  await createProject(page, 'Project 16', 'Description 16', false)
  await reloadAndOpenProject(page, 'Project 16')

  await page.setViewportSize({ width: 1280, height: 600 })
  await page.locator('button[title="Project 16"]').click()
  const menu = page.locator('[aria-label="Project actions"]')
  const search = menu.getByRole('searchbox', { name: 'Search projects' })
  const projectItems = menu.locator('[data-project-id]')
  await expect(search).toBeVisible()
  await expect(search).toBeFocused()
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

  await search.press('ArrowDown')
  await expect(projectItems.first()).toBeFocused()
  await page.keyboard.press('End')
  await expect(newProject).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(showRemaining).toBeFocused()
  const focusedPresentation = await showRemaining.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      color: style.color
    }
  })
  expect(focusedPresentation.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(focusedPresentation.boxShadow).not.toBe('none')
  expect(focusedPresentation.color).toBe(showRemainingPresentation.newProjectColor)

  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect(projectItems).toHaveCount(15)
  await expect(menu.locator(':focus')).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(menu.locator('[data-project-id]:focus')).toHaveCount(1)

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

  await search.fill('  PROJECT 1  ')
  await expect(projectItems).toHaveCount(5)
  await expect(projectItems).toHaveText([
    'Project 15Description 15',
    'Project 14Description 14',
    'Project 13Description 13',
    'Project 12Description 12',
    'Project 11Description 11'
  ])
  const clearSearch = menu.getByRole('button', { name: 'Clear search' })
  await expect(clearSearch).toBeVisible()
  const searchPresentation = await menu.evaluate((element) => {
    const menuBounds = element.getBoundingClientRect()
    const searchInput = element.querySelector<HTMLInputElement>('[aria-label="Search projects"]')
    const clearButton = element.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')
    if (!searchInput || !clearButton) return null

    const searchBounds = searchInput.getBoundingClientRect()
    return {
      clearButtonSize: clearButton.getBoundingClientRect().width,
      leftInset: searchBounds.left - menuBounds.left,
      rightInset: menuBounds.right - searchBounds.right
    }
  })
  expect(searchPresentation).not.toBeNull()
  expect(searchPresentation?.clearButtonSize).toBe(24)
  expect(
    Math.abs((searchPresentation?.leftInset ?? 0) - (searchPresentation?.rightInset ?? 0))
  ).toBe(0)

  await search.press('Tab')
  await expect(clearSearch).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(menu).toBeVisible()
  await search.fill('  PROJECT 1  ')
  const filteredShowRemaining = menu.getByRole('menuitem', {
    name: 'Show remaining 2 projects',
    exact: true
  })
  await expect(filteredShowRemaining).toBeVisible()

  const titlePresentation = await projectItems.first().evaluate((item) => {
    const title = item.querySelector<HTMLElement>('[data-project-title]')
    const highlight = title?.querySelector<HTMLElement>('.text-primary')
    if (!title || !highlight) return null
    const titleStyle = getComputedStyle(title)
    const highlightStyle = getComputedStyle(highlight)
    return {
      highlightColor: highlightStyle.color,
      highlightFontSize: highlightStyle.fontSize,
      highlightFontWeight: highlightStyle.fontWeight,
      highlightText: highlight.textContent,
      titleColor: titleStyle.color,
      titleFontSize: titleStyle.fontSize,
      titleFontWeight: titleStyle.fontWeight
    }
  })
  expect(titlePresentation).not.toBeNull()
  expect(titlePresentation?.highlightText).toBe('Project 1')
  expect(titlePresentation?.highlightColor).not.toBe(titlePresentation?.titleColor)
  expect(titlePresentation?.highlightFontSize).toBe(titlePresentation?.titleFontSize)
  expect(titlePresentation?.highlightFontWeight).toBe(titlePresentation?.titleFontWeight)

  await search.press('ArrowDown')
  await expect(projectItems.first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('button[title="Project 15"]')).toBeVisible()

  await page.locator('button[title="Project 15"]').click()
  await expect(search).toHaveValue('')
  await expect(menu.locator('[data-project-id]')).toHaveCount(5)
})

test('closes mobile navigation when switching projects', async ({ app }) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await suppressWorkspaceStarNudge(page)

  await seedProjects(page, 1)
  page = await app.restart()
  await expect(page.getByText('Project 1', { exact: true })).toBeVisible()
  await createProject(page, 'Project 2', 'Description 2', false)
  await reloadAndOpenProject(page, 'Project 2')

  await page.setViewportSize({ width: 700, height: 700 })
  await page.getByRole('button', { name: 'Open navigation' }).click()

  const navigation = page.locator('aside[aria-label="Workspace navigation"]')
  await expect(navigation).toHaveAttribute('data-mobile-open', 'true')
  await navigation.locator('button[title="Project 2"]').click()
  await page
    .locator('[aria-label="Project actions"]')
    .locator('[data-project-id]')
    .filter({ hasText: /^Project 1Description 1$/ })
    .click()

  await expect(navigation).toHaveAttribute('data-mobile-open', 'false')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(navigation.locator('button[title="Project 1"]')).toBeVisible()
})
