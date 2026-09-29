import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { createProject } from './certification/helpers'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

const sourceFixture = (projectId: string, suffix: 'a' | 'b'): PersistedChatSession => ({
  id: `import-navigation-${suffix}`,
  projectId,
  title: `Navigation research ${suffix.toUpperCase()}`,
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: suffix === 'a' ? 4 : 3,
  messages: [
    {
      id: `question-${suffix}`,
      role: 'user',
      content: `What is recorded in research ${suffix.toUpperCase()}?`,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: `answer-${suffix}`,
      role: 'agent',
      content: `Research ${suffix.toUpperCase()} retained its own recorded result.`,
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 3
    }
  ],
  packageOrigin: {
    importId:
      suffix === 'a'
        ? '2b13c144-2a80-4b51-b22f-ae5bcb57a07a'
        : '5a675f26-9826-46cc-9136-e98bb33149dd',
    importedAt: 5,
    manifestChecksum: suffix.repeat(64),
    sourceProjectId: 'original-project',
    sourceSessionId: `original-session-${suffix}`
  }
})

const sessionRow = (page: Page, title: string): Locator =>
  page.locator('[data-slot="session-open-button"]').filter({ hasText: title })

const replayTab = (page: Page, sourceId: string): Locator =>
  page.locator(`[id="preview-tab-${encodeURIComponent(`tool:${sourceId}:replay`)}"]`)

test('keeps research drafts and sent references scoped across navigation, archive, restore and source deletion', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectName = 'Research navigation'
  const projectId = await createProject(page, projectName)
  const sourceA = sourceFixture(projectId, 'a')
  const sourceB = sourceFixture(projectId, 'b')
  await app.restartWithSessionFixture(sourceA)
  page = await app.restartWithSessionFixture(sourceB)
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
  const notice = page.getByRole('region', { name: 'Research discussion', exact: true })
  const replay = page.locator('[data-testid="replay-panel"]:visible')
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
  const originalPromptCount = (await app.readFakeAgentPrompts()).length
  const draftA = 'Keep this unsent question in research A.'

  await sessionRow(page, sourceA.title).click()
  await expect(notice).toContainText(`Discussing ${sourceA.title}`)
  await editor.fill(draftA)
  await sessionRow(page, sourceB.title).click()
  await expect(notice).toContainText(`Discussing ${sourceB.title}`)
  await expect(editor).not.toContainText(draftA)
  await sessionRow(page, sourceA.title).click()
  await expect(editor).toHaveText(draftA)
  // A preview tab is independent from left-side navigation. Ask intentionally joins them again.
  await replayTab(page, sourceB.id).click()
  await expect(notice).toContainText(`Discussing ${sourceA.title}`)
  await expect(replay).toContainText(sourceB.title)
  await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
  await page.keyboard.press('End')
  await replay.getByRole('button', { name: 'Ask about this step', exact: true }).click()
  await expect(notice).toContainText(`Discussing ${sourceB.title}`)
  await expect(editor).toContainText(sourceB.title)
  await expect(
    page.getByRole('button', { name: 'Show annotation source', exact: true })
  ).toBeVisible()
  await expect(editor).not.toContainText(draftA)
  await sessionRow(page, sourceA.title).click()
  await expect(editor).toHaveText(draftA)
  await sessionRow(page, sourceB.title).click()
  await expect(editor).toContainText(sourceB.title)
  await expect(
    page.getByRole('button', { name: 'Show annotation source', exact: true })
  ).toBeVisible()
  expect((await app.readFakeAgentPrompts()).length).toBe(originalPromptCount)

  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('Explain the recorded result in B.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(conversation).toContainText('Deterministic reply:')
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  const scope = { projectId, sourceSessionId: sourceB.id }
  const linked = await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope)
  expect(linked.discussionSessionId).toBeTruthy()
  const discussionId = linked.discussionSessionId!
  const discussion = await page.evaluate((input) => window.api.sessions.loadOne(input), {
    projectId,
    sessionId: discussionId
  })
  expect(discussion).toBeTruthy()
  const sentReference = conversation.getByRole('button', {
    name: 'Show annotation source',
    exact: true
  })
  await expect(sentReference).toHaveCount(1)
  await editor.fill('Another unsent thought in B.')
  await replayTab(page, sourceA.id).click()
  await expect(replay).toContainText(sourceA.title)
  await sentReference.click()
  await expect(replay).toContainText(sourceB.title)
  await expect(replay.getByRole('slider', { name: 'Replay progress', exact: true })).toHaveValue(
    '5000'
  )
  await expect(notice).toContainText(`Discussing ${sourceB.title}`)
  await expect(editor).toHaveText('Another unsent thought in B.')
  await expect(conversation).toContainText('Explain the recorded result in B.')
  await page.screenshot({
    path: testInfo.outputPath('sent-reference-preserves-left-discussion.png')
  })

  await page.getByRole('button', { name: `Open actions for ${sourceB.title}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
  const undo = page.getByTestId('archive-undo-snackbar')
  await expect(undo).toContainText('Archived session')
  await expect(sessionRow(page, sourceB.title).filter({ hasText: discussion!.title })).toHaveCount(
    1
  )
  await sessionRow(page, sourceA.title).click()
  await expect(editor).toHaveText(draftA)
  await sessionRow(page, discussion!.title).click()
  await expect(sessionRow(page, discussion!.title)).toHaveAttribute('aria-current', 'page')
  await expect(notice).toContainText(`Discussing ${sourceB.title}`)
  await expect(editor).toBeEditable()
  await editor.fill('Can I discuss B while its source is archived?')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(conversation.getByText(/Deterministic reply:/)).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0)
  await undo.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(sessionRow(page, discussion!.title)).toHaveCount(0)
  await expect(sessionRow(page, sourceB.title)).toHaveCount(1)
  await sessionRow(page, sourceB.title).click()
  await expect(conversation).toContainText('Can I discuss B while its source is archived?')
  const restored = await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope)
  expect(restored.sourceStatus).toBe('available')
  expect(restored.discussionSessionId).toBe(discussionId)

  await page.getByRole('button', { name: `Open actions for ${sourceB.title}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Delete Session?' })
  await expect(confirmation).toContainText(sourceB.title)
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirmation).toBeHidden()
  await sessionRow(page, discussion!.title).click()
  await expect(sessionRow(page, discussion!.title)).toHaveAttribute('aria-current', 'page')
  await expect(notice).toContainText('The source research is unavailable.')
  await expect(conversation).toContainText('Explain the recorded result in B.')
  await expect(conversation).toContainText('Can I discuss B while its source is archived?')
  await expect(sentReference).toHaveCount(1)
  await sentReference.click()
  await expect(page.getByText('The source research is unavailable.', { exact: true })).toHaveCount(
    2
  )
  const missing = await page.evaluate((scope) => window.api.researchWorkspaces.get(scope), scope)
  expect(missing.sourceStatus).toBe('missing')
  expect(missing.discussionStatus).toBe('available')
  expect(missing.discussionSessionId).toBe(discussionId)
  expect((await app.readFakeAgentPrompts()).length).toBe(originalPromptCount + 2)
  await page.screenshot({ path: testInfo.outputPath('deleted-source-retained-discussion.png') })
  await sessionRow(page, sourceA.title).click()
  await expect(editor).toHaveText(draftA)
})
