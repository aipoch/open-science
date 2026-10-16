import { expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

// The deterministic provider invokes the real MCP code-risk gate. The approved command only
// prints text, so this journey needs neither a scientific runtime nor an external service.
test.use({ windowMode: 'normal' })

for (const decision of ['allow', 'deny'] as const) {
  test(`Home shows risky code approval as waiting until the user chooses ${decision}`, async ({
    app
  }, testInfo) => {
    const evidenceDirectory = resolve('.scratch/session-wait-status', decision)
    await mkdir(evidenceDirectory, { recursive: true })
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await createProjectViaUi(page, 'Risky code wait status')
    const prompt = 'Verify risky code Home wait status.'
    await submitPromptViaUi(page, prompt)

    const approval = page.getByTestId('permission-card')
    await expect(approval)
      .toHaveAttribute('aria-label', 'Permission request: Review potentially destructive code')
      .catch(async (error) => {
        const diagnosticsPath = join(evidenceDirectory, 'initial-approval-failure.json')
        await writeFile(
          diagnosticsPath,
          JSON.stringify(
            {
              runtime: await page.evaluate(() => window.api.acp.getState()),
              providerPrompts: await app.readFakeAgentPrompts()
            },
            null,
            2
          )
        )
        await testInfo.attach('initial-approval-failure', {
          path: diagnosticsPath,
          contentType: 'application/json'
        })
        throw error
      })
    await expect(approval).toContainText('risky-code-home-completed')
    const pendingRequest = await page.evaluate(async () =>
      (await window.api.acp.getState()).pendingPermissions.find(
        (request) => request.title === 'Review potentially destructive code'
      )
    )
    expect(pendingRequest).toMatchObject({ appOwned: true })

    await page.getByRole('button', { name: 'All projects', exact: true }).click()
    const updates = page.getByRole('region', { name: 'Session updates', exact: true })
    const waitingSession = updates.getByRole('button', { name: /, waiting for permission$/ })
    await expect(waitingSession).toBeVisible()
    // Reconstruct the existing live approval on Home after renderer state is rebuilt.
    await page.reload({ waitUntil: 'domcontentloaded' })
    expect(
      await page.evaluate(
        async (requestId) =>
          (await window.api.acp.getState()).pendingPermissions.some(
            (request) => request.requestId === requestId
          ),
        pendingRequest!.requestId
      )
    ).toBe(true)
    await expect(waitingSession).toBeVisible()
    await expect(waitingSession).toContainText('Waiting for permission')
    await expect(page.getByText('1 waiting on you', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Projects', exact: true }).getByLabel('1 waiting on you')
    ).toBeVisible()
    const pendingScreenshot = join(evidenceDirectory, 'pending.png')
    await page.screenshot({ path: pendingScreenshot, fullPage: true })
    await testInfo.attach('home-pending-risk-approval', {
      path: pendingScreenshot,
      contentType: 'image/png'
    })

    // Leaving the conversation must retain its request and return to the same decision controls.
    await waitingSession.click()
    await expect(approval).toHaveAttribute(
      'aria-label',
      'Permission request: Review potentially destructive code'
    )
    await approval.getByTestId(decision === 'allow' ? 'allow-primary' : 'deny-button').click()
    await expect(approval).toHaveCount(0)
    await expect(
      page.getByText(
        decision === 'allow'
          ? 'Risky code approved and completed.'
          : 'Risky code denied before execution.',
        { exact: true }
      )
    ).toBeVisible()
    await page.getByRole('button', { name: 'All projects', exact: true }).click()
    await expect(updates.getByRole('button', { name: /, waiting for permission$/ })).toHaveCount(0)
    await expect(page.getByText('1 waiting on you', { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('region', { name: 'Projects', exact: true }).getByLabel('1 waiting on you')
    ).toHaveCount(0)
    // The user has read the reply, so this finished Session leaves the active updates list.
    await expect(updates).toHaveCount(0)
    await expect(
      page
        .getByRole('region', { name: 'Recent sessions', exact: true })
        .getByRole('button', { name: new RegExp(prompt) })
    ).toBeVisible()
    const resolvedScreenshot = join(evidenceDirectory, 'resolved.png')
    await page.screenshot({ path: resolvedScreenshot, fullPage: true })
    await testInfo.attach('home-after-risk-approval', {
      path: resolvedScreenshot,
      contentType: 'image/png'
    })
  })
}
