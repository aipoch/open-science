import { createServer } from 'node:http'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openSettingsPage } from './fixtures/settings-preferences'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

test.use({ windowMode: 'normal' })
for (const mode of ['Relaxed', 'Strict'] as const) {
  test(`saves an existing ${mode} address with Enter without leaving the editor`, async ({
    app
  }, testInfo) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    const settings = await openSettingsPage(page, 'Network')
    await settings.getByRole('button', { name: 'Manage access', exact: true }).click()
    if (process.platform !== 'win32')
      await expect(
        settings.getByRole('region', { name: 'Notebook network protection', exact: true })
      ).toBeHidden()
    if (mode === 'Strict')
      await settings.getByRole('radio', { name: 'Strict', exact: true }).click()
    const add = settings.getByRole('button', {
      name: mode === 'Strict' ? 'Add rule' : 'Add address',
      exact: true
    })
    if (mode === 'Relaxed') {
      await expect(settings.getByRole('textbox', { name: 'Search network addresses' })).toHaveCount(
        0
      )
      const heading = await settings
        .getByRole('heading', { name: 'Trusted unsafe networks', exact: true })
        .boundingBox()
      const action = await add.boundingBox()
      expect(heading).not.toBeNull()
      expect(action).not.toBeNull()
      expect(action!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width)
      expect(action!.y).toBeLessThan(heading!.y + heading!.height)
      await settings
        .getByRole('region', { name: 'Trusted unsafe networks', exact: true })
        .screenshot({
          path: testInfo.outputPath('network-access-header.png')
        })
    }
    await add.click()
    const hostname = settings.getByLabel(
      mode === 'Strict' ? 'Hostname, IP or pattern' : 'Hostname',
      { exact: true }
    )
    await hostname.fill('review.local')
    await settings.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    if (mode === 'Strict')
      await settings.locator('summary').filter({ hasText: 'Ungrouped' }).click()
    const address = settings.locator('code').filter({ hasText: 'review.local' }).locator('..')
    await address.getByRole('button', { name: 'Edit', exact: true }).click()
    await hostname.fill('changed.local')
    await hostname.press('Enter')
    await expect(settings.locator('code').filter({ hasText: 'changed.local' })).toBeVisible()
    await expect(settings.locator('form')).toBeVisible()
    await hostname.fill('not a valid host')
    await hostname.press('Enter')
    await expect(settings.getByRole('alert')).toBeVisible()
    await expect(settings.locator('code').filter({ hasText: 'changed.local' })).toBeVisible()
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    await settings.getByRole('button', { name: 'Close settings' }).click()
  })
}

test('saves strict whitelist edits immediately and enforces them in a real Notebook', async ({
  app
}, testInfo) => {
  test.skip(
    process.platform === 'win32',
    'Native POSIX fixture; Windows needs its provisioned runtime.'
  )
  test.setTimeout(240_000)
  const python = process.env.OPEN_SCIENCE_TEST_PYTHON
  if (!python)
    throw new Error('Provide an isolated Python with ipykernel via OPEN_SCIENCE_TEST_PYTHON')
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.end('strict-e2e-ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  try {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await page.evaluate(async (path) => {
      await window.api.runtime.registerInterpreter('python', path)
      const runtime = (await window.api.runtime.listEnvironments()).python.find(
        (row) => row.interpreterPath === path || row.envId === path
      )
      if (!runtime) throw new Error('Registered Python missing')
      await window.api.runtime.setEnvironmentEnabled('python', runtime.envId, true)
      const enabled = (await window.api.runtime.listEnvironments()).python.find(
        (row) => row.envId === runtime.envId
      )
      if (!enabled?.runnable) throw new Error('Registered Python not runnable')
      await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
    }, python)
    const info = await page.evaluate(() => window.api.storage.getInfo())
    expect(await realpath(info.dataRoot)).toContain(await realpath(tmpdir()))
    await testInfo.attach('isolation-self-check', {
      body: JSON.stringify({
        dataRoot: await realpath(info.dataRoot),
        python,
        micromamba: process.env.OPEN_SCIENCE_MICROMAMBA_BIN
      }),
      contentType: 'application/json'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await createProjectViaUi(page, 'Strict Notebook network')
    let settings = await openSettingsPage(page, 'Network')
    await settings.getByRole('button', { name: 'Manage access', exact: true }).click()
    await expect(settings.getByRole('radio', { name: 'Relaxed', exact: true })).toBeChecked()
    await settings.getByRole('button', { name: 'Add address', exact: true }).click()
    await settings.getByLabel('Hostname', { exact: true }).fill('incomplete address')
    await settings.getByRole('radio', { name: 'Strict', exact: true }).click()
    await expect(settings.getByRole('radio', { name: 'Strict', exact: true })).toBeChecked()
    await expect(settings.locator('form')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Restore built-ins' })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('strict-mode.png') })
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await submitPromptViaUi(page, `Verify strict Notebook network port ${address.port} blocked`)
    await expect(page.getByText('Strict Notebook blocked verified.', { exact: true })).toBeVisible({
      timeout: 120_000
    })
    expect(requests).toBe(0)
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    settings = await openSettingsPage(page, 'Network')
    await settings.getByRole('button', { name: 'Manage access', exact: true }).click()
    await settings.getByRole('button', { name: 'Add rule', exact: true }).click()
    await expect(settings.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible()
    await expect(settings.getByRole('alert')).toHaveCount(0)
    await expect(settings.getByLabel('Hostname, IP or pattern', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'false'
    )
    await settings.getByLabel('Protocol', { exact: true }).selectOption('http')
    await settings.getByLabel('Hostname, IP or pattern', { exact: true }).fill('localhost')
    await settings.getByLabel('Port', { exact: true }).fill(String(address.port))
    await settings.getByLabel('Group', { exact: true }).selectOption('__new__')
    await settings.getByLabel('Group name', { exact: true }).fill('Local research')
    await page.screenshot({ path: testInfo.outputPath('strict-editor.png') })
    await settings.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await submitPromptViaUi(page, `Verify strict Notebook network port ${address.port} allowed`)
    await expect(page.getByText('Strict Notebook allowed verified.', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    expect(requests).toBe(1)
    await expect(page.getByTestId('permission-card')).toHaveCount(0)
    settings = await openSettingsPage(page, 'Network')
    await settings.getByRole('button', { name: 'Manage access', exact: true }).click()
    const localGroup = settings.locator('details').filter({ hasText: 'Local research' })
    await localGroup.locator('summary').click()
    await localGroup.getByRole('button', { name: 'Edit', exact: true }).click()
    await settings.getByLabel('Hostname, IP or pattern', { exact: true }).fill('127.0.0.1')
    await settings.getByLabel('Port', { exact: true }).focus()
    await expect(
      localGroup.getByText(`http://127.0.0.1:${address.port}`, { exact: true })
    ).toBeVisible()
    await expect(settings.locator('form')).toBeVisible()
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    await localGroup.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(settings.getByLabel('Hostname, IP or pattern', { exact: true })).toBeFocused()
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    await settings.getByRole('radio', { name: 'Relaxed', exact: true }).click()
    await expect(settings.getByText('Trusted unsafe networks', { exact: true })).toBeVisible()
    await expect(settings.getByRole('textbox', { name: 'Search network addresses' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('relaxed-mode.png') })
    await settings.getByRole('button', { name: 'Close settings' }).click()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
