import { askReplayStep, discussReplayResearch, openReplayFiles } from './helpers/research-replay'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import type { PersistedChatSession } from '../src/shared/session-persistence'

test.use({ windowMode: 'normal' })

test('discusses and replays an ordinary Session directly from its menu', async ({ app }) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Ordinary replay')
  await create.getByRole('button', { name: 'Create project' }).click()
  const projectId = await page.evaluate(
    async () =>
      (await window.api.projects.list()).find((project) => project.name === 'Ordinary replay')!.id
  )
  const source: PersistedChatSession = {
    id: 'ordinary-replay-source',
    projectId,
    title: 'Ordinary discussion source',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'Explain the experiment.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer',
        role: 'agent',
        content: 'The recorded measurement was forty-two.',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 3
      }
    ]
  }
  page = await app.restartWithSessionFixture(source)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Ordinary replay', exact: true })
    .click()
  // Wait for selected-history hydration before opening its action target. A summary-to-full
  // replacement invalidates an already open context-menu snapshot by design.
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'The recorded measurement was forty-two.'
  )
  const row = page.locator(
    `[data-session-preview][data-session-id="${source.id}"] [data-slot="session-open-button"]`
  )
  const before = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View replay', exact: true }).click()
  const replay = page.getByTestId('replay-panel')
  await expect(replay).toBeVisible()
  await replay.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expect(replay.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible()
  await replay.getByRole('button', { name: 'Pause replay', exact: true }).click()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Discuss', exact: true }).click()
  const ask = page.getByRole('dialog', { name: 'Ask in a conversation' })
  await expect(ask).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Ask anything', exact: true })).toBeFocused()
  await expect(page.getByTestId('session-discussion-draft')).toContainText('Entire research')
  await expect(page.getByTestId('session-discussion-draft')).toContainText(source.title)
  const after = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  expect(after?.messages).toEqual(before?.messages)
  expect(after?.packageOrigin).toBeUndefined()
  const snapshots = await page.evaluate(
    async ({ projectId, sourceSessionId }) =>
      window.api.sessionReplay.listSelectionSnapshots({ projectId, sourceSessionId }),
    { projectId, sourceSessionId: source.id }
  )
  expect(snapshots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: 'session', sourceSessionId: source.id })
    ])
  )
})

