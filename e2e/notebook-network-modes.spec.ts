import { createServer } from 'node:http'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { openSettingsPage, setTheme } from './fixtures/settings-preferences'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

test.use({ windowMode: 'normal' })
for (const mode of ['Relaxed', 'Strict'] as const) {
  test(`saves an existing ${mode} address inline with cancel and confirmation`, async ({
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
    if (mode === 'Strict') {
      await settings.getByRole('radio', { name: 'Strict', exact: true }).click()
      await settings.getByRole('button', { name: 'Switch to Strict mode', exact: true }).click()
    }
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
      const description = await settings
        .getByText('Authorize HTTP or direct IP access to an exact protocol, host and port.', {
          exact: true
        })
        .boundingBox()
      expect(heading).not.toBeNull()
      expect(action).not.toBeNull()
      expect(action!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width)
      expect(description).not.toBeNull()
      expect(
        Math.abs(action!.y + action!.height - (description!.y + description!.height))
      ).toBeLessThanOrEqual(1)
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
    await address.screenshot({ path: testInfo.outputPath('address-row.png') })
    await address.getByRole('button', { name: 'Edit', exact: true }).click()
    const form = settings.locator('form')
    await expect(add).toBeVisible()
    await expect(add).toBeDisabled()
    if (mode === 'Strict')
      await expect(
        settings.locator('details').filter({ hasText: 'Ungrouped' }).locator('form')
      ).toBeVisible()
    await form.screenshot({ path: testInfo.outputPath('inline-edit.png') })
    await hostname.fill('discarded.local')
    await settings.getByLabel('Port', { exact: true }).focus()
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(address).toBeVisible()
    await expect(settings.locator('code').filter({ hasText: 'discarded.local' })).toHaveCount(0)
    await address.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(hostname).toHaveValue('review.local')
    await hostname.fill('not a valid host')
    await hostname.press('Enter')
    await expect(form.getByRole('alert')).toBeVisible()
    await expect(form).toBeVisible()
    await hostname.fill('changed.local')
    await hostname.press('Enter')
    await expect(form).toHaveCount(0)
    const changed = settings.locator('code').filter({ hasText: 'changed.local' }).locator('..')
    await expect(changed).toBeVisible()
    await changed.getByRole('button', { name: 'Edit', exact: true }).click()
    await hostname.fill('confirmed.local')
    await form.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(settings.locator('code').filter({ hasText: 'confirmed.local' })).toBeVisible()
    const remove = settings.getByRole('button', { name: 'Remove confirmed.local', exact: true })
    const confirmation = page.getByRole('dialog', { name: 'Delete address?', exact: true })
    await remove.click()
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText('confirmed.local')
    await expect(settings.locator('code').filter({ hasText: 'confirmed.local' })).toBeVisible()
    await confirmation.screenshot({ path: testInfo.outputPath('delete-confirmation.png') })
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(remove).toBeFocused()
    await remove.click()
    await page.keyboard.press('Escape')
    await expect(confirmation).toHaveCount(0)
    await expect(remove).toBeVisible()
    await remove.click()
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(settings.locator('code').filter({ hasText: 'confirmed.local' })).toHaveCount(0)
    await expect(confirmation).toHaveCount(0)
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
  test.skip(!python, 'Requires an isolated Python with ipykernel via OPEN_SCIENCE_TEST_PYTHON')
  if (!python) return
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
    await expect(settings.getByLabel('Hostname', { exact: true })).toHaveValue('incomplete address')
    expect(
      (await page.evaluate(() => window.api.settings.getSettings())).notebookNetwork?.mode ??
        'relaxed'
    ).toBe('relaxed')
    await settings.getByRole('button', { name: 'Switch to Strict mode', exact: true }).click()
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
    await settings.getByRole('combobox', { name: 'Network protocol', exact: true }).click()
    await page.getByRole('listbox').screenshot({ path: testInfo.outputPath('protocol-select.png') })
    await page.getByRole('option', { name: 'HTTP', exact: true }).click()
    await settings.getByLabel('Hostname, IP or pattern', { exact: true }).fill('localhost')
    await settings.getByLabel('Port', { exact: true }).fill(String(address.port))
    await settings.getByRole('combobox', { name: 'Group', exact: true }).click()
    await page.getByRole('listbox').screenshot({ path: testInfo.outputPath('group-select.png') })
    await page.getByRole('option', { name: 'New group…', exact: true }).click()
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
    await localGroup.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(
      localGroup.getByText(`http://127.0.0.1:${address.port}`, { exact: true })
    ).toBeVisible()
    await expect(settings.locator('form')).toHaveCount(0)
    await localGroup.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(settings.getByLabel('Hostname, IP or pattern', { exact: true })).toBeFocused()
    await localGroup.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(settings.locator('form')).toHaveCount(0)
    await settings.getByRole('radio', { name: 'Relaxed', exact: true }).click()
    await settings.getByRole('button', { name: 'Switch to Relaxed mode', exact: true }).click()
    await expect(settings.getByText('Trusted unsafe networks', { exact: true })).toBeVisible()
    await expect(settings.getByRole('textbox', { name: 'Search network addresses' })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('relaxed-mode.png') })
    await settings.getByRole('button', { name: 'Close settings' }).click()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

for (const theme of ['Light', 'Dark'] as const) {
  test(`confirms network mode changes with keyboard and compact ${theme} layout`, async ({
    app
  }, testInfo) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await setTheme(page, theme)
    await page.setViewportSize({ width: 791, height: 874 })
    const settings = await openSettingsPage(page, 'Network')
    await settings.getByRole('button', { name: 'Manage access', exact: true }).click()
    const checkRuleDisclosure = async (mode: 'Relaxed' | 'Strict'): Promise<void> => {
      const summary = settings.locator('summary').filter({ hasText: `How ${mode} mode works` })
      const disclosure = summary.locator('..')
      // Hit the surrounding padding, not the label, to cover the full disclosure header.
      await disclosure.click({ position: { x: 8, y: 8 } })
      await expect(disclosure).toHaveAttribute('open', '')
      const bounds = await summary.boundingBox()
      await summary.click({ position: { x: bounds!.width - 8, y: 8 } })
      await expect(disclosure).not.toHaveAttribute('open', '')
      await summary.focus()
      await summary.press('Enter')
      await expect(disclosure).toHaveAttribute('open', '')
      await summary.press('Space')
      await expect(disclosure).not.toHaveAttribute('open', '')
    }
    await checkRuleDisclosure('Relaxed')
    const relaxed = settings.getByRole('radio', { name: 'Relaxed', exact: true })
    const strict = settings.getByRole('radio', { name: 'Strict', exact: true })
    const panel = settings.getByRole('region', { name: 'Confirm network mode change', exact: true })
    await expect(relaxed).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(strict).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    const active = async (): Promise<'relaxed' | 'strict'> =>
      (await page.evaluate(() => window.api.settings.getSettings())).notebookNetwork?.mode ??
      'relaxed'
    const selector = settings.getByRole('radiogroup', { name: 'Select a network mode to confirm' })
    const bounds = await selector.boundingBox()
    expect(bounds!.height).toBeLessThanOrEqual(37)
    expect(bounds!.width).toBeLessThanOrEqual(193)
    await strict.click()
    await expect(panel).toBeVisible()
    await expect(strict).toBeChecked()
    await expect(strict).toHaveCSS('border-style', 'dashed')
    await expect(strict).toHaveCSS('border-width', '1px')
    await expect(strict).not.toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(relaxed).not.toBeChecked()
    await expect(settings.getByText('Current: Relaxed', { exact: true })).toHaveClass('sr-only')
    expect(await active()).toBe('relaxed')
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('pending-strict.png')
    })
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(relaxed).toBeFocused()
    await expect(relaxed).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(strict).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await strict.click()
    await page.keyboard.press('Escape')
    await expect(settings).toBeVisible()
    await expect(panel).toHaveCount(0)
    await expect(relaxed).toBeFocused()
    await relaxed.press('End')
    await expect(strict).toBeFocused()
    await strict.press('Enter')
    expect(await active()).toBe('relaxed')
    await strict.press('Tab')
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      panel.getByRole('button', { name: 'Switch to Strict mode', exact: true })
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(panel).toHaveCount(0)
    await expect(settings.getByText('Current: Strict', { exact: true })).toHaveClass('sr-only')
    expect(await active()).toBe('strict')
    await checkRuleDisclosure('Strict')
    await expect(strict).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('confirmed-strict.png')
    })
    await strict.press('Home')
    expect(await active()).toBe('strict')
    await expect(relaxed).toHaveCSS('border-style', 'dashed')
    await expect(relaxed).not.toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await expect(panel.getByText('Network access will expand.', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Switch to Relaxed mode', exact: true }).click()
    await expect(settings.getByText('Current: Relaxed', { exact: true })).toHaveClass('sr-only')
    expect(await active()).toBe('relaxed')
    await expect(relaxed).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
    await strict.click()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'de' }))
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    const germanPanel = page.getByRole('region', {
      name: 'Netzwerkmoduswechsel bestätigen',
      exact: true
    })
    await expect(germanPanel).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('compact-german.png')
    })
    expect(await germanPanel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const clipped = await germanPanel
      .locator('button')
      .evaluateAll((buttons) =>
        buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent)
      )
    expect(clipped).toEqual([])
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await expect(settings).toBeHidden()
    expect(await active()).toBe('relaxed')
  })
}
