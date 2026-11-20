import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence/session'
import type { PersistedSessionStatus } from '../src/shared/session-run-contract'
import type { TurnOutcome } from '../src/shared/session-turn-outcome-contract'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

test.use({ windowMode: 'normal' })

const openSessionRow = (page: Page, sessionId: string): Locator =>
  page.locator(`[data-session-id="${sessionId}"] [data-slot="session-open-button"]`)

const sessionPanel = (page: Page, sessionId: string): Locator =>
  page.locator(`[data-testid="workspace-file-drop-zone"][data-session-id="${sessionId}"]`)

const waitForForkId = async (page: Page, sourceId: string): Promise<string> => {
  let forkId: string | undefined
  await expect
    .poll(async () => {
      forkId = await page.evaluate(
        async (id) =>
          (await window.api.sessions.loadAll()).sessions.find(
            ({ branchSource }) => branchSource?.sessionId === id
          )?.id,
        sourceId
      )
      return forkId
    })
    .toEqual(expect.any(String))
  if (!forkId) throw new Error('Expected a durable fork Session.')
  return forkId
}

const submitInSession = async (page: Page, sessionId: string, prompt: string): Promise<void> => {
  const panel = sessionPanel(page, sessionId)
  const editor = panel.getByRole('textbox', { name: 'Ask anything', exact: true })
  // The editor stays read-only until the draft binding for the selected Session is hydrated.
  await expect(editor).toBeEditable()
  await editor.fill(prompt)
  await expect(editor).toHaveText(prompt)
  await panel.getByRole('button', { name: 'Send message', exact: true }).click()
}