test('opens imported research, asks about a recorded step and restores the ordinary conversation and replay', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Replay research')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const projectId = await page.evaluate(
    async () =>
      (await window.api.projects.list()).find((project) => project.name === 'Replay research')!.id
  )
  const source: PersistedChatSession = {
    id: 'import-replay-fixture',
    projectId,
    title: 'Archived analysis',
    cwd: '',
    status: 'idle',
    createdAt: 1000,
    updatedAt: 6000,
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'What does the saved experiment show?',
        status: 'complete',
        eventIds: [],
        createdAt: 1000,
        updatedAt: 2000
      },
      {
        id: 'answer',
        role: 'agent',
        content: 'The archived result is forty-two.',
        status: 'complete',
        eventIds: [],
        createdAt: 3000,
        updatedAt: 6000
      }
    ],
    packageOrigin: {
      importId: 'replay-receipt',
      importedAt: 7000,
      manifestChecksum: 'a'.repeat(64),
      sourceProjectId: 'original-project',
      sourceSessionId: 'original-session'
    }
  }
  page = await app.restartWithSessionFixture(source)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Replay research', exact: true })
    .click()
  const replay = page.getByTestId('replay-panel')
  // The research title opens the original transcript, with a separate unsent question beneath it.
  // Re-entering the same source must not create a conversation or replace the imported record.
  await expect(replay).toBeVisible()
  await page
    .locator(`[data-research-id="${source.id}"] [data-slot="session-open-button"]`)
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
  await expect(replay).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(editor).toBeEditable()
  const sourceHeader = page.getByTestId('research-workspace-header')
  await expect(sourceHeader).toContainText(source.title)
  await expect(sourceHeader).toContainText('Original record · Read-only')
  await expect(
    page.locator(`[data-research-id="${source.id}"]`).getByRole('button', {
      name: 'Original record · Read-only',
      exact: true
    })
  ).toHaveCount(0)
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
  await expect(conversation).toContainText('What does the saved experiment show?')
  await expect(conversation).toContainText('The archived result is forty-two.')
  await editor.fill('My unsent question stays alongside the original research.')
  await expect(conversation).toContainText('The archived result is forty-two.')
  await expect(sourceHeader).toContainText('Original record · Read-only')
  await editor.clear()
  await expect(page.getByTestId('session-discussion-draft')).toContainText('Entire research')
  await expect(page.getByText('Conversation storage needs attention', { exact: true })).toHaveCount(
    0
  )
  await expect(replay.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      async (projectId) =>
        (await window.api.sessions.loadAll()).sessions.filter(
          (row) => row.projectId === projectId && !row.packageOrigin
        ).length,
      projectId
    )
  ).toBe(0)
  const before = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  const prompts = await app.readFakeAgentPrompts()
  await replay.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expect(replay.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible()
  await replay.getByRole('button', { name: 'Pause replay', exact: true }).click()
  const browse = replay.getByRole('button', { name: 'Browse steps', exact: true })
  await browse.click()
  const directory = page.getByRole('dialog', { name: 'Browse steps', exact: true })
  await expect(directory.getByRole('listitem')).toHaveCount(2)
  await directory.getByRole('button', { name: /^Go to step 2:/ }).click()
  await expect(browse).toBeFocused()
  await expect(directory).toHaveCount(0)
  expect(
    Number(
      await replay.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    )
  ).toBeGreaterThan(0)

  await browse.click()
  await directory
    .getByRole('button', { name: 'Open original evidence for step 2', exact: true })
    .click()
  const original = page.getByRole('region', { name: 'Original recorded evidence', exact: true })
  await expect(original.getByRole('button', { name: 'Back to replay' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(original).not.toBeVisible()
  await expect(browse).toBeFocused()

  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('End')
  await expect(
    replay
      .getByRole('region', { name: 'Historical conversation', exact: true })
      .getByText('The archived result is forty-two.', { exact: true })
  ).toBeVisible()
  // The docked replay must retain readable text, rather than shrinking a capture-sized canvas.
  expect(
    await replay
      .getByRole('region', { name: 'Historical conversation', exact: true })
      .getByText('The archived result is forty-two.', { exact: true })
      .evaluate((element) => element.getBoundingClientRect().height)
  ).toBeGreaterThanOrEqual(16)
  const dockedWidth = await replay.evaluate((element) => element.getBoundingClientRect().width)
  await replay.getByRole('button', { name: 'Expand preview', exact: true }).click()
  await expect
    .poll(() => replay.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(dockedWidth)
  await page.screenshot({ path: testInfo.outputPath('session-replay-expanded.png') })
  // Exercise the actual replay pane at narrow widths independently of the desktop shell minimum.
  for (const width of [320, 375, 414, 768]) {
    await replay.evaluate((element, width) => {
      element.style.width = `${width}px`
    }, width)
    await browse.click()
    await expect(directory).toBeVisible()
    const geometry = await replay.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      // Material tabs intentionally scroll horizontally. Their clipping viewport must remain
      // bounded; the individual offscreen tabs are verified through keyboard navigation below.
      overflowing: Array.from(
        element.querySelectorAll(
          'button:not([role="tab"]), [role="tablist"], [data-testid="replay-controls"], section'
        )
      )
        .filter(
          (child) =>
            child.getBoundingClientRect().width > 0 &&
            (child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1 ||
              child.getBoundingClientRect().left < element.getBoundingClientRect().left - 1)
        )
        .map((child) => child.getAttribute('aria-label') ?? child.tagName)
    }))
    expect(geometry.width).toBe(width)
    expect(geometry.overflowing).toEqual([])
    await replay.screenshot({ path: testInfo.outputPath(`replay-steps-${width}.png`) })
    await page.keyboard.press('Escape')
    await expect(browse).toBeFocused()
    const materialTabs = replay.getByRole('tablist', { name: 'Research materials', exact: true })
    await materialTabs.getByRole('tab', { name: 'Original conversation', exact: true }).focus()
    await page.keyboard.press('End')
    const resultsTab = materialTabs.getByRole('tab', { name: 'Results', exact: true })
    await expect(resultsTab).toBeFocused()
    await expect(resultsTab).toHaveAttribute('aria-selected', 'true')
    await expect
      .poll(() =>
        resultsTab.evaluate((tab) => {
          const viewport = tab.closest('[role="tablist"]')!.getBoundingClientRect()
          const bounds = tab.getBoundingClientRect()
          return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1
        })
      )
      .toBe(true)
    await page.keyboard.press('Home')
    await expect(
      materialTabs.getByRole('tab', { name: 'Original conversation', exact: true })
    ).toBeFocused()
    await expect(
      materialTabs.getByRole('tab', { name: 'Original conversation', exact: true })
    ).toHaveAttribute('aria-selected', 'true')
  }
  await replay.evaluate((element) => {
    element.style.removeProperty('width')
  })

  await replay.getByRole('button', { name: 'Collapse preview', exact: true }).click()
  await askReplayStep(replay)
  await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
  await expect(page.locator('[data-session-discussion-source]')).toBeVisible()
  await expect(editor).not.toContainText('Archived analysis')
  await expect(replay.getByRole('button', { name: 'Watch again', exact: true })).toBeVisible()
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  const after = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  expect(after?.messages).toEqual(before?.messages)
  expect(after?.packageOrigin).toEqual(before?.packageOrigin)
  expect(
    await page.evaluate(
      async (projectId) =>
        (await window.api.sessions.loadAll()).sessions.filter(
          (row) => row.projectId === projectId && !row.packageOrigin
        ).length,
      projectId
    )
  ).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('session-replay-discussion.png') })
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('Explain this saved result.')
  // The chosen evidence stays fixed while the reader scrubs and edits the question.
  const discussionBar = page.getByTestId('session-discussion-bar')
  await discussionBar.evaluate((element) => {
    element.style.width = '320px'
  })
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('Home')
  await expect(page.locator('[data-session-discussion-source]')).toContainText('Step 2')
  await expect(discussionBar.getByRole('button', { name: /^Use step / })).toHaveCount(0)
  await expect(editor).toContainText('Explain this saved result.')
  await editor.fill('Explain this saved result for a beginner.')
  await expect(conversation).toContainText('The archived result is forty-two.')
  await expect(sourceHeader).toContainText('Original record · Read-only')
  await discussionBar.evaluate((element) => {
    element.style.removeProperty('width')
  })
  await page.screenshot({ path: testInfo.outputPath('discussion-send-focus.png') })
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  await editor.fill('Explain this saved result.')
  await expect(
    replay.getByRole('slider', { name: 'Replay progress', exact: true })
  ).toHaveAttribute('aria-valuenow', '0')
  await expect(page.locator('[data-session-discussion-source]')).toContainText('Step 2')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  try {
    await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
      'Explain this saved result.'
    )
  } catch (error) {
    const diagnostics = await page.evaluate(
      async (scope) => ({
        workspace: await window.api.sessionReplay.get(scope),
        sessions: await window.api.sessions.loadAll()
      }),
      { projectId, sourceSessionId: source.id }
    )
    await testInfo.attach('research-send-state', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json'
    })
    throw error
  }
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Deterministic reply:'
  )
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const target = await page.evaluate(
    async (projectId) =>
      (await window.api.sessions.loadAll()).sessions.find(
        (row) => row.projectId === projectId && !row.packageOrigin
      ),
    projectId
  )
  expect(target?.id).toBeTruthy()
  expect(target!.id).not.toBe(source.id)
  await expect(
    page.locator(
      `[data-research-id="${source.id}"] [data-session-id="${target!.id}"] [data-slot="session-open-button"]`
    )
  ).toHaveAttribute('aria-current', 'page')
  await expect(sourceHeader).not.toContainText('Original record · Read-only')
  const sourceAfterFirstSend = await page.evaluate(
    (request) => window.api.sessions.loadOne(request),
    { projectId, sessionId: source.id }
  )
  expect(sourceAfterFirstSend).toEqual(before)
  expect(target!.researchMembership).toEqual({
    sourceProjectId: projectId,
    sourceSessionId: source.id,
    sourceImportId: source.packageOrigin!.importId,
    sourceTitle: source.title
  })
  // New ordinary conversations also generate metadata through a separate provider request.
  const conversationPrompts = async (): ReturnType<typeof app.readFakeAgentPrompts> =>
    (await app.readFakeAgentPrompts()).filter(
      (entry) =>
        !entry.prompt.includes('Generate Session metadata only from the following JSON data:')
    )
  await expect.poll(async () => (await conversationPrompts()).length).toBe(prompts.length + 1)
  const recordedPrompts = await conversationPrompts()
  expect((await conversationPrompts()).at(-1)?.prompt).toContain('Explain this saved result.')
  expect((await conversationPrompts()).at(-1)?.prompt).toContain('host.sessions.read()')
  expect((await conversationPrompts()).at(-1)?.prompt).toContain(
    '"stepNumber":2,"title":"The archived result is forty-two."'
  )
  expect((await conversationPrompts()).at(-1)?.prompt).not.toContain('"excerpt":')
  await expect(page.getByTestId('session-discussion-source')).toContainText('Archived analysis')
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('End')
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ projectId, sourceSessionId }) =>
          (await window.api.sessionReplay.get({ projectId, sourceSessionId })).view?.state.timeMs,
        { projectId, sourceSessionId: source.id }
      )
    )
    .toBe(5000)
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Replay research', exact: true })
    .click()
  // Project entry restores the last location, including a discussion created by first send.
  // This is independent from clicking the research title, which always opens the source.
  await expect(
    page.locator(
      `[data-research-id="${source.id}"] [data-session-id="${target!.id}"] [data-slot="session-open-button"]`
    )
  ).toHaveAttribute('aria-current', 'page')
  await page
    .getByRole('region', { name: 'Conversation', exact: true })
    .getByRole('button', { name: 'Show annotation source', exact: true })
    .click()
  await expect(page.getByTestId('replay-panel')).toBeVisible()
  await expect(
    page.getByTestId('replay-panel').getByRole('button', { name: 'Watch again', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Explain this saved result.'
  )
  const restored = await page.evaluate(
    async ({ projectId, sourceSessionId }) =>
      window.api.sessionReplay.get({ projectId, sourceSessionId }),
    { projectId, sourceSessionId: source.id }
  )
  expect(restored.view?.state.timeMs).toBe(5000)
  const retainedTarget = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: target!.id
  })
  expect(retainedTarget?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  expect(await conversationPrompts()).toEqual(recordedPrompts)
  const retained = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  expect(retained?.messages).toEqual(before?.messages)
  expect(retained?.packageOrigin).toEqual(before?.packageOrigin)
  await expect(page.getByText('Conversation storage needs attention', { exact: true })).toHaveCount(
    0
  )
  await page.screenshot({ path: testInfo.outputPath('session-replay-restored.png') })
  const linked = page.getByTestId('session-discussion-source')
  await expect(linked).toContainText('Archived analysis')
  const followUp = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await followUp.fill('What led to that result?')
  await page
    .getByTestId('replay-panel')
    .getByRole('slider', { name: 'Replay progress', exact: true })
    .focus()
  await page.keyboard.press('Home')
  await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
  await expect(linked).toContainText('Step 2')
  await expect(followUp).toContainText('What led to that result?')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).length)
    .toBe(recordedPrompts.length + 1)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  expect((await conversationPrompts()).at(-1)?.prompt).toContain('host.sessions.read()')
  expect((await conversationPrompts()).at(-1)?.prompt).toContain(
    '"selectedSteps":[{"branchNumber":1,"stepNumber":2,"title":"The archived result is forty-two."}]'
  )
  const switched = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: target!.id
  })
  expect(switched!.runtimeContext!.sessionContext!.bindings[0].positions).toHaveLength(1)
  expect(switched!.runtimeContext!.sessionContext!.bindings[0].positions![0].stepNumber).toBe(2)
  expect(
    switched!.messages.filter((message) => message.role === 'user').at(-1)?.annotations ?? []
  ).toEqual([])
  expect(
    retainedTarget?.runtimeContext?.sessionContext?.bindings[0].positions?.[0].stepNumber
  ).toBe(2)
  // Repeated direct Ask reuses the current discussion and commits each selection before the next.
  for (const endpoint of ['Home', 'End']) {
    const activeReplay = page.getByTestId('replay-panel')
    const progress = activeReplay.getByRole('slider', { name: 'Replay progress', exact: true })
    await progress.focus()
    await page.keyboard.press(endpoint)
    await expect(progress).toHaveAttribute('aria-valuenow', endpoint === 'Home' ? '0' : '5000')
    await askReplayStep(activeReplay)
    await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
    await expect(
      page.locator(
        `[data-session-preview][data-session-id="${target!.id}"] [data-slot="session-open-button"]`
      )
    ).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-session-discussion-source]')).toHaveCount(1)
    await expect(page.locator('[data-session-discussion-source]')).toContainText(
      endpoint === 'Home' ? 'Step 1' : '2 steps'
    )
  }
  await followUp.fill('Explain the latest step.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).length)
    .toBe(recordedPrompts.length + 2)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const compared = await page.evaluate(
    ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: target!.id }
  )
  expect(compared!.runtimeContext!.sessionContext!.bindings).toHaveLength(1)
  expect(compared!.runtimeContext!.sessionContext!.bindings[0].positions).toHaveLength(2)
  await page
    .getByTestId('session-discussion-source')
    .getByRole('button', { name: 'Question scope', exact: true })
    .click()
  const choices = page.getByRole('dialog').filter({ hasText: 'Selected steps' })
  await choices.getByRole('button', { name: /The archived result is forty-two/ }).click()
  await expect(
    page.getByTestId('replay-panel').getByRole('slider', { name: 'Replay progress', exact: true })
  ).not.toHaveAttribute('aria-valuenow', '0')
  await page.screenshot({ path: testInfo.outputPath('session-reading-current-step.png') })
  // A learner can ask about the imported study without selecting a playback step.
  await page
    .getByTestId('replay-panel')
    .getByRole('button', { name: 'Question options', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Discuss the entire research', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page
    .getByTestId('replay-panel')
    .screenshot({ path: testInfo.outputPath('discussion-research-entry.png') })
  await discussReplayResearch(page.getByTestId('replay-panel'))
  await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
  await expect(page.locator('[data-session-discussion-source]')).toContainText('Entire research')
  await page.screenshot({
    path: testInfo.outputPath('discussion-entire-research.png'),
    animations: 'disabled'
  })
  // Repeated Ask keeps the same conversation and one whole-research selection.
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await discussReplayResearch(page.getByTestId('replay-panel'))
    await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
    await expect(page.locator('[data-session-discussion-source]')).toContainText('Entire research')
  }
  await expect(page.locator('[data-session-discussion-source]')).toHaveCount(1)
  await expect(page.locator('[data-session-discussion-source]')).not.toContainText('steps')
  // Pointer dragging, including release, does not mutate the draft or save its focus.
  const wholeBar = page.getByTestId('session-discussion-bar')
  await followUp.fill('Explain the selected step.')
  await wholeBar.evaluate((element) => {
    element.style.width = '320px'
  })
  const timeline = page.getByTestId('replay-progress-track')
  const box = (await timeline.boundingBox())!
  for (const fraction of [0.85, 0.05]) {
    const previous = await page.locator('[data-session-discussion-source]').textContent()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2, { steps: 8 })
    await expect(page.locator('[data-session-discussion-source]')).toHaveText(previous!)
    await page.mouse.up()
    await expect(page.locator('[data-session-discussion-source]')).toHaveText(previous!)
    await expect(followUp).toContainText('Explain the selected step.')
  }
  await wholeBar.evaluate((element) => {
    element.style.removeProperty('width')
  })
  // An explicit whole-research Ask still restores broad scope; merely opening its source must
  // not immediately switch back to the old playhead.
  await discussReplayResearch(page.getByTestId('replay-panel'))
  await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
  await expect(page.locator('[data-session-discussion-source]')).not.toContainText('Step')
  await followUp.fill('I am new to this. Explain the research goal and where to start.')
  await page.screenshot({ path: testInfo.outputPath('discussion-learning-draft.png') })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).at(-1)?.prompt)
    .toContain('"scope":"session"')
  const learning = await page.evaluate(
    ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: target!.id }
  )
  expect(learning!.runtimeContext!.sessionContext!.bindings[0].scope).toBe('session')
  expect((await conversationPrompts()).at(-1)?.prompt).not.toContain('"selectedSteps"')
  expect(learning!.runtimeContext!.sessionContext!.bindings[0].positions).toHaveLength(1)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)

  // The research title always returns to the original record, even after discussions exist.
  // Its saved child explicitly resumes the discussion after restart without changing the source.
  const promptsBeforeReturn = await conversationPrompts()
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Replay research', exact: true })
    .click()
  const sourceRow = page
    .locator(`[data-research-id="${source.id}"] [data-slot="session-open-button"]`)
    .first()
  await sourceRow.click()
  await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
  await expect(sourceRow).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('research-workspace-header')).toContainText(
    'Original record · Read-only'
  )
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'The archived result is forty-two.'
  )
  await expect(page.getByRole('textbox', { name: 'Ask anything', exact: true })).toBeEmpty()
  const savedDiscussion = page.locator(
    `[data-research-id="${source.id}"] [data-session-id="${target!.id}"] [data-slot="session-open-button"]`
  )
  await expect(savedDiscussion).not.toHaveAttribute('aria-current', 'page')
  await savedDiscussion.click()
  await expect(savedDiscussion).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('replay-panel')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'I am new to this. Explain the research goal and where to start.'
  )
  const resumedEditor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(resumedEditor).toBeEditable()
  await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
  await expect(page.getByTestId('research-workspace-header')).toContainText(source.title)
  expect(await conversationPrompts()).toEqual(promptsBeforeReturn)
  await resumedEditor.fill('Continue our earlier discussion of the same research.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).length)
    .toBe(promptsBeforeReturn.length + 1)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const sessionsAfterReturn = await page.evaluate(
    async (projectId) =>
      (await window.api.sessions.loadAll()).sessions.filter((row) => row.projectId === projectId),
    projectId
  )
  expect(sessionsAfterReturn.filter((row) => !row.packageOrigin).map((row) => row.id)).toEqual([
    target!.id
  ])
  expect(
    sessionsAfterReturn
      .find((row) => row.id === target!.id)!
      .messages.filter((message) => message.role === 'user')
  ).toHaveLength(5)
  const originalAfterReturn = await page.evaluate(
    (request) => window.api.sessions.loadOne(request),
    { projectId, sessionId: source.id }
  )
  expect(originalAfterReturn?.messages).toEqual(before?.messages)
  expect(originalAfterReturn?.packageOrigin).toEqual(before?.packageOrigin)

  const resumedSource = page.getByTestId('session-discussion-source')
  await resumedSource.getByRole('button', { name: 'Unlink Session', exact: true }).click()
  await expect(resumedSource).toHaveCount(0)
  await resumedEditor.fill('Now discuss something unrelated.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).length)
    .toBe(promptsBeforeReturn.length + 2)
  expect((await conversationPrompts()).at(-1)?.prompt).not.toContain(
    'Current discussion focus for this turn; this replaces any earlier focus.'
  )
})

