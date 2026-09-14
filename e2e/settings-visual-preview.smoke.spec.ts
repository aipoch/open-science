import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

// Throwaway smoke for the settings visual preview (visual-preview/settings-ux work). Not part of
// CI suites; run manually with: npx playwright test e2e/settings-visual-preview.smoke.spec.ts
//
// Toolbar interactions dispatch DOM clicks: the toolbar floats above a Radix modal dialog, which
// makes Playwright actionability checks flaky even though real pointer input reaches it.

const clickToolbarButton = (page: Page, label: string): Promise<void> =>
  page.evaluate((text) => {
    const toolbar = document.querySelector('[data-slot="settings-visual-preview-toolbar"]')
    const button = Array.from(toolbar?.querySelectorAll('button') ?? []).find(
      (candidate) =>
        candidate.textContent?.includes(text) || candidate.getAttribute('aria-label') === text
    )
    if (!button) throw new Error(`toolbar button not found: ${text}`)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, label)

test('settings visual preview: toolbar, markers, tour, mock boundary', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => {
    window.localStorage.setItem('open-science:visual-preview', 'settings-ux')
  })

  await page.getByRole('button', { name: /^(Model settings|Settings|模型设置|设置)$/ }).click()
  const settings = page.getByRole('dialog', { name: /^(Settings|设置)$/ })
  await expect(settings).toBeVisible()

  const toolbar = page.locator('[data-slot="settings-visual-preview-toolbar"]')
  const markers = page.locator('[data-slot="settings-visual-preview-markers"]')
  await expect(toolbar).toBeVisible()
  await expect(toolbar).toContainText('预览模式 · 模拟数据')

  // Entry activation: change 1 arms the compute failure scenario.
  await expect(toolbar).toContainText('第 1 项 / 共 7 项', { timeout: 20000 })
  await expect(settings.getByRole('alert')).toBeVisible({ timeout: 20000 })
  await expect(settings.getByRole('button', { name: /^(Retry|重试)$/ })).toBeVisible()
  await expect(markers).toContainText('变更 1')
  await page.screenshot({ path: 'test-results/visual-preview-1-compute-error.png' })

  // Retry is simulated locally and recovers the fixture host list.
  await settings.getByRole('button', { name: /^(Retry|重试)$/ }).click()
  await expect(settings.getByText('gpu-cluster（示例）')).toBeVisible({ timeout: 15000 })

  // Change 2: removal dialog opens through the real UI, no window.confirm involved.
  await clickToolbarButton(page, '下一处')
  await expect(toolbar).toContainText('第 2 项 / 共 7 项', { timeout: 20000 })
  const removalDialog = page.getByRole('alertdialog')
  await expect(removalDialog).toBeVisible({ timeout: 20000 })
  await expect(removalDialog).toContainText('分子动力学批量模拟（示例作业）')
  await page.screenshot({ path: 'test-results/visual-preview-2-removal.png' })

  // Change 3: remote panel, revoke confirmation section framed; the removal dialog unmounted.
  await clickToolbarButton(page, '下一处')
  await expect(toolbar).toContainText('第 3 项 / 共 7 项', { timeout: 20000 })
  await expect(removalDialog).toBeHidden({ timeout: 10000 })
  await expect(
    settings.locator('section[data-visual-change="remote-revoke-confirmation"]')
  ).toBeVisible({ timeout: 20000 })
  await expect(markers).toContainText('变更 3')

  // Direct selection via the full list: change 6 drills into the archived project.
  await clickToolbarButton(page, '全部变更')
  await clickToolbarButton(page, '6. 禁用操作补充原因说明')
  await expect(toolbar).toContainText('第 6 项 / 共 7 项', { timeout: 20000 })
  await expect(settings.locator('[data-visual-change="disabled-action-explanations"]')).toBeVisible(
    { timeout: 20000 }
  )
  await page.screenshot({ path: 'test-results/visual-preview-6-archived.png' })

  // Marker switch hides and restores frames + chips while the toolbar keeps working. (The
  // markers portal wraps fixed-position children, so it has no box of its own — assert on the
  // chip text, not visibility.)
  await clickToolbarButton(page, '显示标记')
  await expect(markers).toHaveCount(0)
  await clickToolbarButton(page, '显示标记')
  await expect(markers).toContainText('变更 6')

  // Boundary: previous disabled on the first item. (The toolbar portals outside the Radix modal
  // dialog, so hideOthers aria-hides it from role queries — check the DOM property directly.)
  await clickToolbarButton(page, '1. 计算面板加载与错误状态')
  await expect(toolbar).toContainText('第 1 项 / 共 7 项', { timeout: 20000 })
  const previousDisabled = await page.evaluate(() => {
    const toolbar = document.querySelector('[data-slot="settings-visual-preview-toolbar"]')
    const previous = Array.from(toolbar?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent === '上一处'
    )
    return previous?.disabled
  })
  expect(previousDisabled).toBe(true)

  // Leaving preview: exit clears the flag; reopening settings shows no scaffolding.
  await clickToolbarButton(page, '退出预览')
  await expect(toolbar).toBeHidden()
  await settings.getByRole('button', { name: /^(Close settings|关闭设置)$/ }).click()
  await page.getByRole('button', { name: /^(Model settings|Settings|模型设置|设置)$/ }).click()
  await expect(page.getByRole('dialog', { name: /^(Settings|设置)$/ })).toBeVisible()
  await expect(page.locator('[data-slot="settings-visual-preview-toolbar"]')).toHaveCount(0)
})
