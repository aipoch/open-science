import { expect } from '@playwright/test'
import { resolve } from 'node:path'
import type { Locator, Page } from 'playwright'

import { test } from './fixtures/electron-app'

const openComputeSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /settings/i }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Compute', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'SSH hosts' })).toBeVisible()
  return settings
}

const executionModeSection = (settings: Locator): Locator =>
  settings.locator('[data-slot="settings-section"]', { hasText: 'Execution mode' })

test('creates, edits, and persists a Compute Host execution mode across restart', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'en' })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  let settings = await openComputeSettings(page)
  await settings.getByRole('button', { name: 'Add SSH host', exact: true }).click()
  await settings.getByRole('textbox', { name: 'Or type a host alias' }).fill('hpc-dev')
  await settings.getByRole('combobox', { name: 'Execution mode' }).click()
  await page.getByRole('option', { name: 'Slurm', exact: true }).click()
  await settings.getByRole('button', { name: 'Add', exact: true }).click()

  let execution = executionModeSection(settings)
  let configuredMode = execution.getByText('Configured mode').locator('..')
  await expect(configuredMode.getByText('Slurm', { exact: true })).toBeVisible()

  await execution.getByRole('button', { name: 'Edit', exact: true }).click()
  await execution.getByRole('combobox', { name: 'Execution mode' }).click()
  await page.getByRole('option', { name: 'Direct SSH', exact: true }).click()
  await execution.getByRole('button', { name: 'Save', exact: true }).click()
  configuredMode = execution.getByText('Configured mode').locator('..')
  await expect(configuredMode.getByText('Direct SSH', { exact: true })).toBeVisible()

  await settings.getByRole('button', { name: 'Close settings' }).click()
  page = await app.restart()

  settings = await openComputeSettings(page)
  await settings
    .locator('[data-slot="compute-host-card"]')
    .getByRole('button', { name: /hpc-dev ssh:hpc-dev/ })
    .click()
  execution = executionModeSection(settings)
  configuredMode = execution.getByText('Configured mode').locator('..')
  await expect(configuredMode.getByText('Direct SSH', { exact: true })).toBeVisible()
  await page.screenshot({
    path: resolve(process.cwd(), '..', '..', '.scratch', 'compute-slurm', 'settings-mode.png')
  })
})
