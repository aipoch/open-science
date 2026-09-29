import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test, type ElectronApp } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import type { PersistedChatSession } from '../src/shared/session-persistence'

// Use the real renderer, IPC, SQLite, upload publication and normal ACP send path. Only the
// provider is the existing deterministic ACP fixture; no send/claim/receipt is replaced here.
test.use({ windowMode: 'normal' })

const openResearch = async (page: Page, projectName: string): Promise<void> => {
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await expect(page.getByTestId('replay-panel')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask anything', exact: true })).toBeEditable()
}

const seedResearch = async (
  app: ElectronApp,
  projectName: string
): Promise<{ page: Page; source: PersistedChatSession }> => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, projectName)
  const source: PersistedChatSession = {
    id: 'imported-concurrent-research',
    projectId,
    title: 'Archived concurrent analysis',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 4,
    messages: [
      {
        id: 'source-question',
        role: 'user',
        content: 'What does this recorded experiment show?',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'source-answer',
        role: 'agent',
        content: 'The recorded result is forty-two.',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 3
      }
    ],
    packageOrigin: {
      importId: 'concurrent-research-receipt',
      importedAt: 5,
      manifestChecksum: 'b'.repeat(64),
      sourceProjectId: 'original-project',
      sourceSessionId: 'original-source'
    }
  }
  page = await app.restartWithSessionFixture(source)
  await openResearch(page, projectName)
  return { page, source }
}

const scopeOf = (source: PersistedChatSession): { projectId: string; sourceSessionId: string } => ({
  projectId: source.projectId,
  sourceSessionId: source.id
})
const readSource = (
  page: Page,
  source: PersistedChatSession
): Promise<PersistedChatSession | undefined> =>
  page.evaluate(
    ({ projectId, sessionId }) => window.api.sessions.loadOne({ projectId, sessionId }),
    { projectId: source.projectId, sessionId: source.id }
  )

const attachText = async (page: Page, name: string, text: string): Promise<void> => {
  await page
    .locator('input[type="file"][multiple]')
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
  await expect(
    page.getByRole('button', { name: `Remove attachment ${name}`, exact: true })
  ).toBeVisible()
}

