import { writeFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { ReviewWithChecks } from '../src/shared/reviewer'
import { test } from './fixtures/electron-app'

async function snapshot(
  page: Page
): Promise<{ session: PersistedChatSession; reviews: ReviewWithChecks[] }> {
  return page.evaluate(async () => {
    const session = (await window.api.sessions.loadAll()).sessions[0]
    const reviews = session
      ? await window.api.reviewer.getForSession({
          projectId: session.projectId,
          appSessionId: session.id
        })
      : []
    return { session, reviews }
  })
}

for (const scenario of [
  'ordinary stop',
  'correction stop',
  'correction complete',
  'correction repeat stop',
  'correction disabled stop',
  'correction reflag stop',
  'correction restart stop'
]) {
  test(`auto-review regression: ${scenario}`, async ({ app }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.locator('header').getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill(`Review diagnostic ${scenario}`)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await page.getByTestId('composer-controls-trigger').click()
    await page.getByRole('menuitem', { name: 'Auto-review', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('composer-controls-trigger')).toHaveAttribute(
      'aria-label',
      /auto-review On/
    )
    await page
      .getByRole('textbox', { name: 'Ask anything' })
      .fill(
        `Run auto review ${scenario === 'correction restart stop' ? 'correction stop' : scenario} scenario.`
      )
    await page.getByRole('button', { name: 'Send message' }).click()

    if (scenario.endsWith('stop')) {
      await expect(
        page.getByText(
          scenario === 'ordinary stop'
            ? 'Ordinary execution is running; ready for Stop.'
            : 'Correction is running; ready for Stop.',
          { exact: false }
        )
      ).toBeVisible({ timeout: 90_000 })
      const beforeStop = await snapshot(page)
      await writeFile(testInfo.outputPath('before-stop.json'), JSON.stringify(beforeStop, null, 2))
      await testInfo.attach('before-stop', {
        body: JSON.stringify(beforeStop, null, 2),
        contentType: 'application/json'
      })
      await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
      const stopped = await snapshot(page)
      await writeFile(testInfo.outputPath('stopped.json'), JSON.stringify(stopped, null, 2))
      await testInfo.attach('stopped', {
        body: JSON.stringify(stopped, null, 2),
        contentType: 'application/json'
      })
      expect(stopped.session.autoReviewEnabled).toBe(true)
      expect(stopped.session.resumeRecovery?.cause).toBe('cancelled')
      if (scenario === 'correction restart stop') {
        page = await app.restart()
        await page
          .getByRole('region', { name: 'Recent sessions' })
          .getByRole('button', { name: /Run auto review correction stop scenario/ })
          .click()
        await expect(
          page.getByRole('button', { name: 'Resume session', exact: true })
        ).toBeVisible()
      }
      if (scenario === 'correction disabled stop') {
        await page.getByTestId('composer-controls-trigger').click()
        await page.getByRole('menuitem', { name: 'Auto-review', exact: true }).click()
        await page.keyboard.press('Escape')
      }
      await page.getByRole('button', { name: 'Resume session', exact: true }).click()
      if (scenario === 'correction repeat stop') {
        await expect(
          page.getByText('Recovered correction is running; ready for Stop.', { exact: false })
        ).toBeVisible()
        await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
        await expect(
          page.getByRole('button', { name: 'Resume session', exact: true })
        ).toBeVisible()
        await page.getByRole('button', { name: 'Resume session', exact: true }).click()
      }
      await expect(
        page.getByText(
          scenario === 'correction reflag stop'
            ? 'Recovered execution still needs correction.'
            : 'Recovered execution completed successfully.',
          { exact: false }
        )
      ).toBeVisible()
    }
    await expect.poll(async () => (await snapshot(page)).session?.status).toBe('idle')
    if (scenario === 'correction disabled stop') {
      await page.waitForTimeout(1500)
      expect((await snapshot(page)).reviews).toHaveLength(1)
    } else if (scenario.startsWith('correction')) {
      await expect
        .poll(async () => (await snapshot(page)).reviews.length, { timeout: 90_000 })
        .toBe(scenario === 'correction reflag stop' ? 3 : 2)
      await expect
        .poll(
          async () => {
            const state = await snapshot(page)
            return state.reviews.some((review) =>
              review.checks.some((check) => check.resolution === 'resolved')
            )
          },
          { timeout: 90_000 }
        )
        .toBe(true)
      expect(
        (await snapshot(page)).reviews.every((review) => review.lifecycle === 'complete')
      ).toBe(true)
    } else if (scenario === 'ordinary stop') {
      await expect
        .poll(
          async () =>
            (await snapshot(page)).reviews.filter((r) => r.lifecycle === 'complete').length,
          { timeout: 90_000 }
        )
        .toBe(1)
    }
    const final = await snapshot(page)
    await writeFile(
      testInfo.outputPath('final-session-and-reviews.json'),
      JSON.stringify(final, null, 2)
    )
    await writeFile(
      testInfo.outputPath('provider-prompts.json'),
      JSON.stringify(await app.readFakeAgentPrompts(), null, 2)
    )
    await testInfo.attach('final-session-and-reviews', {
      body: JSON.stringify(final, null, 2),
      contentType: 'application/json'
    })
    await testInfo.attach('provider-prompts', {
      body: JSON.stringify(await app.readFakeAgentPrompts(), null, 2),
      contentType: 'application/json'
    })
    await app.captureMainLog(`auto-review-${scenario.replaceAll(' ', '-')}.log`)
    await page.screenshot({ path: testInfo.outputPath('final.png'), fullPage: true })
    expect(final.session.autoReviewEnabled).toBe(scenario !== 'correction disabled stop')
    if (scenario === 'correction stop' || scenario === 'correction repeat stop') {
      const promptId = final.session.runtimeTranscriptLastRun?.promptMessageId
      expect(final.session.messages.find((m) => m.id === promptId)?.attribution).toMatchObject({
        feature: 'reviewer',
        purpose: 'correction'
      })
      expect(
        final.reviews.some((review) =>
          review.checks.some((check) => check.resolution === 'resolved')
        )
      ).toBe(true)
      expect(
        final.session.messages.filter(
          (message) => message.attribution?.feature === 'reviewer' && message.role === 'user'
        )
      ).toHaveLength(1)
    }
  })
}
