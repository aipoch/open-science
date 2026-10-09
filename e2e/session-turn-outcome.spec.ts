import { expect, type Page, type TestInfo } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'
import {
  installSessionOutcomeFault,
  holdOutcomeAdmission,
  readOutcomeArtifactRun,
  readRawOutcomeSession,
  releaseOutcomeArtifact
} from './fixtures/session-outcome-fault'

// Exercises real Main/renderer surfaces; no seeded outcomes or renderer API substitutes.
test.use({ windowMode: 'normal' })
const FAILURE_PROMPT = 'Fail the turn outcome fixture.'
const HOLD_PROMPT = 'Hold the turn outcome fixture.'
const ARTIFACT_PROMPT = 'Create the turn outcome retry artifact.'
const FAILURE = 'Synthetic turn outcome failure.'
const SAVE_WARNING =
  'Open-Science could not save the latest conversation changes. Retry before closing the app.'

const submit = async (page: Page, prompt: string): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

const sessionForPrompt = async (page: Page, prompt: string): Promise<PersistedChatSession> => {
  let session: PersistedChatSession | undefined
  await expect
    .poll(async () => {
      session = await page.evaluate(
        async (content) =>
          (await window.api.sessions.loadAll()).sessions.find((candidate) =>
            candidate.messages.some(
              (message) => message.role === 'user' && message.content === content
            )
          ),
        prompt
      )
      return session !== undefined
    })
    .toBe(true)
  return session!
}

const outcomeFor = (session: PersistedChatSession, prompt: string): unknown =>
  (session.conversationGraph?.messages ?? session.messages).find(
    (message) => message.role === 'user' && message.content === prompt
  )?.turnOutcome

const evidence = async (
  page: Page,
  testInfo: TestInfo,
  name: string,
  session: PersistedChatSession
): Promise<void> => {
  const screenshot = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })
  await testInfo.attach(`${name}-session`, {
    body: JSON.stringify(session, null, 2),
    contentType: 'application/json'
  })
}

