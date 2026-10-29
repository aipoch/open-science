import { realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'
import { openSettingsPage } from './fixtures/settings-preferences'

test.use({ windowMode: 'normal' })

test('persists project destination consent, retries explicitly, and revokes after restart', async ({
  app
}, testInfo) => {
  test.skip(
    process.platform === 'win32',
    'Exercises the native POSIX curl gateway; WSL requires an explicitly provisioned test runtime.'
  )
  test.setTimeout(240_000)
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.end('accepted')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.evaluate(
      async (path) => {
        await window.api.settings.setDefaultPermissionProfile({ profile: 'auto' })
        await window.api.runtime.registerInterpreter('python', path)
        const { python } = await window.api.runtime.listEnvironments()
        const runtime = python.find(
          (entry) => entry.interpreterPath === path || entry.envId === path
        )
        if (!runtime) throw new Error('Registered Python was not found')
        await window.api.runtime.setEnvironmentEnabled('python', runtime.envId, true)
        const enabled = (await window.api.runtime.listEnvironments()).python.find(
          (entry) => entry.envId === runtime.envId
        )
        if (!enabled?.runnable)
          throw new Error(`Registered Python is not runnable: ${JSON.stringify(enabled)}`)
      },
      await realpath(process.env.OPEN_SCIENCE_TEST_PY_ENV ?? '/usr/bin/python3')
    )
    const info = await page.evaluate(() => window.api.storage.getInfo())
    expect(await realpath(info.dataRoot)).toContain(await realpath(tmpdir()))
    await testInfo.attach('isolation-self-check', {
      body: JSON.stringify({
        dataRoot: await realpath(info.dataRoot),
        python: await realpath(process.env.OPEN_SCIENCE_TEST_PY_ENV ?? '/usr/bin/python3'),
        micromamba: process.env.OPEN_SCIENCE_MICROMAMBA_BIN
      }),
      contentType: 'application/json'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await createProjectViaUi(page, 'Network approval regression')
    const prompt = `Verify network destination approval port ${address.port}.`
    await submitPromptViaUi(page, prompt)
    const card = page.getByTestId('permission-card')
    await expect(card).toContainText('Sensitive destination', { timeout: 40_000 })
    await expect(card).toContainText('127.0.0.1')
    await expect(card.getByTestId('allow-primary')).toHaveText('Allow for this project')
    expect(requests).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('destination-approval.png') })
    await card.getByTestId('allow-primary').click()
    await page.getByTestId('permission-scope-confirm').click()
    await expect(
      page.getByText('Network destination explicit retry verified.', { exact: true })
    ).toBeVisible({ timeout: 60_000 })
    expect(requests).toBe(1)
    const grants = await page.evaluate(
      async () => (await window.api.settings.getSettings()).notebookNetwork?.destinationGrants
    )
    expect(grants).toEqual([
      expect.objectContaining({
        scope: 'project',
        hostname: '127.0.0.1',
        port: address.port,
        approvedAddresses: ['127.0.0.1']
      })
    ])
    page = await app.restart()
    await page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button')
      .filter({ hasText: prompt })
      .click()
    await submitPromptViaUi(page, prompt)
    await expect(
      page.getByText('Network destination saved access verified.', { exact: true })
    ).toBeVisible({ timeout: 60_000 })
    expect(requests).toBe(2)
    const settingsPage = await openSettingsPage(page, 'Network')
    await settingsPage.getByRole('button', { name: 'Manage access', exact: true }).click()
    await expect(
      settingsPage.getByText('Approved network destinations', { exact: true })
    ).toBeVisible()
    await expect(settingsPage).toContainText('127.0.0.1')
    await settingsPage.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(
      settingsPage.getByText('Approved network destinations', { exact: true })
    ).toHaveCount(0)
    await settingsPage.getByRole('button', { name: 'Close settings' }).click()
    await submitPromptViaUi(page, prompt)
    await expect(page.getByTestId('permission-card')).toContainText('Sensitive destination', {
      timeout: 40_000
    })
    expect(requests).toBe(2)
    await page.getByTestId('deny-button').click()
    await expect(page.getByText(/Destination was not approved/)).toBeVisible({ timeout: 30_000 })
    expect(requests).toBe(2)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
