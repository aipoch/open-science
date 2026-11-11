import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProject } from './certification/helpers'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

test.use({ windowMode: 'normal' })

test('replays an ordinary Session without offering discussion entry points', async ({ app }) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Ordinary replay')
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
  const row = page.locator(`[data-session-preview][data-session-id="${source.id}"]`)
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
  await expect(page.getByRole('menuitem', { name: 'Discuss', exact: true })).toHaveCount(0)
  await expect(replay.getByRole('button', { name: 'Ask about this step' })).toHaveCount(0)
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
  expect(snapshots).toEqual([])
})

test('opens imported research, asks about a recorded step and restores the ordinary conversation and replay', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Replay research')
  const source: PersistedChatSession = {
    id: 'import-replay-fixture',
    projectId,
    title: 'Archived analysis',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 4,
    messages: [
      {
        id: 'question',
        role: 'user',
        content: 'What does the saved experiment show?',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer',
        role: 'agent',
        content: 'The archived result is forty-two.',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 3
      }
    ],
    packageOrigin: {
      importId: 'replay-receipt',
      importedAt: 5,
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
  await expect(replay).toHaveCount(0)
  await page
    .getByRole('region', { name: 'Imported research history', exact: true })
    .getByRole('button', { name: 'Discuss', exact: true })
    .click()
  await expect(page.getByTestId('session-discussion-draft')).toContainText(source.title)
  await page
    .getByRole('button', { name: source.title, exact: false })
    .and(page.locator('[data-slot="session-open-button"]'))
    .click()
  await page
    .getByRole('region', { name: 'Imported research history', exact: true })
    .getByRole('button', { name: 'View replay', exact: true })
    .click()
  await expect(replay).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Imported research history', exact: true })
  ).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(editor).toHaveCount(0)
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
      .getByTestId('replay-stage')
      .getByText('The archived result is forty-two.', { exact: true })
  ).toBeVisible()
  // The docked replay must retain readable text, rather than shrinking a capture-sized canvas.
  expect(
    await replay
      .getByTestId('replay-stage')
      .getByText('The archived result is forty-two.', { exact: true })
      .evaluate((element) => element.getBoundingClientRect().height)
  ).toBeGreaterThanOrEqual(16)
  const dockedWidth = await replay.evaluate((element) => element.getBoundingClientRect().width)
  await replay.getByRole('button', { name: 'Enter full screen', exact: true }).click()
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
      overflowing: Array.from(
        element.querySelectorAll('button, [data-testid="replay-controls"], section')
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
  }
  await replay.evaluate((element) => {
    element.style.removeProperty('width')
  })

  await replay.getByRole('button', { name: 'Exit full screen', exact: true }).click()
  await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
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
  // The explicit Ask remains selected while the user browses elsewhere.
  const discussionBar = page.getByTestId('session-discussion-bar')
  await discussionBar.evaluate((element) => {
    element.style.width = '320px'
  })
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('Home')
  await expect(replay.getByRole('slider', { name: 'Replay progress' })).toHaveAttribute(
    'aria-valuenow',
    '0'
  )
  await expect(page.locator('[data-session-discussion-source]')).toContainText('Step 2')
  await expect(discussionBar.getByRole('button', { name: /^Use step / })).toHaveCount(0)
  await expect(editor).toContainText('Explain this saved result.')
  await editor.fill('Explain this saved result for a beginner.')
  await discussionBar.evaluate((element) => {
    element.style.removeProperty('width')
  })
  await page.screenshot({ path: testInfo.outputPath('discussion-send-focus.png') })
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  await editor.fill('Explain this saved result.')
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('End')
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
  expect(target?.parentSessionId).toBe(source.id)
  const firstQuestion = target!.messages.find((message) => message.role === 'user')!
  expect(firstQuestion.annotations).toHaveLength(1)
  expect(firstQuestion.annotations![0]).toMatchObject({ quote: expect.stringContaining('[2]') })
  expect(target?.id).toBeTruthy()
  expect(target!.id).not.toBe(source.id)
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
  await expect(
    page.locator(`[data-session-id="${target!.id}"][data-parent-session-id="${source.id}"]`)
  ).toBeVisible()
  expect(retainedTarget?.parentSessionId).toBe(source.id)
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
  await followUp.fill('Why?')
  await page
    .getByTestId('replay-panel')
    .getByRole('slider', { name: 'Replay progress', exact: true })
    .focus()
  await page.keyboard.press('Home')
  await expect(page.getByTestId('session-discussion-draft')).toHaveCount(0)
  await expect(linked).toContainText('Step 2')
  await expect(followUp).toContainText('Why?')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).length)
    .toBe(recordedPrompts.length + 1)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  expect((await conversationPrompts()).at(-1)?.prompt).toContain('host.sessions.read()')
  expect((await conversationPrompts()).at(-1)?.prompt).toContain(
    '"selectedSteps":[{"branchNumber":1,"stepNumber":2,"title":"The archived result is forty-two."}]'
  )
  const afterFollowUp = await page.evaluate((request) => window.api.sessions.loadOne(request), {
    projectId,
    sessionId: target!.id
  })
  expect(afterFollowUp!.runtimeContext!.sessionContext).toEqual(
    retainedTarget!.runtimeContext!.sessionContext
  )
  expect(afterFollowUp!.messages.find((m) => m.content === 'Why?')?.annotations ?? []).toHaveLength(
    0
  )
  await expect(linked.getByRole('button', { name: 'Unlink Session' })).toHaveCount(0)
  await expect(
    page.evaluate(
      async ({ projectId, sessionId, sourceSessionId }) => {
        const session = await window.api.sessions.loadOne({ projectId, sessionId })
        return window.api.sessionReplay.unlinkSession({
          projectId,
          sessionId,
          sourceSessionId,
          expectedRevision: session!.runtimeContext!.revision
        })
      },
      { projectId, sessionId: target!.id, sourceSessionId: source.id }
    )
  ).rejects.toThrow(/parent research/)
  // A new Ask on the parent stages step 1 in this same child; seeking to step 2 cannot replace it.
  const parentReplay = page.getByTestId('replay-panel')
  const progress = parentReplay.getByRole('slider', { name: 'Replay progress', exact: true })
  await expect(progress).toHaveAttribute('aria-valuenow', '0')
  await parentReplay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
  await expect(page.getByTestId('session-discussion-draft')).toContainText('Step 1')
  await progress.focus()
  await page.keyboard.press('End')
  await expect(progress).toHaveAttribute('aria-valuenow', '5000')
  await expect(page.getByTestId('session-discussion-draft')).toContainText('Step 1')
  await followUp.fill('Explain the latest step.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).length)
    .toBe(recordedPrompts.length + 2)
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  const compared = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find(
        (row) =>
          row.parentSessionId === id &&
          row.messages.some((m) => m.content === 'Explain the latest step.')
      ),
    source.id
  )
  expect(compared!.id).toBe(target!.id)
  expect(compared!.parentSessionId).toBe(source.id)
  expect(compared!.runtimeContext!.sessionContext!.bindings[0].positions?.[0].stepNumber).toBe(1)
  expect((await conversationPrompts()).at(-1)?.prompt).toContain(
    '"stepNumber":1,"title":"What does the saved experiment show?"'
  )
  expect(compared!.messages.find((m) => m.id === firstQuestion.id)?.annotations).toEqual(
    firstQuestion.annotations
  )
  expect(compared!.runtimeContext!.sessionContext!.bindings).toHaveLength(1)
  expect(compared!.runtimeContext!.sessionContext!.bindings[0].positions).toHaveLength(1)
  await page.getByRole('button', { name: `Close preview of ${source.title}`, exact: true }).click()
  await expect(page.getByTestId('replay-panel')).toHaveCount(0)
  await page
    .getByTestId('session-discussion-source')
    .getByRole('button', { name: /View replay:/ })
    .click()
  await expect(page.getByTestId('replay-panel')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByTestId('replay-panel').getByRole('slider', { name: 'Replay progress', exact: true })
  ).toHaveAttribute('aria-valuenow', '0')
  await page.screenshot({ path: testInfo.outputPath('session-reading-current-step.png') })
  // A learner can ask about the imported study without selecting a playback step.
  await page
    .getByTestId('replay-panel')
    .getByRole('button', { name: 'Ask about this research', exact: true })
    .hover()
  await expect(page.getByRole('tooltip', { name: 'Ask about this research' })).toBeVisible()
  await page
    .getByTestId('replay-panel')
    .screenshot({ path: testInfo.outputPath('discussion-research-entry.png') })
  await page
    .getByTestId('replay-panel')
    .getByRole('button', { name: 'Ask about this research', exact: true })
    .click()
  await expect(page.getByTestId('session-discussion-draft')).toContainText(source.title)
  await page.screenshot({
    path: testInfo.outputPath('discussion-entire-research-draft.png'),
    animations: 'disabled'
  })
  // Repeated Ask must update the source, not accumulate snapshot IDs as steps.
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await expect(page.locator('[data-session-discussion-source]')).not.toContainText(
      'Entire research'
    )
    await page
      .getByTestId('replay-panel')
      .getByRole('button', { name: 'Ask about this research', exact: true })
      .click()
  }
  await expect(page.locator('[data-session-discussion-source]')).toHaveCount(1)
  await expect(page.locator('[data-session-discussion-source]')).not.toContainText(
    'Entire research'
  )
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
  await page
    .getByTestId('replay-panel')
    .getByRole('button', { name: 'Ask about this research', exact: true })
    .click()
  await expect(page.locator('[data-session-discussion-source]')).not.toContainText('Step')
  await followUp.fill('I am new to this. Explain the research goal and where to start.')
  await page.screenshot({ path: testInfo.outputPath('discussion-learning-draft.png') })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await conversationPrompts()).at(-1)?.prompt)
    .toContain('"scope":"session"')
  const learning = await page.evaluate(
    async (id) =>
      (await window.api.sessions.loadAll()).sessions.find(
        (row) =>
          row.parentSessionId === id &&
          row.messages.some((m) => m.content.includes('research goal'))
      ),
    source.id
  )
  expect(learning!.runtimeContext!.sessionContext!.bindings[0].scope).toBe('session')
})