const assertNoAttention = async (page: Page, sessionId: string): Promise<void> => {
  const row = page
    .getByRole('navigation', { name: 'Sessions' })
    .locator(`[data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible()
  await expect(row.getByText('Session status: Error', { exact: true })).toHaveCount(0)
}

test('keeps the failed turn and Operation Error while a later turn succeeds', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.setMainWindowSize(1200, 900)
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const projectId = await createProject(page, 'Turn outcome failure history')
  await submit(page, FAILURE_PROMPT)
  await expect(page.getByText(FAILURE, { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Report this error', exact: true })).toBeVisible()
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, FAILURE_PROMPT), FAILURE_PROMPT))
    .toMatchObject({ kind: 'failed', errorReportable: true })
  const failed = await sessionForPrompt(page, FAILURE_PROMPT)
  const identity = { projectId, sessionId: failed.id }
  const original = await readRawOutcomeSession(app, identity)
  const capturedBefore = await app.readFakeAgentPrompts()
  const rejectedPrompt = 'This turn must be rejected before admission.'
  const fault = await installSessionOutcomeFault(app, {
    ...identity,
    kind: 'submission',
    prompt: rejectedPrompt
  })
  try {
    await submit(page, rejectedPrompt)
    await expect.poll(fault.hits).toBeGreaterThan(0)
    await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveText(rejectedPrompt)
    await expect(
      page.getByText('Synthetic submission write failure.', { exact: false }).first()
    ).toBeVisible()
    await expect(page.getByText(FAILURE, { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Report this error', exact: true })).toBeVisible()
    const rolledBack = await readRawOutcomeSession(app, identity)
    expect(rolledBack.conversationGraph?.messages).toEqual(original.conversationGraph?.messages)
    expect(rolledBack.runtimeSessionAdmissions).toEqual(original.runtimeSessionAdmissions)
    expect(await app.readFakeAgentPrompts()).toEqual(capturedBefore)
    await evidence(page, testInfo, 'turn-failure-with-operation-error', rolledBack)
  } finally {
    await fault.restore()
  }
  const successPrompt = 'Summarize the deterministic fixture.'
  const admission = await holdOutcomeAdmission(app, successPrompt)
  try {
    await submit(page, successPrompt)
    await expect.poll(admission.captured).toMatchObject({ sessionId: failed.id })
    const prepared = await sessionForPrompt(page, successPrompt)
    expect(prepared.promptPreparation).toMatchObject({
      promptMessageId: expect.any(String),
      mode: 'new'
    })
    const currentNotice = page.locator(
      `[data-slot="turn-outcome-notice"][data-prompt-message-id="${failed.messages.find((message) => message.role === 'user')!.id}"]`
    )
    await expect(currentNotice).toBeVisible()
    await expect(currentNotice).toContainText(FAILURE)
    await expect(
      page.locator(
        `[data-slot="historical-turn-outcome"][data-prompt-message-id="${failed.messages.find((message) => message.role === 'user')!.id}"]`
      )
    ).toHaveCount(0)
    await evidence(page, testInfo, 'prepared-turn-keeps-current-failure', prepared)
  } finally {
    await admission.restore()
  }
  await expect(
    page.getByText(`Deterministic reply: ${successPrompt}`, { exact: false })
  ).toBeVisible()
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, FAILURE_PROMPT), successPrompt))
    .toMatchObject({ kind: 'completed' })
  const completed = await sessionForPrompt(page, FAILURE_PROMPT)
  expect(outcomeFor(completed, FAILURE_PROMPT)).toEqual(outcomeFor(original, FAILURE_PROMPT))
  expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  const historical = page.locator(
    `[data-slot="historical-turn-outcome"][data-prompt-message-id="${failed.messages.find((message) => message.role === 'user')!.id}"]`
  )
  await expect(historical).toBeVisible()
  await expect(page.getByText(FAILURE, { exact: false })).toBeHidden()
  await evidence(page, testInfo, 'later-success-historical-collapsed', completed)
  await historical.locator('summary').click()
  await expect(page.getByText(FAILURE, { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Report this error', exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  const laterPromptId = completed.messages.find(
    (message) => message.role === 'user' && message.content === successPrompt
  )!.id
  // An old composer-level run error would follow the newer prompt. Historical notices must stay
  // before that next turn even when both are mounted in the same transcript.
  expect(
    await page.getByText(FAILURE, { exact: false }).evaluate((notice, id) => {
      const nextTurn = document.querySelector(`[data-message-id="${id}"]`)
      return Boolean(
        nextTurn && notice.compareDocumentPosition(nextTurn) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    }, laterPromptId)
  ).toBe(true)
  await assertNoAttention(page, completed.id)
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  await viewport.hover()
  await page.mouse.wheel(0, -1200)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(
    page
      .getByRole('region', { name: 'Conversation', exact: true })
      .getByText(FAILURE_PROMPT, { exact: true })
  ).toBeInViewport()
  await evidence(page, testInfo, 'later-success-preserves-failed-turn', completed)
})

test('exports and forks a failed idle turn through the real Session actions', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.configureSessionPackageDialogs()
  await app.setMainWindowSize(1200, 900)
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  await createProject(page, 'Failed turn actions')
  await submit(page, FAILURE_PROMPT)
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, FAILURE_PROMPT), FAILURE_PROMPT))
    .toMatchObject({ kind: 'failed' })
  const source = await sessionForPrompt(page, FAILURE_PROMPT)
  const actions = page
    .locator(`[data-session-id="${source.id}"]`)
    .getByRole('button', { name: /^Open actions for / })
  await actions.click()
  await expect(page.getByRole('menuitem', { name: 'Fork', exact: true })).toBeEnabled()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Export Session package', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Session package', exact: true })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog.getByText('Package operation completed', { exact: true })).toBeVisible()
  await evidence(page, testInfo, 'failed-turn-export-completed', source)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await actions.click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  await expect
    .poll(async () =>
      page.evaluate(
        async (sourceId) =>
          (await window.api.sessions.loadAll()).sessions.filter(({ id }) => id !== sourceId).length,
        source.id
      )
    )
    .toBe(1)
  const fork = await page.evaluate(
    async (sourceId) =>
      (await window.api.sessions.loadAll()).sessions.find(({ id }) => id !== sourceId)!,
    source.id
  )
  expect(fork.forkOrigin).toBeDefined()
  expect(
    fork.messages.some(({ role, content }) => role === 'user' && content === FAILURE_PROMPT)
  ).toBe(true)
  expect(
    outcomeFor(
      await readRawOutcomeSession(app, { projectId: source.projectId, sessionId: source.id }),
      FAILURE_PROMPT
    )
  ).toEqual(outcomeFor(source, FAILURE_PROMPT))
  await expect(page.locator(`[data-session-id="${fork.id}"] [aria-current="page"]`)).toBeVisible()
  await evidence(page, testInfo, 'failed-turn-fork-created', fork)
})

for (const earlyOutcome of ['completed', 'failed'] as const)
  test(`editing an early ${earlyOutcome} turn keeps the original Branch latest failure until admission`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await app.setMainWindowSize(1200, 900)
    await page.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    const projectId = await createProject(page, `Early ${earlyOutcome} edit`)
    const earlyPrompt =
      earlyOutcome === 'completed'
        ? 'Early completed prompt.'
        : `${FAILURE_PROMPT} Early failed prompt.`
    await submit(page, earlyPrompt)
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, earlyPrompt), earlyPrompt))
      .toMatchObject({ kind: earlyOutcome })
    await submit(page, FAILURE_PROMPT)
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, FAILURE_PROMPT), FAILURE_PROMPT))
      .toMatchObject({ kind: 'failed' })
    const original = await sessionForPrompt(page, FAILURE_PROMPT)
    const latestId = original.messages.find(({ content }) => content === FAILURE_PROMPT)!.id
    const identity = { projectId, sessionId: original.id }
    const conversation = page.getByRole('region', { name: 'Conversation' })
    const edit = async (content: string): Promise<void> => {
      await conversation.getByText(earlyPrompt, { exact: true }).hover()
      await conversation.getByRole('button', { name: 'Edit message' }).first().click()
      await conversation.getByRole('textbox', { name: 'Edit message' }).fill(content)
      await conversation.getByRole('button', { name: 'Send', exact: true }).click()
    }
    const editedPrompt = `Admitted ${earlyOutcome} early edit.`
    const gate = await holdOutcomeAdmission(app, editedPrompt)
    try {
      await edit(editedPrompt)
      await expect.poll(gate.captured).toMatchObject({ sessionId: original.id })
      const prepared = await sessionForPrompt(page, editedPrompt)
      expect(prepared.promptPreparation?.mode).toBe('new')
      await expect(
        page.locator(`[data-slot="turn-outcome-notice"][data-prompt-message-id="${latestId}"]`)
      ).toBeVisible()
      await evidence(page, testInfo, `early-${earlyOutcome}-edit-keeps-latest-failure`, prepared)
    } finally {
      await gate.restore()
    }
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, editedPrompt), editedPrompt))
      .toMatchObject({ kind: 'completed' })
    await expect(page.locator('[data-slot="turn-outcome-notice"]')).toHaveCount(0)
    expect(outcomeFor(await readRawOutcomeSession(app, identity), FAILURE_PROMPT)).toMatchObject({
      kind: 'failed'
    })
  })

for (const latestKind of ['cancelled', 'interrupted', 'legacy-failed'] as const)
  test(`editing an earlier prompt retains the latest ${latestKind} notice and recovery until admission`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await app.setMainWindowSize(1200, 900)
    await page.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    await createProject(page, `Edit with latest ${latestKind}`)
    const early = 'Earlier completed prompt for recovery edit.'
    await submit(page, early)
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, early), early))
      .toMatchObject({ kind: 'completed' })
    const latest =
      latestKind === 'cancelled'
        ? HOLD_PROMPT
        : latestKind === 'interrupted'
          ? 'Stream the long scroll journey.'
          : FAILURE_PROMPT
    await submit(page, latest)
    if (latestKind === 'cancelled') {
      await expect(
        page.getByText('Turn outcome cancellation checkpoint.', { exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
      await expect
        .poll(async () => outcomeFor(await sessionForPrompt(page, latest), latest))
        .toMatchObject({ kind: 'cancelled' })
    } else if (latestKind === 'interrupted') {
      await expect(page.getByText('Segment 1 paragraph 0.', { exact: false })).toBeVisible()
      const snapshot = await sessionForPrompt(page, latest)
      expect(snapshot.status).toBe('running')
      await expect.poll(async () => (await sessionForPrompt(page, latest)).status).toBe('idle')
      page = await app.restartWithSessionFixture(snapshot)
      await page
        .getByRole('region', { name: 'Recent sessions' })
        .getByRole('button', { name: snapshot.title })
        .click()
    } else {
      await expect
        .poll(async () => outcomeFor(await sessionForPrompt(page, latest), latest))
        .toMatchObject({ kind: 'failed' })
      const legacy = await sessionForPrompt(page, latest)
      // A compatibility copy of an actual failed Main snapshot: omit only its explicit outcome,
      // as an older saved file would. No new outcome or renderer store is fabricated.
      for (const message of [...legacy.messages, ...(legacy.conversationGraph?.messages ?? [])])
        if (message.role === 'user' && message.content === latest) delete message.turnOutcome
      page = await app.restartWithSessionFixture(legacy)
      await page
        .getByRole('region', { name: 'Recent sessions' })
        .getByRole('button', { name: legacy.title })
        .click()
    }
    const before = await sessionForPrompt(page, latest)
    const latestId = before.messages.find(({ content }) => content === latest)!.id
    const editedPrompt = `Prepared early edit with latest ${latestKind}.`
    const gate = await holdOutcomeAdmission(app, editedPrompt)
    try {
      const conversation = page.getByRole('region', { name: 'Conversation' })
      await conversation.getByText(early, { exact: true }).hover()
      await conversation.getByRole('button', { name: 'Edit message' }).first().click()
      await conversation.getByRole('textbox', { name: 'Edit message' }).fill(editedPrompt)
      await conversation.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(gate.captured).toMatchObject({ sessionId: before.id })
      const preparing = await sessionForPrompt(page, editedPrompt)
      expect(
        preparing.promptPreparation?.previousState.resumeRecovery?.promptMessageId
      ).toBeUndefined()
      expect(preparing.promptPreparation?.noticeBaseline?.promptMessageId).toBe(latestId)
      if (latestKind === 'legacy-failed') {
        await expect(
          page.locator(`[data-slot="turn-outcome-notice"][data-prompt-message-id="${latestId}"]`)
        ).toBeVisible()
        await expect(page.getByText(FAILURE, { exact: false })).toBeVisible()
        await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
      } else {
        await expect(page.locator('[data-slot="turn-outcome-notice"]')).toHaveCount(0)
        await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(1)
        await expect(page.locator('[data-slot="session-recovery-notice"]')).toBeVisible()
        await expect(
          page.getByRole('button', { name: 'Resume session', exact: true })
        ).toBeVisible()
        await expect(
          page.getByRole('button', { name: 'Resume session', exact: true })
        ).toBeDisabled()
      }
      await evidence(page, testInfo, `latest-${latestKind}-early-edit-preparation`, preparing)
    } finally {
      await gate.restore()
    }
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, editedPrompt), editedPrompt))
      .toMatchObject({ kind: 'completed' })
    await expect(page.locator('[data-slot="turn-outcome-notice"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  })

test('edited prompt save rejection restores the original Branch and permits fresh editing and sending', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.setMainWindowSize(1200, 900)
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const projectId = await createProject(page, 'Edited prompt save rejection rollback')
  const early = 'Earlier completed prompt for rejected edit.'
  await submit(page, early)
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, early), early))
    .toMatchObject({ kind: 'completed' })
  await submit(page, FAILURE_PROMPT)
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, FAILURE_PROMPT), FAILURE_PROMPT))
    .toMatchObject({ kind: 'failed' })
  const before = await sessionForPrompt(page, FAILURE_PROMPT)
  const identity = { projectId, sessionId: before.id }
  const providerBefore = await app.readFakeAgentPrompts()
  const draft = 'Unsent composer draft retained across editing.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(draft)
  const rejected = 'Rejected completed early edit.'
  const conversation = page.getByRole('region', { name: 'Conversation' })
  const edit = async (content: string): Promise<void> => {
    await conversation.getByText(early, { exact: true }).hover()
    await conversation.getByRole('button', { name: 'Edit message' }).first().click()
    await conversation.getByRole('textbox', { name: 'Edit message' }).fill(content)
    await conversation.getByRole('button', { name: 'Send', exact: true }).click()
  }
  const fault = await installSessionOutcomeFault(app, {
    ...identity,
    kind: 'submission',
    prompt: rejected
  })
  try {
    await edit(rejected)
    await expect.poll(fault.hits).toBeGreaterThan(0)
    await expect(
      page.getByText('Synthetic submission write failure.', { exact: false }).first()
    ).toBeVisible()
    await expect
      .poll(async () => (await readRawOutcomeSession(app, identity)).promptPreparation)
      .toBeUndefined()
    const restored = await readRawOutcomeSession(app, identity)
    expect(restored.status).toBe(before.status)
    expect(restored.activeRun).toBeUndefined()
    expect(restored.conversationGraph?.messages).toEqual(before.conversationGraph?.messages)
    expect(restored.conversationGraph?.frames[0].activeBranchId).toBe(
      before.conversationGraph?.frames[0].activeBranchId
    )
    expect(restored.runtimeSessionAdmissions).toEqual(before.runtimeSessionAdmissions)
    await expect(conversation.getByText(early, { exact: true })).toBeVisible()
    await expect(conversation.getByText(FAILURE_PROMPT, { exact: true })).toBeVisible()
    await expect(conversation.getByText(rejected, { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveText(draft)
    expect(await app.readFakeAgentPrompts()).toEqual(providerBefore)
    await evidence(page, testInfo, 'edited-save-rejection-restored-original-branch', restored)
  } finally {
    await fault.restore()
  }
  const retriedEdit = 'Retry the early edit after save rejection.'
  await edit(retriedEdit)
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, retriedEdit), retriedEdit))
    .toMatchObject({ kind: 'completed' })
  const followup = 'Send after rejected edit recovery.'
  await submit(page, followup)
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, followup), followup))
    .toMatchObject({ kind: 'completed' })
  expect((await app.readFakeAgentPrompts()).some(({ prompt }) => prompt.includes(rejected))).toBe(
    false
  )
})

test('cancelled Resume completes the original turn without an Attention dot', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.setMainWindowSize(1200, 900)
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const projectId = await createProject(page, 'Turn outcome cancellation')
  await submit(page, HOLD_PROMPT)
  await expect(
    page.getByText('Turn outcome cancellation checkpoint.', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, HOLD_PROMPT), HOLD_PROMPT))
    .toMatchObject({ kind: 'cancelled', recovery: 'resume' })
  const cancelled = await sessionForPrompt(page, HOLD_PROMPT)
  const promptId = cancelled.messages.find((message) => message.role === 'user')!.id
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Report this error', exact: true })).toHaveCount(0)
  await assertNoAttention(page, cancelled.id)
  await evidence(page, testInfo, 'cancelled-turn-resume', cancelled)
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await expect(page.getByText('Turn outcome resumed successfully.', { exact: true })).toBeVisible()
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, HOLD_PROMPT), HOLD_PROMPT))
    .toMatchObject({ kind: 'completed' })
  const completed = await sessionForPrompt(page, HOLD_PROMPT)
  expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  expect(completed.messages.find((message) => message.role === 'user')?.id).toBe(promptId)
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  await assertNoAttention(page, completed.id)
  await evidence(page, testInfo, 'cancelled-turn-resumed-completed', completed)

  const historicalCancellationPrompt = `${HOLD_PROMPT} Historical cancellation.`
  await submit(page, historicalCancellationPrompt)
  await expect(
    page.getByText('Turn outcome cancellation checkpoint.', { exact: true }).last()
  ).toBeVisible()
  const secondRunning = await sessionForPrompt(page, historicalCancellationPrompt)
  const historicalPromptId = secondRunning.messages.find(
    (message) => message.role === 'user' && message.content === historicalCancellationPrompt
  )!.id
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect
    .poll(async () =>
      outcomeFor(
        await sessionForPrompt(page, historicalCancellationPrompt),
        historicalCancellationPrompt
      )
    )
    .toMatchObject({ kind: 'cancelled', recovery: 'resume' })
  const nextPrompt = 'Continue after historical cancellation.'
  const identity = { projectId, sessionId: cancelled.id }
  const rejectedPrompt = 'Rejected new prompt after cancellation.'
  const fault = await installSessionOutcomeFault(app, {
    ...identity,
    kind: 'submission',
    prompt: rejectedPrompt
  })
  try {
    await submit(page, rejectedPrompt)
    await expect.poll(fault.hits).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeEnabled()
    await expect(
      page.getByText('Synthetic submission write failure.', { exact: false }).first()
    ).toBeVisible()
  } finally {
    await fault.restore()
  }
  const gate = await holdOutcomeAdmission(app, nextPrompt)
  try {
    await submit(page, nextPrompt)
    await expect.poll(gate.captured).toMatchObject({ sessionId: cancelled.id })
    const preparing = await sessionForPrompt(page, nextPrompt)
    expect(preparing.resumeRecovery).toBeUndefined()
    expect(preparing.promptPreparation?.previousState.resumeRecovery?.promptMessageId).toBe(
      historicalPromptId
    )
    await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="session-recovery-notice"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeDisabled()
    await evidence(page, testInfo, 'cancelled-new-prompt-keeps-disabled-resume', preparing)
  } finally {
    await gate.restore()
  }
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, nextPrompt), nextPrompt))
    .toMatchObject({ kind: 'completed' })
  const afterAdmission = await sessionForPrompt(page, nextPrompt)
  expect(outcomeFor(afterAdmission, historicalCancellationPrompt)).toMatchObject({
    kind: 'cancelled'
  })
  await expect(
    page.locator(
      `[data-slot="historical-turn-outcome"][data-prompt-message-id="${historicalPromptId}"]`
    )
  ).toHaveCount(0)
  await expect(
    page.getByText('This turn was interrupted. Resume to continue.', { exact: true })
  ).toHaveCount(0)
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  await evidence(page, testInfo, 'historical-cancellation-has-no-marker', afterAdmission)
})

test('interrupted recovery keeps exact Resume during a new prompt preparation', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Interrupted new prompt preparation')
  const prompt = 'Stream the long scroll journey.'
  await submit(page, prompt)
  await expect(page.getByText('Segment 1 paragraph 0.', { exact: false })).toBeVisible()
  const snapshot = await sessionForPrompt(page, prompt)
  expect(snapshot.status).toBe('running')
  await expect.poll(async () => (await sessionForPrompt(page, prompt)).status).toBe('idle')
  page = await app.restartWithSessionFixture(snapshot)
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: prompt })
    .click()
  const restored = await sessionForPrompt(page, prompt)
  const recoveryId = restored.resumeRecovery!.promptMessageId
  expect(outcomeFor(restored, prompt)).toMatchObject({ kind: 'interrupted' })
  const followup = 'New prompt after app restart interruption.'
  const gate = await holdOutcomeAdmission(app, followup)
  try {
    await submit(page, followup)
    await expect.poll(gate.captured).toMatchObject({ sessionId: restored.id })
    const preparing = await sessionForPrompt(page, followup)
    expect(preparing.resumeRecovery).toBeUndefined()
    expect(preparing.promptPreparation?.previousState.resumeRecovery?.promptMessageId).toBe(
      recoveryId
    )
    await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="session-recovery-notice"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeDisabled()
    await evidence(page, testInfo, 'interrupted-new-prompt-keeps-disabled-resume', preparing)
  } finally {
    await gate.restore()
  }
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, followup), followup))
    .toMatchObject({ kind: 'completed' })
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  await expect(page.locator('[data-slot="historical-turn-outcome"]')).toHaveCount(0)
  expect(outcomeFor(await sessionForPrompt(page, followup), prompt)).toMatchObject({
    kind: 'interrupted'
  })
  await expect(
    page.getByText('This turn was interrupted. Resume to continue.', { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText('Session was interrupted before the app closed.', { exact: true })
  ).toHaveCount(0)
  await evidence(
    page,
    testInfo,
    'historical-interruption-has-no-marker',
    await sessionForPrompt(page, followup)
  )
})

for (const recovery of ['global Retry', 'Fork'] as const)
  test(`terminal write exhaustion shows only global storage attention and ${recovery} settles it`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await app.setMainWindowSize(1200, 900)
    await page.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    const projectId = await createProject(page, 'Turn outcome terminal persistence')
    await submit(page, HOLD_PROMPT)
    await expect(
      page.getByText('Turn outcome cancellation checkpoint.', { exact: true })
    ).toBeVisible()
    const running = await sessionForPrompt(page, HOLD_PROMPT)
    const activeRun = running.activeRun!
    const admission = running.runtimeSessionAdmissions!.findLast(
      (item) => item.promptMessageId === activeRun.promptMessageId
    )!
    const identity = { projectId, sessionId: running.id }
    const fault = await installSessionOutcomeFault(app, {
      ...identity,
      kind: 'terminal',
      promptMessageId: activeRun.promptMessageId,
      executionId: admission.executionId,
      startedAt: activeRun.startedAt
    })
    try {
      await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
      await expect(page.getByText(SAVE_WARNING, { exact: true })).toBeVisible()
      // Terminal retries are bounded by both attempts and wall time. A slow physical
      // write can consume the retry budget before the third attempt; exhaustion is
      // established by the authoritative failure registry below.
      await expect.poll(fault.hits).toBeGreaterThan(0)
      await expect
        .poll(() => page.evaluate(() => window.api.sessions.listRuntimeTerminalFailures()))
        .toEqual([
          expect.objectContaining({
            promptMessageId: activeRun.promptMessageId,
            promptExecutionId: admission.executionId,
            interruptionCause: 'terminal-commit-failed'
          })
        ])
      const live = await sessionForPrompt(page, HOLD_PROMPT)
      expect(outcomeFor(live, HOLD_PROMPT)).toMatchObject({
        kind: 'interrupted',
        cause: 'terminal-commit-failed'
      })
      expect(live.activeRun).toBeUndefined()
      const raw = await readRawOutcomeSession(app, identity)
      expect(raw.activeRun).toEqual(activeRun)
      expect(outcomeFor(raw, HOLD_PROMPT)).toBeUndefined()
      await expect(
        page.getByRole('button', { name: 'Report this error', exact: true })
      ).toHaveCount(0)
      await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
      await assertNoAttention(page, live.id)
      await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
      const exhaustedHits = await fault.hits()
      await page.getByRole('textbox', { name: 'Ask anything' }).fill('Draft after storage failure')
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
      await evidence(page, testInfo, 'terminal-commit-exhausted-live-overlay', live)
      await page
        .locator(`[data-session-id="${live.id}"]`)
        .getByRole('button', { name: /^Open actions for / })
        .click()
      await expect(page.getByRole('menuitem', { name: 'Fork', exact: true })).toBeEnabled()
      await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
      const operationError = page
        .getByRole('dialog')
        .filter({ hasText: 'Synthetic terminal write failure.' })
      await expect(operationError).toBeVisible()
      await expect.poll(fault.hits).toBeGreaterThan(exhaustedHits)
      expect((await readRawOutcomeSession(app, identity)).activeRun).toEqual(activeRun)
      expect(
        await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions.length)
      ).toBe(1)
      await evidence(page, testInfo, 'terminal-commit-fork-operation-error', live)
      await operationError.getByRole('button', { name: 'Close', exact: true }).click()
    } finally {
      await fault.restore()
    }
    if (recovery === 'global Retry') {
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
    } else {
      await page
        .locator(`[data-session-id="${running.id}"]`)
        .getByRole('button', { name: /^Open actions for / })
        .click()
      await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.api.sessions.loadAll()).sessions.length)
        )
        .toBe(2)
      await page
        .locator(`[data-session-id="${running.id}"]`)
        .locator('[data-slot="session-open-button"]')
        .click()
    }
    await expect(page.getByText(SAVE_WARNING, { exact: true })).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.api.sessions.listRuntimeTerminalFailures()))
      .toEqual([])
    await expect
      .poll(async () => outcomeFor(await readRawOutcomeSession(app, identity), HOLD_PROMPT))
      .toMatchObject({ kind: 'cancelled' })
    const settled = await readRawOutcomeSession(app, identity)
    expect(settled.activeRun).toBeUndefined()
    expect(settled.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    await evidence(
      page,
      testInfo,
      recovery === 'global Retry'
        ? 'terminal-commit-global-retry-settled'
        : 'terminal-commit-fork-retry-settled',
      settled
    )
    const nextPrompt = 'Continue after terminal storage recovery.'
    await sendPrompt(page, nextPrompt, 'Deterministic reply: Summarize the deterministic fixture.')
    await expect
      .poll(async () => outcomeFor(await readRawOutcomeSession(app, identity), nextPrompt))
      .toMatchObject({ kind: 'completed' })
    expect(outcomeFor(await readRawOutcomeSession(app, identity), HOLD_PROMPT)).toMatchObject({
      kind: 'cancelled'
    })
  })

test('Artifact publication Retry completes the same turn and Version exactly once', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.setMainWindowSize(1200, 900)
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const projectId = await createProject(page, 'Turn outcome Artifact Retry')
  await submit(page, ARTIFACT_PROMPT)
  await expect(page.getByText('Turn outcome artifact checkpoint.', { exact: false })).toBeVisible({
    timeout: 120_000
  })
  let running = await sessionForPrompt(page, ARTIFACT_PROMPT)
  await expect
    .poll(async () => {
      running = await sessionForPrompt(page, ARTIFACT_PROMPT)
      return running.messages.some(
        (message) =>
          message.role === 'agent' && message.content.includes('Turn outcome artifact checkpoint.')
      )
    })
    .toBe(true)
  const checkpoint = running.messages.find(
    (message) =>
      message.role === 'agent' && message.content.includes('Turn outcome artifact checkpoint.')
  )!.content
  const expectedVersionId = /, version ([a-zA-Z0-9_-]+)\./u.exec(checkpoint)?.[1]
  expect(expectedVersionId).toEqual(expect.any(String))
  const identity = { projectId, sessionId: running.id }
  const artifactScope = await readOutcomeArtifactRun(app, identity)
  const artifactPromptId = running.activeRun!.promptMessageId
  const historical = page.locator(
    `[data-slot="historical-turn-outcome"][data-prompt-message-id="${artifactPromptId}"]`
  )
  const fault = await installSessionOutcomeFault(app, {
    ...identity,
    kind: 'artifact-publication',
    ...artifactScope
  })
  try {
    await releaseOutcomeArtifact(app, running.id)
    await expect.poll(fault.hits).toBeGreaterThan(0)
    await expect
      .poll(async () => outcomeFor(await readRawOutcomeSession(app, identity), ARTIFACT_PROMPT))
      .toMatchObject({ kind: 'failed', recovery: 'retry-artifact-publication' })
    await testInfo.attach('artifact-failed-authority', {
      body: JSON.stringify(await readRawOutcomeSession(app, identity), null, 2),
      contentType: 'application/json'
    })
    await expect(
      page.getByRole('button', { name: 'Retry Artifact publication', exact: true })
    ).toBeVisible()
    await evidence(
      page,
      testInfo,
      'artifact-publication-failed',
      await sessionForPrompt(page, ARTIFACT_PROMPT)
    )
    const followupPrompt = 'Summarize the deterministic fixture.'
    await sendPrompt(page, followupPrompt, `Deterministic reply: ${followupPrompt}`)
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, ARTIFACT_PROMPT), followupPrompt))
      .toMatchObject({ kind: 'completed' })
    await expect(historical).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Retry Artifact publication', exact: true })
    ).toBeHidden()
    await historical.locator('summary').click()
    await expect(
      page.getByRole('button', { name: 'Retry Artifact publication', exact: true })
    ).toBeVisible()
    await evidence(
      page,
      testInfo,
      'historical-artifact-publication-failed',
      await sessionForPrompt(page, ARTIFACT_PROMPT)
    )
  } finally {
    await fault.restore()
    await releaseOutcomeArtifact(app, running.id)
  }
  const beforeRetryPrompts = await app.readFakeAgentPrompts()
  await page.getByRole('button', { name: 'Retry Artifact publication', exact: true }).click()
  await expect
    .poll(async () => outcomeFor(await sessionForPrompt(page, ARTIFACT_PROMPT), ARTIFACT_PROMPT))
    .toMatchObject({ kind: 'completed' })
  const completed = await readRawOutcomeSession(app, identity)
  expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  expect(completed.artifacts).toHaveLength(1)
  expect(completed.artifacts![0].versionId).toBe(expectedVersionId)
  expect(completed.artifacts![0].sha256).toMatch(/^[a-f0-9]{64}$/u)
  const owners = completed.conversationGraph!.messages.filter((message) =>
    message.artifactIds?.includes(completed.artifacts![0].id)
  )
  expect(owners).toHaveLength(1)
  expect(owners[0].responseToMessageId).toBe(artifactPromptId)
  expect(await app.readFakeAgentPrompts()).toEqual(beforeRetryPrompts)
  await expect(
    page.getByRole('button', { name: 'Retry Artifact publication', exact: true })
  ).toHaveCount(0)
  await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
  await assertNoAttention(page, completed.id)
  await expect(page.locator('[data-slot="assistant-message-footer"] time')).toHaveCount(2)
  expect(
    await page.locator('[data-slot="assistant-message-footer"] time').allTextContents()
  ).toEqual([expect.stringMatching(/^Completed /u), expect.stringMatching(/^Completed /u)])
  await evidence(page, testInfo, 'artifact-publication-retry-completed', completed)
})

test('keeps a prepared message after a real pre-admission crash without inventing an outcome', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await app.setMainWindowSize(1200, 900)
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const projectId = await createProject(page, 'Unadmitted preparation restart')
  const prompt = 'Keep this unadmitted message after restart.'
  const gate = await holdOutcomeAdmission(app, prompt)
  try {
    await submit(page, prompt)
    await expect
      .poll(gate.captured)
      .toMatchObject({ sessionId: expect.any(String), promptMessageId: expect.any(String) })
    const captured = (await gate.captured())!
    // A catalog refresh in the live process must not mistake its own preparation for a crash.
    await page.evaluate(() => window.api.sessions.loadAll())
    const prepared = await readRawOutcomeSession(app, { projectId, sessionId: captured.sessionId })
    await testInfo.attach('prepared-before-crash', {
      body: JSON.stringify(prepared, null, 2),
      contentType: 'application/json'
    })
    expect(prepared.activeRun?.promptMessageId).toBe(captured.promptMessageId)
    expect(prepared.promptPreparation).toMatchObject({
      promptMessageId: captured.promptMessageId
    })
    expect(prepared.runtimeSessionAdmissions ?? []).toHaveLength(0)
    expect(await app.readFakeAgentPrompts()).toHaveLength(0)
    page = await app.restartAfterCrash({ force: true })
    await page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button', { name: prompt })
      .click()
    const restored = await sessionForPrompt(page, prompt)
    expect(restored.messages.some(({ id }) => id === captured.promptMessageId)).toBe(true)
    expect(outcomeFor(restored, prompt)).toBeUndefined()
    expect(restored.activeRun).toBeUndefined()
    expect(restored.resumeRecovery).toBeUndefined()
    expect(restored.status).toBe('idle')
    expect(restored.promptPreparation).toBeUndefined()
    await assertNoAttention(page, restored.id)
    await expect(page.locator('[data-slot="session-recovery-notice"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toHaveCount(0)
    await evidence(page, testInfo, 'unadmitted-message-preserved-after-crash', restored)
    const followup = 'Summarize the deterministic fixture.'
    const nextGate = await holdOutcomeAdmission(app, followup)
    try {
      await submit(page, followup)
      await expect
        .poll(nextGate.captured)
        .toMatchObject({ sessionId: restored.id, promptMessageId: expect.any(String) })
      const nextRequest = (await nextGate.captured())!
      await page.evaluate(() => window.api.sessions.loadAll())
      const nextPrepared = await readRawOutcomeSession(app, { projectId, sessionId: restored.id })
      await testInfo.attach('next-prepared-session', {
        body: JSON.stringify(nextPrepared, null, 2),
        contentType: 'application/json'
      })
      expect(nextPrepared.activeRun?.promptMessageId).toBe(nextRequest.promptMessageId)
    } finally {
      await nextGate.restore()
    }
    try {
      await expect(
        page.getByText(`Deterministic reply: ${followup}`, { exact: true })
      ).toBeVisible()
    } catch (error) {
      await testInfo.attach('failed-next-session', {
        body: JSON.stringify(
          await readRawOutcomeSession(app, { projectId, sessionId: restored.id }),
          null,
          2
        ),
        contentType: 'application/json'
      })
      throw error
    }
    await expect
      .poll(async () => outcomeFor(await sessionForPrompt(page, prompt), followup))
      .toMatchObject({ kind: 'completed' })
    expect(outcomeFor(await sessionForPrompt(page, prompt), prompt)).toBeUndefined()
  } finally {
    await gate.restore()
  }
})
