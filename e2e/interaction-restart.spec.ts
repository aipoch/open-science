import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const scenarios = [
  { action: 'approve', restart: true },
  { action: 'dismiss', restart: true },
  { action: 'comment', restart: true },
  { action: 'comment', restart: 'crash' },
  { action: 'comment', restart: false },
  { action: 'question', restart: true },
  { action: 'question', restart: false },
  { action: 'permission-allow', restart: true },
  { action: 'permission-deny', restart: true }
] as const

for (const { action, restart } of scenarios) {
  test(`delivers ${action} ${restart === 'crash' ? 'after an application crash with a parked Plan' : restart ? 'after a real application restart' : 'in the live session'}`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill(`Restart ${action}`)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    const permission = action === 'permission-allow' || action === 'permission-deny'
    const prompt = permission
      ? 'Request restart verification permission.'
      : action === 'question'
        ? 'Ask a restart verification question.'
        : 'Create a restart verification Plan.'
    await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
    if (permission) await expect(page.getByTestId('permission-card')).toBeVisible()
    else if (action === 'question')
      await expect(
        page.getByText('Restart verification dataset?', { exact: true }).first()
      ).toBeVisible()
    else
      await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
    if (permission) {
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const { sessions } = await window.api.sessions.loadAll()
            return sessions[0]?.runtimeContext?.permission?.state
          })
        )
        .toBe('pending')
    }
    if (permission)
      await testInfo.attach('permission-before', {
        body: JSON.stringify(
          await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
        ),
        contentType: 'application/json'
      })
    await page.screenshot({ path: testInfo.outputPath('before-restart.png') })
    if (action === 'comment' && restart === true) {
      const panel = page.getByTestId('plan-composer')
      const expandedHeight = (await panel.boundingBox())!.height
      await expect(
        panel.locator('article').getByRole('button', { name: 'Collapse Plan' })
      ).toHaveCount(0)
      const toggleBounds = (await page
        .getByRole('button', { name: 'Collapse Plan' })
        .boundingBox())!
      expect(toggleBounds.y + toggleBounds.height).toBeLessThanOrEqual(
        (await panel.locator('article').boundingBox())!.y
      )
      await panel.screenshot({ path: testInfo.outputPath('expanded-plan-control.png') })
      const panelBounds = (await panel.boundingBox())!
      expect(
        Math.abs(toggleBounds.x + toggleBounds.width / 2 - panelBounds.x - panelBounds.width / 2)
      ).toBeLessThan(1)
      await page.getByRole('button', { name: 'Collapse Plan' }).hover()
      await panel.screenshot({ path: testInfo.outputPath('hover-plan-control.png') })
      const controlX = toggleBounds.x + toggleBounds.width / 2
      const controlY = toggleBounds.y + toggleBounds.height / 2
      await page.mouse.move(controlX, controlY)
      await page.mouse.down()
      await page.mouse.move(controlX, controlY - 24, { steps: 4 })
      await page.mouse.move(controlX, controlY, { steps: 4 })
      await page.mouse.up()
      await expect(page.getByRole('button', { name: 'Collapse Plan' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      await page.getByRole('textbox', { name: 'Respond to Plan' }).fill('Keep this revision draft.')
      await page.getByRole('button', { name: 'Collapse Plan' }).click()
      await expect(page.getByRole('textbox', { name: 'Respond to Plan' })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
      expect((await panel.boundingBox())!.height).toBeLessThan(expandedHeight)
      await page.screenshot({ path: testInfo.outputPath('collapsed-plan.png') })
      await panel.screenshot({ path: testInfo.outputPath('collapsed-plan-control.png') })
      await page.getByRole('button', { name: 'Expand Plan' }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('textbox', { name: 'Respond to Plan' })).toHaveValue(
        'Keep this revision draft.'
      )
      await page.getByRole('button', { name: 'Collapse Plan' }).click()
    }
    if (restart) {
      if (restart === 'crash') {
        await expect
          .poll(async () =>
            page.evaluate(async () =>
              (await window.api.sessions.loadAll()).sessions[0]?.activities?.some(
                ({ id }) => id === 'e2e-restart-plan-generation'
              )
            )
          )
          .toBe(true)
        expect(
          await page.evaluate(async () =>
            Boolean((await window.api.sessions.loadAll()).sessions[0]?.activeRun)
          )
        ).toBe(true)
        page = await app.restartAfterCrash({ force: true })
      } else {
        const quittingPage = page
        const restarting = app.restart()
        // A live generate_plan waiter triggers the ordinary running-work quit confirmation.
        const confirmQuit = quittingPage.getByRole('button', { name: 'Quit', exact: true })
        await confirmQuit
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => confirmQuit.click())
          .catch(() => undefined)
        page = await restarting
      }
      await page
        .getByRole('region', { name: 'Recent sessions' })
        .getByRole('button', { name: prompt })
        .click()
      if (action === 'comment' && restart === true) {
        await expect(page.getByRole('button', { name: 'Collapse Plan' })).toBeVisible()
        await expect(page.getByRole('textbox', { name: 'Respond to Plan' })).toBeVisible()
      }
    }
    if (action === 'comment' && !restart) {
      await page.evaluate(async () => {
        const session = (await window.api.sessions.loadAll()).sessions[0]
        await window.api.acp.cancel({ sessionId: session.id })
      })
      await expect
        .poll(async () =>
          page.evaluate(async () =>
            Boolean((await window.api.sessions.loadAll()).sessions[0]?.activeRun)
          )
        )
        .toBe(false)
    }
    if (action === 'approve' || action === 'dismiss' || action === 'comment') {
      const stoppedPlan = await page.evaluate(async () => {
        const session = (await window.api.sessions.loadAll()).sessions[0]
        return {
          owner: session.runtimeTranscriptOwner,
          status: session.activities?.find(({ id }) => id === 'e2e-restart-plan-generation')?.status
        }
      })
      expect(stoppedPlan).toEqual({ owner: 'main', status: 'failed' })
      await expect(page.getByText('Created execution Plan', { exact: true })).toBeVisible()
      await expect(page.getByText('Failed to create execution Plan', { exact: true })).toHaveCount(
        0
      )
    }
    if (permission) {
      await testInfo.attach('permission-after', {
        body: JSON.stringify(
          await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
        ),
        contentType: 'application/json'
      })
      await page
        .getByTestId('permission-actions')
        .getByTestId(action === 'permission-allow' ? 'allow-primary' : 'deny-button')
        .click()
    } else if (action === 'question') {
      await expect(
        page.getByText('Restart verification dataset?', { exact: true }).first()
      ).toBeVisible()
      await page.getByText('Dataset Alpha', { exact: true }).first().click()
      await page.getByRole('button', { name: 'Finish', exact: true }).click()
    } else if (action === 'approve') {
      await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
    } else if (action === 'dismiss') {
      await page.getByRole('button', { name: 'Open', exact: true }).first().click()
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    } else {
      await page
        .getByRole('textbox', { name: 'Respond to Plan' })
        .fill('Please verify cohort boundaries.')
      await page.getByRole('button', { name: 'Send Plan feedback' }).click()
    }
    const expected = `Restart verification: ${action === 'approve' ? 'Plan approval' : action === 'dismiss' ? 'Plan dismissal' : action === 'comment' ? 'Plan feedback' : action === 'permission-allow' ? 'Permission approval' : action === 'permission-deny' ? 'Permission denial' : 'Question answer'} delivered.`
    try {
      await expect(page.getByText(expected, { exact: false })).toBeVisible({ timeout: 40_000 })
    } finally {
      if (action === 'comment') {
        await testInfo.attach('plan-feedback-delivery', {
          body: JSON.stringify(
            await page.evaluate(async () => ({
              sessions: (await window.api.sessions.loadAll()).sessions,
              runtime: await window.api.acp.getState()
            }))
          ),
          contentType: 'application/json'
        })
      }
    }
    await expect
      .poll(async () =>
        page.evaluate(async (text) => {
          const { sessions } = await window.api.sessions.loadAll()
          return sessions
            .flatMap((session) => session.messages)
            .filter((message) => message.role === 'agent' && message.content.includes(text)).length
        }, expected)
      )
      .toBe(1)
    if (action === 'comment') {
      await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
      await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
      await expect(
        page.getByText('Restart verification: Plan approval delivered.', { exact: false })
      ).toBeVisible()
    }
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const { sessions } = await window.api.sessions.loadAll()
          return sessions.map((session) => ({
            status: session.status,
            active: Boolean(session.activeRun)
          }))
        })
      )
      .toEqual([{ status: 'idle', active: false }])
    await page.getByRole('textbox', { name: 'Ask anything' }).fill('Verify interaction follow-up.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText('Interaction follow-up completed.', { exact: false })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('after-response.png') })
  })
}