test('replays history on the first fork prompt and keeps both conversations independent', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  await createProjectViaUi(page, 'Fork first reply')

  const seed = 'Remember the verification code QUARTZ-742.'
  const question = 'What verification code did I ask you to remember?'
  const sourceOnly = 'This follow-up belongs only to the source chat.'
  const forkOnly = 'This follow-up belongs only to the fork.'
  const reply = 'The verification code is QUARTZ-742.'
  const loadSessions = async (): Promise<PersistedChatSession[]> =>
    (await page.evaluate(() => window.api.sessions.loadAll())).sessions
  const expectCompleted = async (sessionId: string, prompt: string): Promise<void> => {
    await expect
      .poll(async () => {
        const session = (await loadSessions()).find(({ id }) => id === sessionId)
        return {
          status: session?.status,
          activeRun: Boolean(session?.activeRun),
          outcomes: session?.messages
            .filter(({ role, content }) => role === 'user' && content === prompt)
            .map(({ turnOutcome }) => turnOutcome?.kind),
          hasError: session?.messages.some(({ status }) => status === 'error')
        }
      })
      .toEqual({ status: 'idle', activeRun: false, outcomes: ['completed'], hasError: false })
  }

  await submitPromptViaUi(page, seed)
  await expect(page.getByText('Verification code recorded.', { exact: true })).toBeVisible({
    timeout: 90_000
  })
  const source = (await loadSessions()).find(({ messages }) =>
    messages.some(({ role, content }) => role === 'user' && content === seed)
  )
  if (!source) throw new Error('Expected a durable source Session.')
  await expectCompleted(source.id, seed)
  const requestsContaining = async (
    text: string
  ): Promise<{ sessionId: string; prompt: string }[]> =>
    (await app.readFakeAgentPrompts())
      .filter(({ prompt }) => prompt.includes(text))
      .map(({ sessionId, prompt }) => ({ sessionId, prompt }))
  const seedRequests = await requestsContaining(seed)
  expect(seedRequests).toEqual([
    { sessionId: expect.any(String), prompt: expect.stringContaining(seed) }
  ])
  const sourceProviderId = seedRequests[0].sessionId

  await page.getByRole('button', { name: `Open actions for ${source.title}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const sourceLink = page.getByRole('button', {
    name: `Continued from chat #${source.number}`,
    exact: true
  })
  await expect(sourceLink).toBeVisible()
  const forkId = await waitForForkId(page, source.id)

  const forkPanel = sessionPanel(page, forkId)
  await expect(forkPanel.getByText(seed, { exact: true })).toBeVisible()
  await submitInSession(page, forkId, question)
  await expect(forkPanel.getByText(reply, { exact: true })).toBeVisible()
  await expectCompleted(forkId, question)
  const forkRequests = await requestsContaining(question)
  expect(forkRequests).toEqual([
    { sessionId: expect.any(String), prompt: expect.stringContaining(seed) }
  ])
  const forkProviderId = forkRequests[0].sessionId
  expect(forkProviderId).not.toBe(sourceProviderId)
  expect((await loadSessions()).find(({ id }) => id === forkId)?.providerSessionId).toBe(
    forkProviderId
  )
  await expect(forkPanel.getByRole('button', { name: /^(Retry|Resume session)$/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('fork-first-reply.png') })
  await submitInSession(page, forkId, forkOnly)
  await expectCompleted(forkId, forkOnly)

  await sourceLink.click()
  const sourcePanel = sessionPanel(page, source.id)
  await expect(sourcePanel).toBeVisible()
  await expect(sourcePanel.getByText(question, { exact: true })).toHaveCount(0)
  await expect(sourcePanel.getByText(forkOnly, { exact: true })).toHaveCount(0)
  await submitInSession(page, source.id, question)
  await expect(sourcePanel.getByText(reply, { exact: true })).toBeVisible()
  await expectCompleted(source.id, question)
  expect(await requestsContaining(question)).toEqual([
    ...forkRequests,
    { sessionId: sourceProviderId, prompt: expect.stringContaining(question) }
  ])
  await expect(sourcePanel.getByRole('button', { name: /^(Retry|Resume session)$/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('source-first-reply.png') })
  await submitInSession(page, source.id, sourceOnly)
  await expectCompleted(source.id, sourceOnly)

  await openSessionRow(page, forkId).click()
  await expect(forkPanel.getByText(reply, { exact: true })).toBeVisible()
  await expect(forkPanel.getByText(sourceOnly, { exact: true })).toHaveCount(0)
  await expect(forkPanel.getByText(forkOnly, { exact: true })).toBeVisible()
  const sessions = await loadSessions()
  const persistedSource = sessions.find(({ id }) => id === source.id)
  const persistedFork = sessions.find(({ id }) => id === forkId)
  expect(
    persistedSource?.messages.filter(({ role }) => role === 'user').map(({ content }) => content)
  ).toEqual([seed, question, sourceOnly])
  expect(
    persistedFork?.messages.filter(({ role }) => role === 'user').map(({ content }) => content)
  ).toEqual([seed, question, forkOnly])
  expect(persistedSource?.providerSessionId).toBe(sourceProviderId)
  expect(persistedFork?.providerSessionId).toBe(forkProviderId)
})

test('resumes a copied conversation after an empty model stream and desktop restart', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  await createProjectViaUi(page, 'Fork stream recovery')
  const seed = 'Record the evidence marker FORK-STREAM-EVIDENCE.'
  const question = 'Explain the evidence marker from this conversation.'
  const readTurn = (
    id: string
  ): Promise<{
    status: PersistedSessionStatus | undefined
    prompts: { id: string; outcome: TurnOutcome | undefined }[] | undefined
  }> =>
    page.evaluate(
      async ({ id, question }) => {
        const session = (await window.api.sessions.loadAll()).sessions.find(
          (candidate) => candidate.id === id
        )
        return {
          status: session?.status,
          prompts: session?.messages
            .filter(({ content, role }) => role === 'user' && content === question)
            .map(({ id, turnOutcome }) => ({ id, outcome: turnOutcome }))
        }
      },
      { id, question }
    )
  await submitPromptViaUi(page, seed)
  await expect(page.getByText('Recorded FORK-STREAM-EVIDENCE.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
  const source = await page.evaluate(async (seed) => {
    const { sessions } = await window.api.sessions.loadAll()
    const source = sessions.find(({ messages }) => messages.some(({ content }) => content === seed))
    if (!source) throw new Error('Expected a durable source Session.')
    return { id: source.id, number: source.number, title: source.title }
  }, seed)

  await page.getByRole('button', { name: `Open actions for ${source.title}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const sourceLink = { name: `Continued from chat #${source.number}`, exact: true }
  await expect(page.getByRole('button', sourceLink)).toBeVisible()
  const forkId = await waitForForkId(page, source.id)
  const forkPanel = sessionPanel(page, forkId)
  await submitInSession(page, forkId, question)
  const resume = { name: 'Resume session', exact: true }
  await expect(forkPanel.getByRole('button', resume)).toBeVisible()
  await expect(
    forkPanel.getByText('The model response was interrupted', { exact: true })
  ).toBeVisible()
  await expect(forkPanel.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)

  const interruption = {
    kind: 'interrupted',
    recovery: 'resume',
    failure: {
      reason: 'service/response-interrupted',
      diagnostics: { code: '-32603', providerCode: '400008' }
    }
  }
  const expectPersistedInterruption = (promptId: unknown): Promise<void> =>
    expect
      .poll(() => readTurn(forkId))
      .toMatchObject({
        prompts: [{ id: promptId, outcome: interruption }]
      })
  await expectPersistedInterruption(expect.any(String))
  const promptId = (await readTurn(forkId)).prompts?.[0]?.id
  if (!promptId) throw new Error('Expected an interrupted prompt in the durable fork.')
  await page.screenshot({ path: testInfo.outputPath('fork-stream-interrupted.png') })

  await page.getByRole('button', sourceLink).click()
  await submitInSession(page, source.id, question)
  await expect(
    page.getByText('Source continued with FORK-STREAM-EVIDENCE.', { exact: true })
  ).toBeVisible()
  await expect
    .poll(() => readTurn(source.id))
    .toMatchObject({
      status: 'idle',
      prompts: [{ outcome: { kind: 'completed' } }]
    })
  page = await app.restart()
  await page.getByRole('button', { name: 'Fork stream recovery', exact: true }).click()
  await openSessionRow(page, forkId).click()
  const reopenedFork = sessionPanel(page, forkId)
  await expect(reopenedFork.getByRole('button', resume)).toBeVisible()
  await expectPersistedInterruption(promptId)
  await reopenedFork.getByRole('button', resume).click()
  await expect(
    reopenedFork.getByText('Resumed with FORK-STREAM-EVIDENCE.', { exact: true })
  ).toBeVisible()
  await expect
    .poll(() => readTurn(forkId))
    .toMatchObject({
      status: 'idle',
      prompts: [{ id: promptId, outcome: { kind: 'completed' } }]
    })
  await expect(reopenedFork.getByRole('button', resume)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('fork-stream-resumed.png') })
})

test('forks local and imported research and immediately continues through the real desktop lifecycle', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.configureSessionPackageDialogs()
  await createProjectViaUi(page, 'Fork lifecycle')
  const prompt = 'Summarize the deterministic fixture.'
  await submitPromptViaUi(page, prompt)
  await expect(page.getByText(`Deterministic reply: ${prompt}`, { exact: true })).toBeVisible({
    timeout: 90_000
  })
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: `Open actions for ${prompt}` }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const title = `${prompt}(2)`
  await expect(page.getByRole('button', { name: `Open actions for ${title}` })).toBeVisible()
  const row = page
    .locator('[data-session-id]')
    .filter({ has: page.getByRole('button', { name: `Open actions for ${title}` }) })
  await expect(row.getByRole('img', { name: 'Read-only' })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^#\d+.*\(2\)$/)
  const continuation = page.getByRole('button', { name: /^Continued from chat #\d+$/ })
  const sourceLabel = await continuation.textContent()
  const sourceNumber = sourceLabel?.match(/#\d+/)?.[0] ?? ''
  expect(sourceNumber).toMatch(/^#\d+$/)
  await continuation.click()
  await expect(continuation).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(sourceNumber)
  await row.locator('[data-slot="session-open-button"]').click()
  await expect(page.getByRole('button', { name: /^Continued from chat #\d+$/ })).toBeVisible()
  for (const [kind, followup] of [
    ['local', 'Continue local fork'],
    ['imported', 'Continue imported fork']
  ] as const) {
    if (kind === 'imported') {
      await page.getByRole('button', { name: `Open actions for ${title}` }).click()
      await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
      await page.getByRole('menuitem', { name: 'Export Session package', exact: true }).click()
      const exporting = page.getByRole('dialog', { name: 'Export Session package', exact: true })
      await exporting.getByRole('button', { name: 'Choose save location…', exact: true }).click()
      await expect(exporting.getByText('Session package exported', { exact: true })).toBeVisible()
      await exporting.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Fork lifecycle', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Import Session package…', exact: true }).click()
      const importing = page.getByRole('dialog', { name: 'Import Session package', exact: true })
      await importing.getByRole('button', { name: 'Import', exact: true }).click()
      await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
      await page.getByRole('button', { name: 'Fork to continue', exact: true }).click()
      await expect(
        page.getByRole('region', { name: 'Research discussion', exact: true })
      ).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Continued from chat #\d+$/ })).toBeVisible()
    }
    const replies = page
      .getByRole('region', { name: 'Conversation', exact: true })
      .getByText(`Deterministic reply: ${prompt}`, { exact: true })
    const previousReplies = await replies.count()
    await submitPromptViaUi(page, followup)
    await expect(replies).toHaveCount(previousReplies + 1, { timeout: 90_000 })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
    await expect(page.getByText(/Project owner is unavailable/)).toHaveCount(0)
    await expect(page.getByText(/could not save the latest conversation changes/)).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(
          async (text) =>
            (await window.api.sessions.loadAll()).sessions.some(
              (session) =>
                session.forkOrigin && session.messages.some((message) => message.content === text)
            ),
          followup
        )
      )
      .toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${kind}-fork-continued.png`) })
  }
  const restarted = await app.restart()
  await restarted
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', {
      name: new RegExp('^Summarize the deterministic fixture\\.\\(2\\)\\(2\\)')
    })
    .click()
  await expect(restarted.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
  await expect(
    restarted
      .locator('[data-slot="session-open-button"][aria-current="page"]')
      .getByRole('img', { name: 'Read-only' })
  ).toHaveCount(0)
  const replies = restarted
    .getByRole('region', { name: 'Conversation', exact: true })
    .getByText(`Deterministic reply: ${prompt}`, { exact: true })
  const before = await replies.count()
  await submitPromptViaUi(restarted, 'Continue after restart')
  await expect(replies).toHaveCount(before + 1)
  await expect(restarted.getByText(/Project owner is unavailable/)).toHaveCount(0)
  await expect
    .poll(async () =>
      restarted.evaluate(async () =>
        (await window.api.sessions.loadAll()).sessions.some(
          (session) =>
            session.forkOrigin &&
            session.messages.some((message) => message.content === 'Continue after restart')
        )
      )
    )
    .toBe(true)
})

test('changes branch permissions before the first follow-up without changing source permissions', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Branch permissions')
  const prompt = 'Summarize the deterministic fixture.'
  await submitPromptViaUi(page, prompt)
  const reply = page.getByText(`Deterministic reply: ${prompt}`, { exact: true })
  // The first turn includes provider preparation on Windows. Wait for its actual durable
  // completion before checking paced text presentation; this is not a latency benchmark.
  await expect
    .poll(
      async () =>
        page.evaluate(async (prompt) => {
          const session = (await window.api.sessions.loadAll()).sessions.find((candidate) =>
            candidate.messages.some(
              (message) => message.role === 'user' && message.content === prompt
            )
          )
          return {
            status: session?.status,
            activeRun: Boolean(session?.activeRun),
            completedReply: session?.messages.some(
              (message) =>
                message.role === 'agent' &&
                message.status === 'complete' &&
                message.content === `Deterministic reply: ${prompt}`
            )
          }
        }, prompt),
      { timeout: 60_000 }
    )
    .toEqual({ status: 'idle', activeRun: false, completedReply: true })
  await expect(reply).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
  const source = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  const profile = source.permissionProfile === 'ask' ? 'auto' : 'ask'
  const label = profile === 'ask' ? 'Ask for approval' : 'Auto-approve edits'
  const sourceHeading = await page.getByRole('heading', { level: 1 }).innerText()
  await reply.hover()
  await page.getByRole('button', { name: 'Branch in new session', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(sourceHeading)
  const divider = page.getByRole('button', {
    name: `Continued from chat #${source.number}`,
    exact: true
  })
  await expect(divider).toBeVisible()
  // Isolated OpenCode Sessions start a new process. Wait for the temporary branch identity to bind
  // before opening a menu that is remounted when the durable Session id replaces it.
  await expect
    .poll(async () =>
      page.evaluate(
        async (sourceId) =>
          (await window.api.sessions.loadAll()).sessions.some(
            (session) =>
              session.branchSource?.sessionId === sourceId &&
              session.pendingHistoryReplay?.kind === 'all'
          ),
        source.id
      )
    )
    .toBe(true)

  await page.getByTestId('composer-controls-trigger').click()
  await page.getByRole('menuitem', { name: /^Permission mode/ }).hover()
  const option = page.getByRole('menuitem', { name: label, exact: true })
  await expect(option).not.toHaveAttribute('aria-disabled', 'true')
  await option.click()
  await expect(page.getByTestId('composer-controls-trigger')).toHaveAttribute(
    'aria-label',
    new RegExp(label)
  )
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ sourceId, profile }) => {
          const { sessions } = await window.api.sessions.loadAll()
          const child = sessions.find((session) => session.branchSource?.sessionId === sourceId)
          return child?.permissionProfile === profile && child.pendingHistoryReplay?.kind === 'all'
        },
        { sourceId: source.id, profile }
      )
    )
    .toBe(true)
  await submitPromptViaUi(page, 'Continue the research')
  await expect(reply).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ sourceId, profile }) => {
          const { sessions } = await window.api.sessions.loadAll()
          const child = sessions.find((session) => session.branchSource?.sessionId === sourceId)
          return child?.permissionProfile === profile && child.pendingHistoryReplay === undefined
        },
        { sourceId: source.id, profile }
      )
    )
    .toBe(true)
  const original = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id),
    source.id
  )
  expect(original?.permissionProfile).toBe(source.permissionProfile)
  expect(original?.messages).toEqual(source.messages)
  await expect(divider).toHaveCount(1)
  const followup = page.getByText('Continue the research', { exact: true })
  await expect
    .poll(async () => {
      const inheritedBox = await reply.first().boundingBox()
      const dividerBox = await divider.boundingBox()
      const followupBox = await followup.boundingBox()
      return Boolean(
        inheritedBox &&
        dividerBox &&
        followupBox &&
        inheritedBox.y < dividerBox.y &&
        dividerBox.y < followupBox.y
      )
    })
    .toBe(true)
  await divider.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sourceHeading, {
    useInnerText: true
  })
  await expect(divider).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Continue from composer branch')
  await page.getByTestId('branch-send-menu-trigger').click()
  await page.getByTestId('menu-branch-in-new-session').click()
  await expect(divider).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        async (sourceId) =>
          (await window.api.sessions.loadAll()).sessions.some(
            (session) =>
              session.branchSource?.sessionId === sourceId &&
              session.status === 'idle' &&
              session.messages.some(
                (message) => message.content === 'Continue from composer branch'
              )
          ),
        source.id
      )
    )
    .toBe(true)
  const restarted = await app.restart()
  await restarted
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /^Continue from composer branch/ })
    .click()
  await expect(
    restarted.getByRole('button', {
      name: `Continued from chat #${source.number}`,
      exact: true
    })
  ).toBeVisible()
})