test('serializes two real windows first questions with exact attachment and reference, then restores one Discussion', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  const projectName = 'Concurrent research'
  const { page: first, source } = await seedResearch(app, projectName)
  const second = await app.openAdditionalRenderer()
  const consoleLines: string[] = []
  for (const [label, page] of [
    ['first', first],
    ['second', second]
  ] as const) {
    page.on('console', (message) =>
      consoleLines.push(`${label} ${message.type()}: ${message.text()}`)
    )
    page.on('pageerror', (error) => consoleLines.push(`${label} pageerror: ${error.message}`))
  }
  try {
    await openResearch(second, projectName)
    const before = await readSource(first, source)
    const promptsBefore = await app.readFakeAgentPrompts()
    const scope = scopeOf(source)
    expect(
      (await first.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope))
        .discussionSessionId
    ).toBeUndefined()

    const replay = first.getByTestId('replay-panel')
    await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
    await first.keyboard.press('End')
    await expect(
      replay.getByText('The recorded result is forty-two.', { exact: true })
    ).toBeVisible()
    await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    const questionA = 'Window A: explain this recorded result with my evidence.'
    const questionB = 'Window B: what assumptions does this research make?'
    const editorA = first.getByRole('textbox', { name: 'Ask anything', exact: true })
    const editorB = second.getByRole('textbox', { name: 'Ask anything', exact: true })
    await editorA.focus()
    await first.keyboard.press('ControlOrMeta+End')
    await first.keyboard.insertText(questionA)
    await attachText(first, 'window-a-evidence.txt', 'Independent evidence from window A.\n')
    await editorB.fill(questionB)
    await expect(editorA).toContainText(questionA)
    await expect(editorA).not.toContainText(questionB)
    await expect(editorB).toContainText(questionB)
    await expect(editorB).not.toContainText(questionA)
    // Waiting on actual durable drafts also detects accidental shared-key overwrites before send.
    await expect
      .poll(async () =>
        first.evaluate(async (scope) => {
          const drafts = await window.api.researchDrafts.list(scope)
          return drafts.map((draft) => ({
            id: draft.id,
            intentId: draft.payload.intentId,
            text: draft.payload.doc.nodes
              .map((node) => (node.type === 'text' ? node.text : ''))
              .join(''),
            versions: draft.payload.attachments.map((file) => file.versionId)
          }))
        }, scope)
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining(questionA),
            versions: [expect.any(String)]
          }),
          expect.objectContaining({ text: expect.stringContaining(questionB) })
        ])
      )
    const sendA = first.getByRole('button', { name: 'Send message', exact: true })
    const sendB = second.getByRole('button', { name: 'Send message', exact: true })
    await expect(sendA).toBeEnabled()
    await expect(sendB).toBeEnabled()
    await Promise.all([sendA.click(), sendB.click()])

    await expect
      .poll(
        async () =>
          first.evaluate(async (scope) => {
            const linked = await window.api.researchWorkspaces.get(scope)
            return (
              linked.discussionSession?.messages
                .filter((message) => message.role === 'user')
                .map((message) => message.content) ?? []
            )
          }, scope),
        { timeout: 90_000 }
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining(questionA),
          expect.stringContaining(questionB)
        ])
      )
    await expect
      .poll(async () => (await app.readFakeAgentPrompts()).length, { timeout: 90_000 })
      .toBe(promptsBefore.length + 2)
    await expect
      .poll(async () =>
        first.evaluate(
          async (scope) =>
            (await window.api.researchWorkspaces.get(scope)).discussionSession?.status,
          scope
        )
      )
      .toBe('idle')
    const [linkedA, linkedB, journal] = await Promise.all([
      first.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope),
      second.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope),
      first.evaluate((scope) => window.api.researchSubmissions.list(scope), scope)
    ])
    expect(linkedA.discussionSessionId).toBeTruthy()
    expect(linkedA.discussionSessionId).not.toBe(source.id)
    expect(linkedB.discussionSessionId).toBe(linkedA.discussionSessionId)
    const users = linkedA.discussionSession!.messages.filter((message) => message.role === 'user')
    expect(users).toHaveLength(2)
    expect(new Set(users.map((message) => message.id)).size).toBe(2)
    expect(journal).toHaveLength(2)
    expect(new Set(journal.map((item) => item.id)).size).toBe(2)
    expect(journal.every((item) => item.state === 'accepted')).toBe(true)
    expect(users.map((message) => message.id)).toEqual(journal.map((item) => item.messageId))
    const userA = users.find((message) => message.content.includes(questionA))!
    expect(userA.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'session', sessionId: source.id })])
    )
    expect(userA.uploads).toHaveLength(1)
    expect(userA.uploads![0]).toMatchObject({
      originalName: 'window-a-evidence.txt',
      versionId: expect.any(String)
    })
    const savedAttachment = journal.find((item) => item.payload.text.includes(questionA))!.payload
      .attachments[0]
    const preview = await first.evaluate(
      ({ projectId, attachment }) =>
        window.api.uploads.readPreview({
          projectId,
          sessionId: attachment.sessionId,
          fileId: attachment.id,
          versionId: attachment.versionId,
          path: attachment.path,
          encoding: 'utf8'
        }),
      { projectId: source.projectId, attachment: savedAttachment }
    )
    expect(preview.content).toBe('Independent evidence from window A.\n')
    const prompts = await app.readFakeAgentPrompts()
    // The fixture's role tag is inferred from the artifact route, which is also present on
    // ordinary root runs. Durable responses identify the two actual root user turns instead.
    expect(
      linkedA.discussionSession!.messages.filter(
        (message) =>
          message.role === 'agent' &&
          message.status === 'complete' &&
          users.some((user) => user.id === message.responseToMessageId)
      )
    ).toHaveLength(2)
    expect(
      prompts
        .slice(promptsBefore.length)
        .some(
          (item) => item.prompt.includes(questionA) && item.prompt.includes('Source fingerprint:')
        )
    ).toBe(true)
    expect(await readSource(first, source)).toEqual(before)
    await first.screenshot({ path: testInfo.outputPath('two-windows-one-discussion.png') })

    const restarted = await app.restart()
    await openResearch(restarted, projectName)
    const restored = await restarted.evaluate(
      (scope) => window.api.researchWorkspaces.get(scope),
      scope
    )
    expect(restored.discussionSessionId).toBe(linkedA.discussionSessionId)
    expect(
      restored.discussionSession?.messages.filter((message) => message.role === 'user')
    ).toEqual(users)
    expect(await app.readFakeAgentPrompts()).toEqual(prompts)
    expect(await readSource(restarted, source)).toEqual(before)
    await expect(
      restarted
        .getByTestId('replay-panel')
        .getByRole('button', { name: 'Play replay', exact: true })
    ).toBeVisible()
  } catch (error) {
    for (const [label, page] of [
      ['first', first],
      ['second', second]
    ] as const) {
      if (page.isClosed()) continue
      const diagnostic = await page
        .evaluate(async (scope) => {
          const read = async (operation: () => Promise<unknown>): Promise<unknown> => {
            try {
              return await operation()
            } catch (cause) {
              return { error: String(cause) }
            }
          }
          return {
            workspace: await read(() => window.api.researchWorkspaces.get(scope)),
            journal: await read(() => window.api.researchSubmissions.list(scope)),
            drafts: await read(() => window.api.researchDrafts.list(scope)),
            sessions: await read(() => window.api.sessions.loadAll())
          }
        }, scopeOf(source))
        .catch((cause) => ({ error: String(cause) }))
      await testInfo.attach(`${label}-research-state.json`, {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: 'application/json'
      })
    }
    await testInfo.attach('research-renderer-console.txt', {
      body: consoleLines.join('\n'),
      contentType: 'text/plain'
    })
    throw error
  } finally {
    if (!second.isClosed()) await second.close()
  }
})