test('keeps a committed Artifact Version when cancelled and immediately followed up', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Cancellation publication')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Publish then wait for cancellation.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Artifact published; waiting for cancellation.', { exact: false })
  ).toBeVisible({ timeout: 60_000 })
  const publication = await page
    .getByText('Artifact provenance verified for session', { exact: false })
    .innerText()
  const versionId = publication.match(/version ([^.]+)\./u)?.[1]
  expect(versionId).toBeTruthy()
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        Boolean((await window.api.sessions.loadAll()).sessions[0].activeRun)
      )
    )
    .toBe(false)
  await expect
    .poll(async () =>
      page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0].artifacts?.length)
    )
    .toBe(1)
  const before = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  const artifact = before.artifacts![0]
  expect(artifact.versionId).toBe(versionId)
  const owner = before.conversationGraph!.messages.find((message) =>
    message.artifactIds?.includes(artifact.id)
  )!
  expect(owner).toBeDefined()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Verify interaction follow-up.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Interaction follow-up completed.', { exact: false })).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0].status)
    )
    .toBe('idle')
  const after = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  expect(after.artifacts).toEqual(before.artifacts)
  expect(
    after
      .conversationGraph!.messages.filter((message) => message.artifactIds?.includes(artifact.id))
      .map((message) => message.id)
  ).toEqual([owner.id])
  expect(after.activeRun).toBeUndefined()
  expect(after.messages.filter((message) => message.role === 'user')).toHaveLength(2)
})
