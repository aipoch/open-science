import { expect, test } from '@playwright/test'

for (const [theme, width] of [
  ['light', 1100],
  ['dark', 1100],
  ['light', 390]
] as const) {
  test(`Hidden category and explicit export selection ${theme} ${width}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 850 })
    await page.goto('/artifact-hidden.html')
    await page.evaluate(
      (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
      theme
    )
    await page.getByRole('button', { name: 'Hide result.txt', exact: true }).click()
    await expect(page.getByText('No visible artifacts')).toBeVisible()
    await page.getByRole('button', { name: 'Filter project files' }).first().click()
    await page.getByRole('menuitemradio', { name: /Hidden/ }).click()
    await expect(page.getByTestId('hidden-artifacts')).toBeVisible()
    await page.getByRole('button', { name: 'result.txt', exact: true }).click()
    await expect(page.getByText('private result', { exact: true })).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('hidden-preview.png')
    })
    await page.getByRole('button', { name: 'Filter project files' }).click()
    await page.getByRole('menuitemradio', { name: /All artifacts/ }).click()
    await expect(page.getByText('private result', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Download project artifacts', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Hidden', { exact: true })).toBeVisible()
    await expect(dialog.getByText('0 of 1 selected')).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('hidden-export.png')
    })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Filter project files' }).first().click()
    await page.getByRole('menuitemradio', { name: /Hidden/ }).click()
    await page.getByRole('button', { name: 'Unhide result.txt', exact: true }).click()
    await expect(page.getByText('No files yet')).toBeVisible()
  })
}
