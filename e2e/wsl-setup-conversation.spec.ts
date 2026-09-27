import { expect } from '@playwright/test'

import { createProject, openProjectSession, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

// Build with `node scripts/build-wsl-setup-e2e.mjs`, then set OPEN_SCIENCE_E2E_WSL_SETUP=1.
// Opt in on a Windows development-preview build. Calls the real main-process WSL probe through
// the deterministic Agent's MCP connection, without installing or changing the host environment.
test.describe('WSL setup conversation', () => {
  test.skip(process.platform !== 'win32' || process.env.OPEN_SCIENCE_E2E_WSL_SETUP !== '1')

  test('executes real WSL Bash through the application before and after restart', async ({
    app
  }, testInfo) => {
    const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
    const user = process.env.OPEN_SCIENCE_WSL_USER
    test.skip(!distro || !user, 'A real WSL profile is required')
    test.setTimeout(240_000)
    let page = await app.completeOnboarding()
    page = await app.configureFakeAgent()
    const snapshot = await page.evaluate(
      (selection) => window.api.settings.selectWslProfile(selection),
      { distro: distro!, user: user! }
    )
    expect(snapshot.state, JSON.stringify(snapshot)).toBe('ready')
    await page.evaluate(() => window.api.settings.useWsl2Bash())
    const projectName = 'Real WSL Bash verification'
    await createProject(page, projectName)
    const prompt = 'Verify real WSL Bash execution.'
    const reply = 'Real WSL Bash execution passed: Linux, non-root user, exit code 0.'
    await sendPrompt(page, prompt, reply, 90_000)
    page = await app.restart()
    await openProjectSession(page, projectName, prompt)
    await sendPrompt(page, prompt, reply, 90_000)
    const screenshot = testInfo.outputPath('wsl-bash-live.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('Real WSL Bash after restart', {
      path: screenshot,
      contentType: 'image/png'
    })
  })

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

  test('updates real WSL background activity from events and cancels through the UI after restart', async ({
    app
  }, testInfo) => {
    const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
    const user = process.env.OPEN_SCIENCE_WSL_USER
    test.skip(!distro || !user, 'A real WSL profile is required')
    test.setTimeout(240_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    const status = await page.evaluate((profile) => window.api.settings.selectWslProfile(profile), {
      distro: distro!,
      user: user!
    })
    expect(status.state).toBe('ready')
    await page.evaluate(() => window.api.settings.useWsl2Bash())
    const projectName = 'WSL lifecycle events'
    const prompt = 'Verify WSL background cancellation.'
    await createProject(page, projectName)
    for (const round of ['initial', 'restarted']) {
      if (round === 'restarted') {
        page = await app.restart()
        await openProjectSession(page, projectName, prompt)
      }
      // Observe the public Electron event bridge while the real renderer consumes the same events.
      await page.evaluate(() => {
        const probe = {
          events: [] as Array<{ projectId: string; sessionId: string; workspaceCwd: string }>,
          stop: () => {}
        }
        probe.stop = window.api.notebook.onChanged(({ projectId, sessionId, workspaceCwd }) =>
          probe.events.push({ projectId, sessionId, workspaceCwd })
        )
        Object.assign(window, { wslEventProbe: probe })
      })
      await sendPrompt(page, prompt, 'WSL background task submitted for cancellation.', 90_000)
      const chip = page.getByTestId('background-tasks-chip')
      await expect(chip).toHaveAttribute('data-active', 'true')
      if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click()
      const ledger = page.getByTestId('session-background-activity')
      await expect(ledger.getByText('Running', { exact: true })).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Compute', exact: true }).click()
      const inbox = page.getByRole('region', { name: 'Compute', exact: true })
      await expect(inbox.getByText('JavaScript REPL', { exact: true }).first()).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`wsl-events-${round}-running.png`),
        fullPage: true
      })
      await ledger.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(chip).not.toHaveAttribute('data-active', 'true', { timeout: 25_000 })
      await expect(ledger.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
      const evidence = await page.evaluate(async () => {
        const probe = (
          window as unknown as {
            wslEventProbe: {
              events: Array<{ projectId: string; sessionId: string; workspaceCwd: string }>
              stop: () => void
            }
          }
        ).wslEventProbe
        probe.stop()
        const scope = probe.events.at(-1)
        if (!scope) throw new Error('No Notebook lifecycle events reached the renderer')
        const reference = await window.api.notebook.getReference(scope)
        if (!reference) throw new Error('Missing Notebook after WSL execution')
        const state = await window.api.notebook.state(reference)
        return {
          events: probe.events,
          runs: state.runs
            .filter(({ kernelKind }) => kernelKind === 'bash')
            .map(({ runId, status, cancellationRequestedAt }) => ({
              runId,
              status,
              cancellationRequestedAt
            }))
        }
      })
      expect(evidence.events.length).toBeGreaterThanOrEqual(3)
      expect(evidence.runs.filter(({ status }) => status === 'cancelled')).toHaveLength(
        round === 'initial' ? 1 : 2
      )
      expect(
        evidence.runs.every(({ cancellationRequestedAt }) => cancellationRequestedAt !== undefined)
      ).toBe(true)
      await testInfo.attach(`wsl-events-${round}`, {
        contentType: 'application/json',
        body: JSON.stringify(evidence)
      })
      const screenshot = testInfo.outputPath(`wsl-events-${round}-cancelled.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(`WSL cancellation ${round}`, {
        path: screenshot,
        contentType: 'image/png'
      })
      // Keep Compute mounted while a real kernel termination invalidates its snapshot.
      // The REPL uses the host runtime; the Shell task above uses the selected WSL profile.
      await page.evaluate(async (scope) => {
        const reference = await window.api.notebook.getReference(scope)
        if (!reference) throw new Error('Missing Notebook before kernel shutdown')
        await window.api.notebook.shutdown(reference)
      }, evidence.events.at(-1)!)
      await expect(inbox.getByText('No active kernels', { exact: true })).toBeVisible()
      await expect(inbox.getByText('JavaScript REPL', { exact: true })).toHaveCount(0)
      const inboxScreenshot = testInfo.outputPath(`wsl-compute-${round}-stopped.png`)
      await page.screenshot({ path: inboxScreenshot, fullPage: true })
      await testInfo.attach(`Compute kernel stop ${round}`, {
        path: inboxScreenshot,
        contentType: 'image/png'
      })
    }
  })
})
