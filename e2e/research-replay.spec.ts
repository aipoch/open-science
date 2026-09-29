import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import type { PersistedChatSession } from '../src/shared/session-persistence'

test.use({ windowMode: 'normal' })

test('opens imported research, asks about a recorded step and restores the same discussion and replay', async ({
  app
}, testInfo) => {
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
  await expect(replay).toBeVisible()
  await expect(page.getByRole('region', { name: 'Research discussion', exact: true })).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(editor).toBeEditable()
  await expect(page.getByText('Conversation storage needs attention', { exact: true })).toHaveCount(
    0
  )
  await expect(replay.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      async (projectId) =>
        (await window.api.researchWorkspaces.list({ projectId })).some(
          (entry) => entry.discussionSessionId
        ),
      projectId
    )
  ).toBe(false)
  const before = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  const prompts = await app.readFakeAgentPrompts()
  await replay.getByRole('button', { name: 'Play replay', exact: true }).click()
  await expect(replay.getByRole('button', { name: 'Pause replay', exact: true })).toBeVisible()
  await replay.getByRole('button', { name: 'Pause replay', exact: true }).click()
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('End')
  await expect(replay.getByText('The archived result is forty-two.', { exact: true })).toBeVisible()
  await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
  await expect(editor).toContainText('Archived analysis')
  await expect(replay.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible()
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
        (await window.api.researchWorkspaces.list({ projectId })).some(
          (entry) => entry.discussionSessionId
        ),
      projectId
    )
  ).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('research-replay-discussion.png') })
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('Explain this saved result.')
  // A real double-click must retain the same durable intent and invoke the model once.
  await page.getByRole('button', { name: 'Send message', exact: true }).dblclick()
  try {
    await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
      'Explain this saved result.'
    )
  } catch (error) {
    const diagnostics = await page.evaluate(
      async (scope) => ({
        workspace: await window.api.researchWorkspaces.get(scope),
        submissions: await window.api.researchSubmissions.list(scope),
        drafts: await window.api.researchDrafts.list(scope),
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
  const linked = await page.evaluate(
    async ({ projectId, sourceSessionId }) =>
      window.api.researchWorkspaces.get({ projectId, sourceSessionId }),
    { projectId, sourceSessionId: source.id }
  )
  expect(linked.discussionSessionId).toBeTruthy()
  expect(linked.discussionSessionId).not.toBe(source.id)
  await expect.poll(async () => (await app.readFakeAgentPrompts()).length).toBe(prompts.length + 1)
  const recordedPrompts = await app.readFakeAgentPrompts()
  expect(recordedPrompts.at(-1)?.prompt).toContain('Explain this saved result.')
  expect(recordedPrompts.at(-1)?.prompt).toContain('Source fingerprint:')
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ projectId, sourceSessionId }) =>
          (await window.api.researchWorkspaces.get({ projectId, sourceSessionId })).view?.state
            .timeMs,
        { projectId, sourceSessionId: source.id }
      )
    )
    .toBe(5000)
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: 'Replay research', exact: true })
    .click()
  await expect(page.getByTestId('replay-panel')).toBeVisible()
  await expect(
    page.getByTestId('replay-panel').getByRole('button', { name: 'Play replay', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toContainText(
    'Explain this saved result.'
  )
  const restored = await page.evaluate(
    async ({ projectId, sourceSessionId }) =>
      window.api.researchWorkspaces.get({ projectId, sourceSessionId }),
    { projectId, sourceSessionId: source.id }
  )
  expect(restored.discussionSessionId).toBe(linked.discussionSessionId)
  expect(
    restored.discussionSession?.messages.filter((message) => message.role === 'user')
  ).toHaveLength(1)
  expect(await app.readFakeAgentPrompts()).toEqual(recordedPrompts)
  const retained = await page.evaluate(
    async ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId, sessionId: source.id }
  )
  expect(retained?.messages).toEqual(before?.messages)
  expect(retained?.packageOrigin).toEqual(before?.packageOrigin)
  await expect(page.getByText('Conversation storage needs attention', { exact: true })).toHaveCount(
    0
  )
  await page.screenshot({ path: testInfo.outputPath('research-replay-restored.png') })
})
