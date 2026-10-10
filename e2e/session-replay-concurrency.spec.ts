import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test, type ElectronApp } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import { askReplayStep } from './helpers/research-replay'
import type { PersistedChatSession } from '../src/shared/session-persistence'

// Use real renderer windows, IPC and ordinary composer drafts; no provider is invoked while staging.
test.use({ windowMode: 'normal' })

const openResearch = async (page: Page, projectName: string): Promise<void> => {
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await page
    .getByTestId('research-workspace-header')
    .getByRole('button', { name: 'View replay', exact: true })
    .click()
  await expect(page.getByTestId('replay-panel')).toBeVisible()
  await expect(page.getByTestId('research-workspace-header')).toContainText(
    'Original record · Read-only'
  )
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

test('stages the same archive independently in two windows without creating or sending a Discussion', async ({
  app
}) => {
  const projectName = 'Independent replay questions'
  const { page: first, source } = await seedResearch(app, projectName)
  const second = await app.openAdditionalRenderer()
  await openResearch(second, projectName)
  const baseline = await app.readFakeAgentPrompts()
  for (const [page, question] of [
    [first, 'First independent question.'],
    [second, 'Second independent question.']
  ] as const) {
    await askReplayStep(page.getByTestId('replay-panel'))
    await expect(page.getByRole('dialog', { name: 'Ask in a conversation' })).toHaveCount(0)
    const editor = page.getByRole('textbox', { name: 'Ask anything', exact: true })
    await expect(page.locator('[data-session-discussion-source]').last()).toContainText(
      source.title
    )
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText(question)
  }
  await expect(first.getByRole('textbox', { name: 'Ask anything', exact: true })).toContainText(
    'First independent question.'
  )
  await expect(first.getByRole('textbox', { name: 'Ask anything', exact: true })).not.toContainText(
    'Second independent question.'
  )
  expect(await app.readFakeAgentPrompts()).toEqual(baseline)
  const sessions = await first.evaluate(
    async (projectId) =>
      (await window.api.sessions.loadAll()).sessions.filter((row) => row.projectId === projectId),
    source.projectId
  )
  expect(sessions).toHaveLength(1)
  expect(sessions[0].packageOrigin).toEqual(source.packageOrigin)
})
