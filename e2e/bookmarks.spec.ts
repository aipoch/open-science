import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('keeps a private text bookmark after restart and allows editing and deleting it', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Private bookmarks journey')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const prompt = 'Summarize the deterministic fixture.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  const reply = page.getByText(`Deterministic reply: ${prompt}`, { exact: false }).first()
  await expect(reply).toBeVisible()
  await expect(page.getByText('Response completed.', { exact: true })).toBeVisible()
  await reply.dblclick({ position: { x: 20, y: 10 } })
  await page.getByRole('button', { name: 'Annotate', exact: true }).click()
  await page.screenshot({ path: 'test-results/annotate-editor.png' })
  await page.getByRole('tab', { name: 'For me', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Note (optional)', exact: true })
    .fill('Use in discussion')
  await page.screenshot({ path: 'test-results/bookmarks-editor.png' })
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click()
  await page.getByRole('button', { name: /^Bookmarks \(\d+\)$/ }).click()
  await expect(page.getByText('Use in discussion', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/bookmarks-list.png' })

  await page.keyboard.press('Escape')
  await page.locator('[data-bookmark-marker]').click()
  await page
    .getByRole('textbox', { name: 'Bookmark note', exact: true })
    .fill('Edited from highlight')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Bookmark note', exact: true })).toHaveCount(0)

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /Summarize the deterministic fixture/ })
    .click()
  await page.getByRole('button', { name: /^Bookmarks \(\d+\)$/ }).click()
  await expect(page.getByText('Edited from highlight', { exact: true })).toBeVisible()
  await page
    .getByRole('region', { name: 'Bookmarks', exact: true })
    .getByRole('button', { name: 'Edit bookmark note', exact: true })
    .click()
  await page
    .getByRole('textbox', { name: 'Bookmark note', exact: true })
    .fill('Checked after restart')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Checked after restart', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('[data-bookmark-marker]').click()
  await page.getByRole('button', { name: 'Delete bookmark', exact: true }).click()
  await expect(page.getByText('Checked after restart', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Bookmarks \(\d+\)$/ })).toHaveCount(0)
})

test('reveals an older bookmarked line on first session entry without manual scrolling', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const cwd = await app.createTestDirectory('bookmark-jump')
  await page.evaluate(
    async ({ cwd }) => {
      const project = await window.api.projects.create({ name: 'Bookmark jump', description: '' })
      const now = Date.now()
      const messages = Array.from({ length: 100 }, (_, index) => ({
        id: `bookmark-message-${index}`,
        role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
        content:
          index === 1
            ? 'First paragraph.\n\nBookmark jump sentinel.\n\nLast paragraph.'
            : `Message ${index}. ` + 'Research evidence. '.repeat(30),
        status: 'complete' as const,
        eventIds: [],
        createdAt: now + index,
        updatedAt: now + index
      }))
      await window.api.sessions.saveSession({
        id: 'bookmark-jump-session',
        projectId: project.id,
        title: 'Bookmark first entry',
        cwd,
        status: 'idle',
        messages,
        createdAt: now,
        updatedAt: now
      })
      await window.api.bookmarks.create({
        id: 'bookmark-jump',
        projectId: project.id,
        sessionId: 'bookmark-jump-session',
        note: 'Jump here',
        target: {
          kind: 'text',
          quote: 'Bookmark jump sentinel.',
          source: {
            kind: 'agent-message',
            sessionId: 'bookmark-jump-session',
            messageId: 'bookmark-message-1'
          }
        }
      })
    },
    { cwd }
  )
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /Bookmark first entry/ })
    .click()
  await page.getByRole('button', { name: 'Bookmarks (1)', exact: true }).click()
  await page.getByRole('button', { name: 'Show bookmark source', exact: true }).click()
  const quote = page
    .locator('[data-annotation-surface] p')
    .filter({ hasText: 'Bookmark jump sentinel.' })
  await expect(quote).toBeInViewport()
  await expect(
    page.getByRole('region', { name: 'Bookmarks', exact: true }).getByRole('alert')
  ).toHaveCount(0)
})
