import { expect, type Page, type TestInfo } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { isTurnAnchor, latestTurnAnchor } from '../src/shared/session-persistence/turn-anchor'
import { test, type ElectronApp } from './fixtures/electron-app'

const DISMISS_PROMPT = 'Create the live dismissal regression Plan.'
const RECOVERY_PROMPT = 'Create the feedback Stop Resume regression Plan.'
const FEEDBACK = 'Revise this Plan for the feedback Stop Resume regression.'
const DISMISS_ACK = 'Plan dismissal acknowledged; the rejected Plan was not executed.'
const RUNNING =
  'Plan recovery: the checkpoint is complete and execution is running; ready for Stop.'
const COMPLETED = 'Plan recovery: continued the pending execution without repeating the checkpoint.'

async function snapshot(page: Page): Promise<PersistedChatSession> {
  return page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create project' }).click()
}

async function generatePlan(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('button', { name: 'Approve', exact: true }).first()).toBeVisible()
  await expect.poll(async () => Boolean((await snapshot(page)).activeRun)).toBe(true)
  expect((await snapshot(page)).runtimeContext?.plan?.approval).toBe('pending')
}

async function attachDiagnostics(
  app: ElectronApp,
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify({
      session: await snapshot(page),
      prompts: await app.readFakeAgentPrompts()
    }),
    contentType: 'application/json'
  })
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: 'disabled' })
}

test('live Dismiss persists rejection acknowledgement and completes without a recovery or execution', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Live Plan dismissal regression')
  try {
    await generatePlan(page, DISMISS_PROMPT)
    await page.getByRole('button', { name: 'Open', exact: true }).first().click()
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(page.getByText(DISMISS_ACK, { exact: false })).toBeVisible()
    await expect
      .poll(async () => {
        const session = await snapshot(page)
        return {
          status: session.status,
          active: Boolean(session.activeRun),
          recovery: session.resumeRecovery,
          approval: session.runtimeContext?.plan?.approval,
          outcome: session.messages.find(
            ({ role, content }) => role === 'user' && content === DISMISS_PROMPT
          )?.turnOutcome?.kind,
          acknowledgements: session.messages.filter(
            ({ role, content }) => role === 'agent' && content.includes(DISMISS_ACK)
          ).length
        }
      })
      .toEqual({
        status: 'idle',
        active: false,
        recovery: undefined,
        approval: 'rejected',
        outcome: 'completed',
        acknowledgements: 1
      })
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
    await expect(page.getByText('This turn was interrupted. Resume to continue.')).toHaveCount(0)
    const dismissed = await snapshot(page)
    expect(dismissed.activities?.some(({ id }) => id === 'e2e-plan-recovery-checkpoint')).toBe(
      false
    )
    expect(dismissed.messages.filter(({ role }) => role === 'user')).toHaveLength(1)
    const prompts = await app.readFakeAgentPrompts()
    expect(
      prompts.filter(({ prompt }) => prompt.includes('The user rejected the pending Session Plan.'))
    ).toHaveLength(0)
    expect(
      prompts.some(({ prompt }) => prompt.includes('The user approved the pending Session Plan.'))
    ).toBe(false)
  } finally {
    await attachDiagnostics(app, page, testInfo, 'live-dismissal')
  }
})

