import { expect } from '@playwright/test'

import { createProject, openProjectSession, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

// Build with `node scripts/build-wsl-setup-e2e.mjs`, then set OPEN_SCIENCE_E2E_WSL_SETUP=1.
// Opt in on a Windows development-preview build. Calls the real main-process WSL probe through
// the deterministic Agent's MCP connection, without installing or changing the host environment.
test.describe('WSL setup conversation', () => {
  test.skip(process.platform !== 'win32' || process.env.OPEN_SCIENCE_E2E_WSL_SETUP !== '1')

  test('manual command grants setup tools only to its conversation and survives restart', async ({
    app
  }) => {
    test.setTimeout(240_000)
    let page = await app.completeOnboarding()
    page = await app.configureFakeAgent()
    const preview = await page.evaluate(() => window.api.settings.getWsl2BashPreviewStatus())
    expect(preview.available, JSON.stringify(preview)).toBe(true)
    const projectName = 'WSL setup verification'
    await createProject(page, projectName)
    await sendPrompt(
      page,
      'Verify WSL setup tools are unavailable.',
      'WSL setup tools are unavailable in this ordinary conversation.',
      60_000
    )

    const selectedDistro = process.env.OPEN_SCIENCE_WSL_DISTRO
    const selectedUser = process.env.OPEN_SCIENCE_WSL_USER
    if (selectedDistro && selectedUser) {
      const snapshot = await page.evaluate(
        (selection) => window.api.settings.selectWslProfile(selection),
        { distro: selectedDistro, user: selectedUser }
      )
      expect(snapshot.state, JSON.stringify(snapshot)).toBe('ready')
      await page.evaluate(() => window.api.settings.useWsl2Bash())
    }
    const originalBackend = await page.evaluate(() =>
      window.api.settings.getLocalShellRuntimePreference()
    )

    const composer = page.getByRole('textbox', { name: 'Ask anything' })
    await composer.fill('/setup-wsl')
    await page.getByTestId('product-command-setup-wsl').click()
    await expect(composer).toContainText('Set up or repair WSL2 Bash in Open-Science.')
    const previewText = await composer.innerText()
    expect(previewText).not.toContain('setupSessionToken')
    await sendPrompt(
      page,
      `${previewText}\n\nVerify WSL setup diagnostic tools.`,
      'WSL setup diagnostics completed through the application tools.',
      90_000
    )
    const prompts = await app.readFakeAgentPrompts()
    expect(prompts.some(({ prompt }) => prompt.includes('setupSessionToken'))).toBe(false)
    expect(
      prompts.some(
        ({ prompt }) =>
          prompt.includes('Diagnostic snapshot:') &&
          prompt.includes('Verify WSL setup diagnostic tools.')
      )
    ).toBe(true)
    await expect(page.getByTestId('wsl-setup-conversation-actions')).toBeVisible()
    expect(await page.evaluate(() => window.api.settings.getLocalShellRuntimePreference())).toBe(
      originalBackend
    )

    page = await app.restart()
    await openProjectSession(page, projectName, 'Set up or repair WSL2 Bash in Open-Science.')
    await sendPrompt(
      page,
      'Verify WSL setup diagnostic tools.',
      'WSL setup diagnostics completed through the application tools.',
      90_000
    )
    await expect(page.getByTestId('wsl-setup-conversation-actions')).toBeVisible()

    // Reopening the original ordinary Session must not inherit setup authority from the last one.
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button', {
        name: /^Session status: .*Verify WSL setup tools are unavailable\./u
      })
      .click()
    await sendPrompt(
      page,
      'Verify WSL setup tools are unavailable.',
      'WSL setup tools are unavailable in this ordinary conversation.',
      60_000
    )
    await expect(page.getByTestId('wsl-setup-conversation-actions')).toHaveCount(0)
  })
})
