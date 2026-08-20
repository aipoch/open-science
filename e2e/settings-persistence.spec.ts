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

  await page
    .locator('button')
    .filter({ has: page.locator('svg.lucide-languages') })
    .click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()

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

const localizedSettingsCases = [
  {
    language: 'Japanese',
    pickerLabel: '日本語',
    locale: 'ja',
    projects: 'プロジェクト',
    modelSettings: 'モデル設定',
    settings: '設定',
    openNavigation: '設定ナビゲーションを開く',
    general: '一般',
    appearance: '外観',
    interfaceLanguage: '表示言語',
    closeSettings: '設定を閉じる'
  },
  {
    language: 'Korean',
    pickerLabel: '한국어',
    locale: 'ko',
    projects: '프로젝트',
    modelSettings: '모델 설정',
    settings: '설정',
    openNavigation: '설정 탐색 열기',
    general: '일반',
    appearance: '외관',
    interfaceLanguage: '인터페이스 언어',
    closeSettings: '설정 닫기'
  },
  {
    language: 'French',
    pickerLabel: 'Français',
    locale: 'fr',
    projects: 'Projets',
    modelSettings: 'Paramètres du modèle',
    settings: 'Paramètres',
    openNavigation: 'Ouvrir la navigation des paramètres',
    general: 'Général',
    appearance: 'Apparence',
    interfaceLanguage: "Langue de l'interface",
    closeSettings: 'Fermer les paramètres'
  }
] as const

for (const localized of localizedSettingsCases) {
  test(`switches to ${localized.language} without clipping and persists it`, async ({ app }) => {
    let page = await app.completeOnboarding()
    const viewportWidth = 640
    await page.setViewportSize({ width: viewportWidth, height: 800 })

    await page
      .locator('button')
      .filter({ has: page.locator('svg.lucide-languages') })
      .click()
    await page.getByRole('menuitem', { name: localized.pickerLabel, exact: true }).click()

    await expect(page.locator('html')).toHaveAttribute('lang', localized.locale)
    await expect(page.getByRole('region', { name: localized.projects })).toBeVisible()
    await expectVisibleTextButtonsToFit(page)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      )
      .toBe(true)

    await page.getByRole('button', { name: localized.modelSettings }).click()
    const settings = page.getByRole('dialog', { name: localized.settings })
    await settings.getByRole('button', { name: localized.openNavigation }).click()
    await settings.getByRole('button', { name: localized.general, exact: true }).click()

    await expect(settings.getByRole('heading', { name: localized.appearance })).toBeVisible()
    await expect(
      settings.getByRole('combobox', { name: localized.interfaceLanguage })
    ).toContainText(localized.pickerLabel)
    await expectVisibleTextButtonsToFit(page)

    const closeButton = settings.getByRole('button', { name: localized.closeSettings })
    await closeButton.hover()
    const tooltip = page.locator('[data-slot="tooltip-content"]:visible')
    await expect(tooltip).toContainText(localized.closeSettings)
    await expect(tooltip).toHaveCSS('white-space', 'normal')
    const tooltipBox = await tooltip.boundingBox()
    expect(tooltipBox).not.toBeNull()
    expect(tooltipBox?.x).toBeGreaterThanOrEqual(0)
    // Windows reports fractional bounding boxes; 1px matches the button-clipping helper.
    expect((tooltipBox?.x ?? 0) + (tooltipBox?.width ?? 0)).toBeLessThanOrEqual(viewportWidth + 1)

    await closeButton.click()
    page = await app.restart()
    await expect(page.locator('html')).toHaveAttribute('lang', localized.locale)
    await expect(page.getByRole('region', { name: localized.projects })).toBeVisible()
  })
}