test('session Resume continues an approved feedback execution despite the original timeline anchor', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Plan feedback Stop Resume regression')
  try {
    await generatePlan(page, RECOVERY_PROMPT)
    const original = (await snapshot(page)).messages.find(
      ({ role, content }) => role === 'user' && content === RECOVERY_PROMPT
    )!
    // Stop the initial healthy MCP waiter through the real Main API, as the existing
    // interaction-restart journey does. The Plan remains pending for an independent reply.
    await page.evaluate(async () => {
      const session = (await window.api.sessions.loadAll()).sessions[0]
      await window.api.acp.cancel({ sessionId: session.id })
    })
    await expect.poll(async () => Boolean((await snapshot(page)).activeRun)).toBe(false)
    await page.getByRole('textbox', { name: 'Respond to Plan' }).fill(FEEDBACK)
    await page.getByRole('button', { name: 'Send Plan feedback' }).click()
    await expect(
      page.getByText('Revised feedback recovery Plan', { exact: true }).first()
    ).toBeVisible()
    await expect.poll(async () => Boolean((await snapshot(page)).activeRun)).toBe(true)
    const reviewed = await snapshot(page)
    const feedback = reviewed.messages.find(
      ({ role, content }) => role === 'user' && content === FEEDBACK
    )!
    expect(feedback.responseToMessageId).toBe(original.id)
    expect(isTurnAnchor(feedback)).toBe(false)
    expect(latestTurnAnchor(reviewed.messages)?.id).toBe(original.id)
    expect(
      reviewed.runtimeSessionAdmissions?.some(
        ({ promptMessageId }) => promptMessageId === feedback.id
      )
    ).toBe(true)

    await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
    await expect(page.getByText(RUNNING, { exact: false })).toBeVisible()
    await expect
      .poll(async () => (await snapshot(page)).activeRun?.promptMessageId)
      .toBe(feedback.id)
    await expect
      .poll(
        async () =>
          (await snapshot(page)).activities?.find(({ id }) => id === 'e2e-plan-recovery-checkpoint')
            ?.status
      )
      .toBe('completed')
    await expect
      .poll(
        async () =>
          (await snapshot(page)).activities?.find(({ id }) => id === 'e2e-plan-recovery-pending')
            ?.status
      )
      .toBe('in_progress')
    const running = await snapshot(page)
    const execution = running.runtimeSessionAdmissions?.at(-1)
    expect(execution?.promptMessageId).toBe(feedback.id)
    expect(
      running.activities?.find(({ id }) => id === 'e2e-plan-recovery-checkpoint')?.status
    ).toBe('completed')
    expect(running.activities?.find(({ id }) => id === 'e2e-plan-recovery-pending')?.status).toBe(
      'in_progress'
    )

    await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
    await expect
      .poll(async () => (await snapshot(page)).resumeRecovery)
      .toMatchObject({
        kind: 'resume-required',
        cause: 'cancelled',
        promptMessageId: feedback.id
      })
    const interrupted = await snapshot(page)
    expect(latestTurnAnchor(interrupted.messages)?.id).toBe(original.id)
    expect(interrupted.resumeRecovery?.promptMessageId).not.toBe(original.id)
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeEnabled()
    await attachDiagnostics(app, page, testInfo, 'feedback-execution-interrupted')

    await page.getByRole('button', { name: 'Resume session', exact: true }).click()
    await expect(page.getByText(COMPLETED, { exact: false })).toBeVisible()
    await expect.poll(async () => (await snapshot(page)).status).toBe('idle')
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
    const resumed = await snapshot(page)
    expect(resumed.resumeRecovery).toBeUndefined()
    expect(resumed.runtimeContext?.plan?.approval).toBe('approved')
    expect(resumed.messages.filter(({ role }) => role === 'user').map(({ id }) => id)).toEqual([
      original.id,
      feedback.id
    ])
    expect(resumed.messages.find(({ id }) => id === feedback.id)?.turnOutcome?.kind).toBe(
      'completed'
    )
    expect(
      resumed.activities?.filter(({ id }) => id === 'e2e-plan-recovery-checkpoint')
    ).toHaveLength(1)
    expect(
      resumed.activities?.find(({ id }) => id === 'e2e-plan-recovery-checkpoint')?.status
    ).toBe('completed')
    expect(resumed.activities?.filter(({ id }) => id === 'e2e-plan-recovery-pending')).toHaveLength(
      1
    )
    expect(resumed.activities?.find(({ id }) => id === 'e2e-plan-recovery-pending')?.status).toBe(
      'failed'
    )
    expect(resumed.activities?.find(({ id }) => id === 'e2e-plan-recovery-continued')?.status).toBe(
      'completed'
    )
    expect(resumed.runtimeSessionAdmissions?.at(-1)).toMatchObject({
      promptMessageId: feedback.id,
      promptRuntimeSegmentId: execution!.promptRuntimeSegmentId,
      rootFrameId: execution!.rootFrameId,
      agentFrameId: execution!.agentFrameId,
      messageBranchId: execution!.messageBranchId
    })
    const prompts = await app.readFakeAgentPrompts()
    expect(
      prompts.filter(({ prompt }) =>
        prompt.includes('Continue the interrupted turn from where it stopped.')
      )
    ).toHaveLength(1)
    expect(
      prompts.filter(
        ({ prompt }) =>
          prompt.includes('The user approved the pending Session Plan.') &&
          !prompt.includes('Continue the interrupted turn from where it stopped.')
      )
    ).toHaveLength(0)
  } finally {
    await attachDiagnostics(app, page, testInfo, 'feedback-execution-resumed')
  }
})
