import { test, expect } from '@playwright/test'
import type { Page } from 'playwright'
import { openGeneralSettings } from '../fixtures/settings-preferences'
import { localizedSettingsCases } from '../fixtures/localized-settings'

let rendererErrors: string[] = []
test.beforeEach(async ({ page }) => {
  rendererErrors = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
})
test.afterEach(() => {
  expect(rendererErrors).toEqual([])
})

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

const selectLanguage = async (page: Page, label: string): Promise<void> => {
  const settings = await openGeneralSettings(page)
  await settings.getByRole('combobox', { name: 'Interface language' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
  // The dialog name changes with the locale; use Escape rather than the old English close label.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
}

for (const localized of localizedSettingsCases) {
  const viewportWidths = localized.locale === 'ru' ? ([640, 768] as const) : ([640] as const)
  for (const viewportWidth of viewportWidths) {
    test(`lays out ${localized.language} at ${viewportWidth}px without clipping`, async ({
      page
    }) => {
      await page.goto('/')
      await expect(page.locator('.github-star-cta').first()).toHaveAttribute(
        'data-state',
        'success'
      )
      await expect(page.locator('.github-star-cta').first()).not.toContainText('NaN')
      await page.setViewportSize({ width: viewportWidth, height: 800 })

      await selectLanguage(page, localized.pickerLabel)

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
      const navigation = settings.getByRole('navigation', { name: localized.settings })
      if (!(await navigation.isVisible())) {
        await settings.getByRole('button', { name: localized.openNavigation }).click()
      }
      await navigation.getByRole('button', { name: localized.model, exact: true }).click()
      // Active model and Reasoning effort now share the Main model region; the effort control is
      // still a named radiogroup, but the parent region title is Main model.
      const mainModel = settings.getByRole('region', { name: localized.mainModel })
      const effort = mainModel.getByRole('radiogroup', {
        name: localized.reasoningEffort
      })
      await expect(effort).toBeVisible()
      await expect
        .poll(() =>
          mainModel.locator('p').evaluate((description) => {
            if (!(description instanceof HTMLElement)) return false
            return description.scrollWidth <= description.clientWidth + 1
          })
        )
        .toBe(true)
      await expect
        .poll(() =>
          effort.locator('[data-slot="settings-segment-label"]').evaluateAll((labels) =>
            labels.flatMap((label) => {
              const text = label.querySelector('[data-slot="settings-segment-label-text"]')
              if (!(label instanceof HTMLElement) || !(text instanceof HTMLElement)) {
                return [{ label: label.textContent, error: 'missing measurable text element' }]
              }
              const labelBox = label.getBoundingClientRect()
              const textBox = text.getBoundingClientRect()
              const fits =
                text.scrollWidth <= text.clientWidth + 1 &&
                text.scrollHeight <= text.clientHeight + 1 &&
                textBox.left >= labelBox.left - 1 &&
                textBox.right <= labelBox.right + 1 &&
                textBox.top >= labelBox.top - 1 &&
                textBox.bottom <= labelBox.bottom + 1
              return fits
                ? []
                : [
                    {
                      label: text.textContent,
                      error: 'text overflow',
                      compact: label.dataset.compact,
                      fontSize: getComputedStyle(text).fontSize,
                      clientWidth: text.clientWidth,
                      scrollWidth: text.scrollWidth,
                      clientHeight: text.clientHeight,
                      scrollHeight: text.scrollHeight
                    }
                  ]
            })
          )
        )
        .toEqual([])

      const highLabel = effort
        .getByRole('radio', { name: 'High', exact: true })
        .locator('[data-slot="settings-segment-label"]')
      await expect(highLabel).not.toHaveAttribute('data-compact', 'true')
      if (localized.locale === 'ru') {
        await expect(
          effort
            .getByRole('radio', { name: localized.defaultEffort, exact: true })
            .locator('[data-slot="settings-segment-label"]')
        ).toHaveAttribute('data-compact', 'true')
      }
      const clippedPolicyLabels = async (): Promise<Array<string | undefined>> =>
        settings
          .locator('[data-slot="settings-row"] [data-slot="select-trigger"] .truncate')
          .evaluateAll((labels) =>
            labels.flatMap((label) =>
              label instanceof HTMLElement && label.scrollWidth > label.clientWidth + 1
                ? [label.textContent?.trim()]
                : []
            )
          )
      expect(await clippedPolicyLabels()).toEqual([])
      const mainModelRow = mainModel.locator('[data-slot="settings-row"]').first()
      await expect
        .poll(() =>
          mainModelRow.evaluate(
            (row) => getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/).length
          )
        )
        .toBe(1)

      await settings.getByRole('button', { name: localized.expandSubagent, exact: true }).click()
      const scenarioModels = settings.getByRole('region', { name: localized.scenarioModels })
      const subagentRow = scenarioModels.locator('[data-slot="settings-row"]').first()
      await expect(subagentRow).toBeVisible()
      await expect
        .poll(() =>
          subagentRow.evaluate(
            (row) => getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/).length
          )
        )
        .toBe(1)
      expect(await clippedPolicyLabels()).toEqual([])

      if (!(await navigation.isVisible())) {
        await settings.getByRole('button', { name: localized.openNavigation }).click()
      }
      await navigation.getByRole('button', { name: localized.general, exact: true }).click()

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
      await expect(page.getByRole('region', { name: localized.projects })).toBeVisible()
    })
  }
}