test('recovers a real unsent research draft and attachment after a crash without invoking the model', async ({
  app
}) => {
  test.setTimeout(180_000)
  const projectName = 'Recover research draft'
  const seeded = await seedResearch(app, projectName)
  const source = seeded.source
  let page = seeded.page
  const scope = scopeOf(source)
  const before = await readSource(page, source)
  const question = 'Unsent recovery question: compare this evidence with the recorded result.'
  await page.getByRole('textbox', { name: 'Ask anything', exact: true }).fill(question)
  await attachText(page, 'recover-evidence.txt', 'Bytes retained through process termination.\n')
  await expect
    .poll(async () =>
      page.evaluate(
        async (scope) =>
          (await window.api.researchDrafts.list(scope)).filter(
            (draft) =>
              draft.payload.doc.nodes.some(
                (node) => node.type === 'text' && node.text.includes('Unsent recovery question:')
              ) && draft.payload.attachments[0]?.versionId
          ).length,
        scope
      )
    )
    .toBe(1)
  const saved = (await page.evaluate((scope) => window.api.researchDrafts.list(scope), scope)).find(
    (draft) =>
      draft.payload.doc.nodes.some(
        (node) => node.type === 'text' && node.text.includes('Unsent recovery question:')
      )
  )!
  const versionId = saved.payload.attachments[0].versionId
  const prompts = await app.readFakeAgentPrompts()
  expect(
    (await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope))
      .discussionSessionId
  ).toBeUndefined()
  page = await app.restartAfterCrash({ force: true })
  await openResearch(page, projectName)
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  await expect(editor).not.toContainText(question)
  await page.getByText('Recover saved research drafts', { exact: true }).click()
  const recovery = page
    .locator('li')
    .filter({ hasText: question })
    .filter({ has: page.getByRole('button', { name: 'Restore draft', exact: true }) })
  await expect(recovery).toHaveCount(1)
  await recovery.getByRole('button', { name: 'Restore draft', exact: true }).click()
  await expect(editor).toContainText(question)
  await expect(
    page.getByRole('button', { name: 'Remove attachment recover-evidence.txt', exact: true })
  ).toBeVisible()
  expect(await app.readFakeAgentPrompts()).toEqual(prompts)
  const recovered = (
    await page.evaluate((scope) => window.api.researchDrafts.list(scope), scope)
  ).find((draft) => draft.id === saved.id)!
  expect(recovered.payload.attachments[0].versionId).toBe(versionId)
  const preview = await page.evaluate(
    ({ projectId, attachment }) =>
      window.api.uploads.readPreview({
        projectId,
        sessionId: attachment.sessionId,
        fileId: attachment.id,
        versionId: attachment.versionId,
        path: attachment.path,
        encoding: 'utf8'
      }),
    { projectId: source.projectId, attachment: recovered.payload.attachments[0] }
  )
  expect(preview.content).toBe('Bytes retained through process termination.\n')
  expect(await readSource(page, source)).toEqual(before)
})