test('previews recorded DOCX inside replay and routes its iframe menu at non-default zoom', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Replay Office preview')
  await submitPromptViaUi(page, 'Create preview context menu artifacts.')
  await expect(
    page.getByText('Preview context menu artifacts created.', { exact: true })
  ).toBeVisible({ timeout: 90_000 })
  const row = page.locator('[data-session-preview][data-session-id]').first()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View replay', exact: true }).click()
  const replay = page.getByTestId('replay-panel')
  await expect(replay).toBeVisible()
  await replay.getByRole('button', { name: 'Enter full screen', exact: true }).click()
  await replay.getByRole('slider', { name: 'Replay progress' }).focus()
  await page.keyboard.press('End')
  const files = replay.getByRole('complementary', { name: 'Files' })
  await files.getByRole('button', { name: /context-menu.docx/ }).click()
  await expect(replay.locator('[data-office-preview-state="ready"]')).toBeVisible({
    timeout: 90_000
  })
  const office = replay.frameLocator('iframe[data-office-preview-frame]')
  await expect(office.locator('.docx-review-counter')).toHaveText('1 / 1')
  await expect(office.locator('.docx-review-toolbar')).toHaveCSS('font-size', '14px')
  await expect(office.locator('.docx-review-toolbar')).toHaveCSS('height', '36px')
  await app.setMainWindowZoomFactor(1.25)
  await office.locator('body').click({ button: 'right', position: { x: 40, y: 40 } })
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
  // Passthrough does not create an app menu. Escape here navigates out of the preview itself.
  await expect(replay.locator('iframe[data-office-preview-frame]')).toBeVisible()
  await replay.getByRole('button', { name: 'Back to files', exact: true }).click()
  await expect(replay.locator('iframe[data-office-preview-frame]')).toHaveCount(0)
  await expect(files).toBeVisible()
})
