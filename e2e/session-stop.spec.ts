import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, type TestInfo } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProject, sendPrompt } from './certification/helpers'
import { test, type ElectronApp } from './fixtures/electron-app'
import { assertStopWindowIsolation, holdStopAdmission } from './fixtures/session-stop-gate'

test.use({ windowMode: 'hidden' })
const STOPPING = 'Stopping run and subagents'

async function session(page: Page): Promise<PersistedChatSession> {
  return page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
}

async function submit(app: ElectronApp, page: Page, prompt: string): Promise<void> {
  await assertStopWindowIsolation(app)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

async function setup(app: ElectronApp, name: string): Promise<Page> {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  await createProject(page, name)
  await assertStopWindowIsolation(app)
  return page
}

async function evidence(
  app: ElectronApp,
  page: Page,
  testInfo: TestInfo,
  name: string,
  phases: Record<string, number>
): Promise<void> {
  const screenshot = testInfo.outputPath(name + '.png')
  await page.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach(name + '-screenshot', { path: screenshot, contentType: 'image/png' })
  const recordPath = testInfo.outputPath(name + '.json')
  await writeFile(
    recordPath,
    JSON.stringify(
      { phases, session: await session(page), providerPrompts: await app.readFakeAgentPrompts() },
      null,
      2
    )
  )
  await testInfo.attach(name, {
    path: recordPath,
    contentType: 'application/json'
  })
}

for (const output of ['silent', 'thought-only'] as const) {
  test(`one Stop click during ${output} Thinking stays pending until provider termination and the next prompt runs`, async ({
    app
  }, testInfo) => {
    const page = await setup(app, 'First click Stop while Thinking')
    const directory = await app.createTestDirectory('silent-stop')
    const prompt =
      'Hold silent thinking until one Stop.\nStop fixture output: ' +
      output +
      '\nStop fixture directory: ' +
      JSON.stringify(directory)
    const phases: Record<string, number> = { submittedAt: Date.now() }
    const cancellations = async (): Promise<Array<{ at: number }>> =>
      (await readFile(join(directory, 'provider-cancellations.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { at: number })
    try {
      await submit(app, page, prompt)
      await expect
        .poll(async () =>
          readFile(join(directory, 'provider-ready.json'), 'utf8')
            .then(() => true)
            .catch(() => false)
        )
        .toBe(true)
      phases.providerReadyAt = JSON.parse(
        await readFile(join(directory, 'provider-ready.json'), 'utf8')
      ).at
      expect(
        JSON.parse(await readFile(join(directory, 'provider-ready.json'), 'utf8')).thoughtOnly
      ).toBe(output === 'thought-only')
      const thinking = await session(page)
      expect(
        (thinking.conversationGraph?.messages ?? thinking.messages).some(
          ({ role, content }) => role === 'agent' && content.trim().length > 0
        )
      ).toBe(false)
      await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeEnabled()
      await assertStopWindowIsolation(app)
      phases.stopClickedAt = Date.now()
      await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
      await expect.poll(async () => (await cancellations()).length).toBe(1)
      phases.providerCancelObservedAt = (await cancellations())[0].at
      phases.clickToProviderCancelMs = phases.providerCancelObservedAt - phases.stopClickedAt
      await expect(page.getByRole('button', { name: STOPPING, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: STOPPING, exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
      expect(
        await readFile(join(directory, 'provider-terminal.json'), 'utf8').catch(() => undefined)
      ).toBeUndefined()
      await evidence(app, page, testInfo, 'one-stop-pending-provider-terminal', phases)

      phases.terminalReleasedAt = Date.now()
      await writeFile(join(directory, 'release-terminal'), '')
      await expect.poll(async () => Boolean((await session(page)).activeRun)).toBe(false)
      phases.durableSettledAt = Date.now()
      phases.releaseToDurableSettledMs = phases.durableSettledAt - phases.terminalReleasedAt
      phases.providerTerminalAt = JSON.parse(
        await readFile(join(directory, 'provider-terminal.json'), 'utf8')
      ).at
      phases.releaseToProviderTerminalMs = phases.providerTerminalAt - phases.terminalReleasedAt
      phases.providerTerminalToDurableSettledMs =
        phases.durableSettledAt - phases.providerTerminalAt
      await expect(page.getByRole('button', { name: STOPPING, exact: true })).toHaveCount(0)
      phases.stopSettledAt = Date.now()
      phases.releaseToUiSettledMs = phases.stopSettledAt - phases.terminalReleasedAt
      expect(await cancellations()).toHaveLength(1)
      expect((await session(page)).resumeRecovery).toMatchObject({
        kind: 'resume-required',
        cause: 'cancelled'
      })
      await assertStopWindowIsolation(app)
      await sendPrompt(page, 'Verify interaction follow-up.', 'Interaction follow-up completed.')
      await expect.poll(async () => (await session(page)).status).toBe('idle')
      expect((await session(page)).messages.filter(({ role }) => role === 'user')).toHaveLength(2)
    } finally {
      await writeFile(join(directory, 'release-terminal'), '')
      await evidence(app, page, testInfo, 'one-stop-final', phases)
    }
  })
}

test('one Stop during the real admission write prevents provider dispatch after the gate releases', async ({
  app
}, testInfo) => {
  const page = await setup(app, 'Stop before provider dispatch')
  await sendPrompt(page, 'Verify interaction follow-up.', 'Interaction follow-up completed.')
  await expect.poll(async () => (await session(page)).status).toBe('idle')
  const before = await session(page)
  const prompt = 'This prompt must never reach the provider after Stop.'
  const gate = await holdStopAdmission(app, {
    projectId: before.projectId,
    sessionId: before.id,
    prompt
  })
  const phases: Record<string, number> = { submittedAt: Date.now() }
  try {
    await submit(app, page, prompt)
    await expect.poll(gate.captured).toMatchObject({ promptMessageId: expect.any(String) })
    const captured = (await gate.captured())!
    phases.admissionGateReachedAt = captured.at
    expect(
      (await app.readFakeAgentPrompts()).some(({ prompt: sent }) => sent.includes(prompt))
    ).toBe(false)
    phases.stopClickedAt = Date.now()
    await assertStopWindowIsolation(app)
    await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
    await expect(page.getByRole('button', { name: STOPPING, exact: true })).toBeDisabled()
    // Main hydration shares the admission writer's queue. Read no Session projection while
    // holding that queue; capture the real pending UI and exact gate identity before release.
    const pendingScreenshot = testInfo.outputPath('admission-stop-pending.png')
    await page.screenshot({ path: pendingScreenshot, animations: 'disabled' })
    await testInfo.attach('admission-stop-pending-screenshot', {
      path: pendingScreenshot,
      contentType: 'image/png'
    })
    await testInfo.attach('admission-stop-pending', {
      body: JSON.stringify({ phases, captured }),
      contentType: 'application/json'
    })
    phases.admissionGateReleasedAt = Date.now()
    await gate.release()
    await expect.poll(async () => Boolean((await session(page)).activeRun)).toBe(false)
    phases.durableSettledAt = Date.now()
    phases.releaseToDurableSettledMs = phases.durableSettledAt - phases.admissionGateReleasedAt
    await expect(page.getByRole('button', { name: STOPPING, exact: true })).toHaveCount(0)
    phases.stopSettledAt = Date.now()
    phases.releaseToUiSettledMs = phases.stopSettledAt - phases.admissionGateReleasedAt
    const stopped = await session(page)
    expect(
      stopped.runtimeSessionAdmissions?.some(
        ({ promptMessageId }) => promptMessageId === captured.promptMessageId
      )
    ).toBe(true)
    expect(
      (stopped.conversationGraph?.messages ?? stopped.messages).find(
        ({ id }) => id === captured.promptMessageId
      )?.turnOutcome?.kind
    ).toBe('cancelled')
    expect(stopped.resumeRecovery?.promptMessageId).toBe(captured.promptMessageId)
    expect(stopped.promptPreparation).toBeUndefined()
    expect(
      (await app.readFakeAgentPrompts()).some(({ prompt: sent }) => sent.includes(prompt))
    ).toBe(false)
    await assertStopWindowIsolation(app)
    await sendPrompt(
      page,
      'Summarize the deterministic fixture.',
      'Deterministic reply: Summarize the deterministic fixture.'
    )
    await expect.poll(async () => (await session(page)).status).toBe('idle')
    expect(
      (await app.readFakeAgentPrompts()).some(({ prompt: sent }) => sent.includes(prompt))
    ).toBe(false)
  } finally {
    await gate.release()
    await evidence(app, page, testInfo, 'admission-stop-final', phases)
  }
})