test('previews recorded DOCX inside replay and routes its iframe menu at non-default zoom', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Replay Office preview')
  await create.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Create preview context menu artifacts.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Preview context menu artifacts created.', { exact: true })
  ).toBeVisible({ timeout: 90_000 })
  const row = page.locator('[data-session-preview][data-session-id]').first()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View replay', exact: true }).click()
  const replay = page.getByTestId('replay-panel')
  await expect(replay).toBeVisible()
  await replay.getByRole('button', { name: 'Expand preview', exact: true }).click()
  await replay.getByRole('slider', { name: 'Replay progress' }).focus()
  await page.keyboard.press('End')
  await openReplayFiles(replay)
  const files = replay.getByRole('complementary', { name: 'Files' })
  await files.getByRole('button', { name: /context-menu.docx/ }).click()
  await expect(replay.locator('[data-office-preview-state="ready"]')).toBeVisible({
    timeout: 90_000
  })
  const office = replay.frameLocator('iframe[data-office-preview-frame]')
  await expect(office.locator('.docx-review-counter')).toHaveText('1 / 1')
  await expect(office.locator('.docx-review-toolbar')).toHaveCSS('font-size', '14px')
  await expect(office.locator('.docx-review-toolbar')).toHaveCSS('height', '36px')
  const initialPixelRatio = await page.evaluate(() => window.devicePixelRatio)
  await app.setMainWindowZoomFactor(1.25)
  await expect
    .poll(() => page.evaluate(() => window.devicePixelRatio))
    .toBe(initialPixelRatio * 1.25)
  // Click saved document content, not a body offset that can land on the Office toolbar
  // after the expanded research pane is reflowed by Electron's non-default zoom.
  const documentText = office.getByText('Preview context menu Office fixture', { exact: true })
  await expect(documentText).toBeVisible()
  // The isolated Office frame applies zoom separately from its parent. Locator stability inside
  // that frame does not guarantee the containing expanded pane has finished reflowing.
  let previousGeometry = ''
  let geometryStableSince = 0
  await expect
    .poll(
      async () => {
        const [frameBounds, textBounds, framePixelRatio] = await Promise.all([
          replay.locator('iframe[data-office-preview-frame]').boundingBox(),
          documentText.boundingBox(),
          office.locator('body').evaluate(() => window.devicePixelRatio)
        ])
        const geometry = JSON.stringify([frameBounds, textBounds, framePixelRatio])
        if (geometry !== previousGeometry) {
          previousGeometry = geometry
          geometryStableSince = Date.now()
        }
        return (
          frameBounds !== null &&
          textBounds !== null &&
          framePixelRatio === initialPixelRatio * 1.25 &&
          Date.now() - geometryStableSince >= 100
        )
      },
      { intervals: [50] }
    )
    .toBe(true)
  await documentText.click({ button: 'right' })
  const menu = page.getByTestId('replay-preview-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByText('Close', { exact: true })).toBeVisible()
  await expect(menu.getByText('Edit', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await office.locator('body').evaluate((body) => {
    const target = document.createElement('div')
    target.dataset.previewContextMenuPassthrough = ''
    target.textContent = 'Replay native context area'
    body.prepend(target)
  })
  await office.getByText('Replay native context area', { exact: true }).click({ button: 'right' })
  await expect(menu).toBeHidden()
  await page.keyboard.press('Escape')
  await replay.getByRole('button', { name: 'Back to files', exact: true }).click()
  await expect(replay.locator('iframe[data-office-preview-frame]')).toHaveCount(0)
  await expect(files).toBeVisible()
})