test('keeps a sent question uncertain after losing its acknowledgement and crashing without replaying the prompt', async ({
  app
}) => {
  test.setTimeout(180_000)
  const projectName = 'Unknown research delivery'
  const seeded = await seedResearch(app, projectName)
  const source = seeded.source
  const scope = scopeOf(source)
  let page = seeded.page
  const before = await readSource(page, source)
  const baseline = await app.readFakeAgentPrompts()
  const question = 'Check this question exactly once even when its receipt is lost.'
  await app.interruptResearchSubmissionAcknowledgement()
  await page.getByRole('textbox', { name: 'Ask anything', exact: true }).fill(question)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect
    .poll(async () => (await app.readFakeAgentPrompts()).length, { timeout: 90_000 })
    .toBe(baseline.length + 1)
  await expect
    .poll(async () =>
      page.evaluate(async (scope) => {
        const current = await window.api.researchWorkspaces.get(scope)
        return current.discussionSession?.messages.some(
          (message) => message.role === 'agent' && message.status === 'complete'
        )
      }, scope)
    )
    .toBe(true)
  const saved = (
    await page.evaluate((scope) => window.api.researchSubmissions.list(scope), scope)
  )[0]
  expect(saved.state).toBe('sending')
  const linked = await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope)
  const users = linked.discussionSession!.messages.filter((message) => message.role === 'user')
  expect(users).toHaveLength(1)
  expect(users[0]).toMatchObject({ id: saved.messageId, content: question })
  page = await app.restartAfterCrash({ force: true })
  await openResearch(page, projectName)
  const queue = page.getByRole('region', { name: 'Saved research questions', exact: true })
  await expect(
    queue.getByText('Delivery needs verification', { exact: true }).first()
  ).toBeVisible()
  await expect(queue.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  const recovered = await page.evaluate(
    (scope) => window.api.researchSubmissions.list(scope),
    scope
  )
  expect(recovered).toHaveLength(1)
  expect(recovered[0]).toMatchObject({
    id: saved.id,
    messageId: saved.messageId,
    state: 'uncertain'
  })
  // Wait for three actual dispatcher polling intervals; no request is permitted to be inferred
  // unsent from the process loss. This is an absence assertion, not a page-readiness sleep.
  await page.waitForTimeout(3200)
  expect((await app.readFakeAgentPrompts()).length).toBe(baseline.length + 1)
  const restored = await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope)
  expect(restored.discussionSessionId).toBe(linked.discussionSessionId)
  expect(restored.discussionSession!.messages.filter((message) => message.role === 'user')).toEqual(
    users
  )
  expect(await readSource(page, source)).toEqual(before)
})
