import { expect, test } from '@playwright/test'
import zhHans from '../../src/shared/i18n/locales/zh-Hans.json'

test('R verification waits for protection and recovers after recheck', async ({ page }) => {
  await page.goto('/r-access.html')
  const verify = page.getByRole('button', { name: 'Authorize and verify', exact: true })
  await expect(verify).toBeDisabled()
  await expect(page.getByText('Notebook network protection is not set up.')).toBeVisible()
  const remove = page.getByRole('button', { name: 'Remove R access', exact: true })
  await expect(remove).toBeEnabled()
  await remove.click()
  await expect(page.getByText('R access removed', { exact: true })).toBeVisible()
  // This fixture changes only the backend snapshot, as returning from Network settings would.
  await page.getByRole('button', { name: 'Network settings', exact: true }).click()
  await page.getByRole('button', { name: 'Recheck', exact: true }).click()
  await expect(verify).toBeEnabled()
  await verify.click()
  await expect(page.getByText('R access verified', { exact: true })).toBeVisible()
})

test('Chinese R access guidance fits the runtime panel', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 960, height: 1000 })
  await page.goto('/r-access.html?locale=zh-Hans')
  await expect(
    page.getByText(
      zhHans.renderer[
        'R access verification requires network protection to be ready. Review Network settings, then recheck runtimes.'
      ]
    )
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('r-access-zh-Hans.png'), fullPage: true })
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('Chinese R library rejection explains the prerequisite without IPC details', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1060, height: 1050 })
  await page.goto('/r-access.html?locale=zh-Hans&scenario=install-library')
  const toggle = page.getByRole('switch', { name: '允许为 R 4.4.1 安装软件包' })
  await expect(toggle).toBeEnabled()
  await toggle.click()
  const error = page.getByTestId('runtimes-error')
  await expect(error).toContainText('此文件夹无法用于安装这个 R 的软件包')
  await expect(error).toContainText('重新检测')
  await expect(error).toContainText('应用托管的 R 环境')
  await expect(error).not.toContainText('.libPaths()')
  await expect(error).not.toContainText('Error invoking remote method')
  await expect(toggle).not.toBeChecked()
  await page.getByText('高级选项', { exact: true }).click()
  await expect(
    page.getByText('如果您已在此 R 中设置了个人软件包文件夹，可在这里选择该文件夹。')
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('r-library-rejection-zh-Hans.png'),
    fullPage: true
  })
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
