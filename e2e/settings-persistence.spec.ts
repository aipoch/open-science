import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const expectVisibleTextButtonsToFit = async (page: Page): Promise<void> => {
  const clippedButtons = await page.locator('[data-slot="button"]:visible').evaluateAll((buttons) =>
    buttons.flatMap((button) => {
      if (!(button instanceof HTMLElement) || !button.innerText.trim()) return []
      return button.scrollWidth > button.clientWidth + 1
        ? [
            {
              label: button.innerText.trim(),
              clientWidth: button.clientWidth,
              scrollWidth: button.scrollWidth
            }
          ]
        : []
    })
  )

  expect(clippedButtons).toEqual([])
}

test('persists the selected theme after closing settings and relaunching', async ({ app }) => {
  let page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', {
      name: 'General',
      exact: true
    })
    .click()

  const theme = settings.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(theme.getByRole('radio', { name: 'Dark' })).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)

  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible()

  page = await app.restart()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible()
})

test('switches to Japanese without clipping localized controls', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.setViewportSize({ width: 640, height: 800 })

  await page
    .locator('button')
    .filter({ has: page.locator('svg.lucide-languages') })
    .click()
  await page.getByRole('menuitem', { name: '日本語', exact: true }).click()

  await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
  await expect(page.getByRole('region', { name: 'プロジェクト' })).toBeVisible()
  await expectVisibleTextButtonsToFit(page)
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    )
    .toBe(true)

  await page.getByRole('button', { name: 'モデル設定' }).click()
  const settings = page.getByRole('dialog', { name: '設定' })
  await settings.getByRole('button', { name: '設定ナビゲーションを開く' }).click()
  await settings.getByRole('button', { name: '一般', exact: true }).click()

  await expect(settings.getByRole('heading', { name: '外観' })).toBeVisible()
  await expect(settings.getByRole('combobox', { name: '表示言語' })).toContainText('日本語')
  await expectVisibleTextButtonsToFit(page)

  const closeButton = settings.getByRole('button', { name: '設定を閉じる' })
  await closeButton.hover()
  const tooltip = page.locator('[data-slot="tooltip-content"]:visible')
  await expect(tooltip).toContainText('設定を閉じる')
  await expect(tooltip).toHaveCSS('white-space', 'normal')
  const tooltipBox = await tooltip.boundingBox()
  expect(tooltipBox).not.toBeNull()
  expect(tooltipBox?.x).toBeGreaterThanOrEqual(0)
  expect((tooltipBox?.x ?? 0) + (tooltipBox?.width ?? 0)).toBeLessThanOrEqual(640)
})
