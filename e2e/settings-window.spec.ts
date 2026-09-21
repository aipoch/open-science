import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { getSettingsPage } from './fixtures/settings-window'
import { openGeneralSettings } from './fixtures/settings-preferences'

test('isolates settings rendering, keeps workspace interactive and synchronizes preferences', async ({
  app
}) => {
  const workspace = await app.completeOnboarding()
  await workspace.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await expect(workspace.locator('html')).toHaveAttribute('lang', 'en')
  const dialog = await openGeneralSettings(workspace)
  const settings = await getSettingsPage(workspace)
  const windows = await app.rendererWindowProcesses()
  const auxiliary = windows.find((window) => window.url.endsWith('/settings.html'))!
  const primary = windows.find((window) => window.url === workspace.url())!
  expect(auxiliary.pid).not.toBe(primary.pid)
  expect(auxiliary.pid).toBeGreaterThan(0)
  await expect(workspace.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
  expect(await workspace.locator('[inert]').count()).toBe(0)

  // A busy loop belongs only to this renderer. Main IPC and the workspace must respond while the
  // setting page is still busy, instead of merely catching up after its work finishes.
  const busy = settings.evaluate(() => {
    const end = performance.now() + 2500
    while (performance.now() < end) {
      /* deliberate test load */
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const started = Date.now()
  await workspace.getByRole('button', { name: 'New project', exact: true }).click()
  await expect(workspace.getByRole('dialog')).toBeVisible()
  await workspace.evaluate(() => window.api.settings.getSettings())
  expect(Date.now() - started).toBeLessThan(1800)
  await busy
  await workspace.keyboard.press('Escape')

  await dialog
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: 'Dark', exact: true })
    .click()
  await expect(workspace.locator('html')).toHaveClass(/dark/)
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(dialog).toBeHidden()
  await openGeneralSettings(workspace)
  expect(
    (await app.rendererWindowProcesses()).find((window) => window.url.endsWith('/settings.html'))
      ?.pid
  ).toBe(auxiliary.pid)
  await expect(
    dialog
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Dark', exact: true })
  ).toBeChecked()
})

test('keeps committed preferences, permissions Undo, updates and native pane closing in settings', async ({
  app
}) => {
  const workspace = await app.completeOnboarding()
  const dialog = await openGeneralSettings(workspace)
  const settings = await getSettingsPage(workspace)
  await Promise.all([
    workspace.evaluate(() => window.api.settings.setNotificationsEnabled({ enabled: false })),
    settings.evaluate(() => window.api.settings.setShowNotificationContent({ enabled: false }))
  ])
  await expect(dialog.getByRole('switch', { name: 'Toggle task notifications' })).not.toBeChecked()
  await expect(
    dialog.getByRole('switch', { name: 'Toggle task content in system notifications' })
  ).not.toBeChecked()
  await workspace.evaluate(() => window.api.settings.setNotificationsEnabled({ enabled: true }))
  await expect(dialog.getByRole('switch', { name: 'Toggle task notifications' })).toBeChecked()
  await dialog.getByRole('switch', { name: 'Toggle task notifications' }).click()
  await expect
    .poll(() =>
      workspace.evaluate(async () => (await window.api.settings.getSettings()).notificationsEnabled)
    )
    .toBe(false)

  await expect(dialog.getByRole('region', { name: 'App version' })).toContainText(/v\d+\.\d+\.\d+/)
  await app.emitUpdateStatus({
    state: 'available',
    current: '0.31.1',
    latest: '99.0.0',
    notes: 'Isolated settings update fixture'
  })
  await dialog.getByRole('button', { name: 'Update to 99.0.0' }).click()
  const update = settings.getByRole('dialog', { name: 'Update available' })
  await expect(update).toContainText('Isolated settings update fixture')
  await expect(update.getByRole('button', { name: /Download/ })).toBeVisible()
  await settings.keyboard.press('Escape')
  await expect(update).toBeHidden()

  await workspace.evaluate(() => window.api.permissions.restoreDefaults())
  await dialog
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Permissions', exact: true })
    .click()
  const row = dialog.locator('[data-slot="permission-row"]').first()
  await expect(row).toBeVisible()
  const count = await dialog.locator('[data-slot="permission-row"]').count()
  await row.getByRole('button', { name: /^Revoke / }).click()
  const undo = settings.getByTestId('permission-undo-snackbar')
  await expect(undo).toBeVisible()
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await workspace.getByRole('button', { name: 'Model settings' }).click()
  await expect(undo).toBeVisible()
  await undo.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(dialog.locator('[data-slot="permission-row"]')).toHaveCount(count)

  await dialog
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Model', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Add provider', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Provider name', exact: true })).toBeVisible()
  await app.pressSettingsWindowShortcut('W', [process.platform === 'darwin' ? 'meta' : 'control'])
  await expect(dialog.getByRole('textbox', { name: 'Provider name', exact: true })).toBeHidden()
  await expect(dialog).toBeVisible()
  await app.pressSettingsWindowShortcut('W', [process.platform === 'darwin' ? 'meta' : 'control'])
  await expect(dialog).toBeHidden()
})

test('refreshes an already loaded workspace Compute menu after settings mutations', async ({
  app
}) => {
  const workspace = await app.completeOnboarding()
  await workspace.getByRole('button', { name: 'New project', exact: true }).click()
  const project = workspace.getByRole('dialog', { name: 'New project' })
  await project.getByLabel('Name').fill('Settings compute synchronization')
  await project.getByRole('button', { name: 'Create project' }).click()
  const controls = workspace.getByTestId('composer-controls-trigger')
  await controls.click()
  await workspace.getByRole('menuitem', { name: 'Compute', exact: true }).hover()
  await expect(workspace.getByText('No SSH hosts registered', { exact: true })).toBeVisible()
  await workspace.keyboard.press('Escape')
  await workspace.keyboard.press('Escape')
  const dialog = await openGeneralSettings(workspace)
  const settings = await getSettingsPage(workspace)
  const host = await settings.evaluate(() =>
    window.api.compute.create({ sshAlias: 'isolated-e2e', displayName: 'Isolated E2E' })
  )
  await controls.click()
  await workspace.getByRole('menuitem', { name: 'Compute', exact: true }).hover()
  await expect(workspace.getByTestId(`compute-host-enabled-${host.providerId}`)).toBeVisible()
  await settings.evaluate(
    (providerId) => window.api.compute.delete({ providerId }),
    host.providerId
  )
  await expect(workspace.getByTestId(`compute-host-enabled-${host.providerId}`)).toHaveCount(0)
  await expect(dialog).toBeVisible()
})

test('exports a real Skill through the bundled archive worker', async ({ app }) => {
  const workspace = await app.completeOnboarding()
  await openGeneralSettings(workspace)
  const settings = await getSettingsPage(workspace)
  const output = await app.configureSessionPackageDialogs()
  const result = await settings.evaluate(async () => {
    const skills = await window.api.settings.createSkill({
      name: 'isolated-worker-fixture',
      description: 'Synthetic archive fixture',
      body: 'archive fixture payload\n'.repeat(50000)
    })
    const skill = skills.find((entry) => entry.name === 'isolated-worker-fixture')!
    return window.api.settings.exportSkill({ id: skill.id })
  })
  expect(result.saved).toBe(true)
  const files = unzipSync(await readFile(output))
  expect(Object.keys(files).some((name) => name.endsWith('SKILL.md'))).toBe(true)
})

test('preserves the damaged catalog warning in archived project deletion', async ({ app }) => {
  let workspace = await app.completeOnboarding()
  await workspace.getByRole('button', { name: 'New project', exact: true }).click()
  const create = workspace.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Archive safety fixture')
  await create.getByRole('button', { name: 'Create project' }).click()
  const projectId = await workspace.evaluate(async () => {
    const project = (await window.api.projects.list())[0]
    await window.api.projects.updateArchive({
      id: project.id,
      archived: true,
      expectedArchiveRevision: project.archiveRevision ?? 0
    })
    return project.id
  })
  workspace = await app.restartWithCorruptHistoricalSessionFile(projectId)
  await workspace.evaluate(
    (id) =>
      window.api.window.openSettings!({
        route: { panel: 'archived', view: { kind: 'project', projectId: id } }
      }),
    projectId
  )
  const settings = await getSettingsPage(workspace)
  await settings.getByRole('button', { name: 'Delete project', exact: true }).click()
  await expect(settings.getByRole('alertdialog')).toContainText(
    'all of its saved conversations, including any that could not be loaded during recovery'
  )
  await settings
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  expect(await workspace.evaluate(async () => (await window.api.projects.list()).length)).toBe(1)
})
