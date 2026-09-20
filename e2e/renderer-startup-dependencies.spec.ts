import { expect, type Page } from '@playwright/test'
import type { ConversationSkillImportApprovalRequest } from '../src/shared/settings'
import { test, type ElectronApp } from './fixtures/electron-app'

const resourceName = (url: string): string => new URL(url).pathname.split('/').at(-1) ?? url

// Each surface gets a fresh renderer so another dialog cannot warm its Markdown dependencies.
const prepareHome = async (
  app: ElectronApp
): Promise<{ page: Page; requestedResources: Set<string> }> => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const requestedResources = new Set<string>()
  page.on('request', (request) => requestedResources.add(resourceName(request.url())))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
      )
  )
  expect(
    [...requestedResources].filter((resource) =>
      /^(?:AgentMarkdown|GlobalSearchDialog|SkillImportApprovalDialog|UpdateDialog|table-data-runtime)-.*\.js$/u.test(
        resource
      )
    )
  ).toEqual([])
  return { page, requestedResources }
}

const skillRequest = (id: string, name: string): ConversationSkillImportApprovalRequest => ({
  id,
  sessionId: 'session-1',
  source: { kind: 'attachment' as const, label: 'deferred.skill' },
  previews: [
    {
      subPath: '.',
      name,
      description: 'Lazy approval boundary fixture',
      metadata: {},
      body: `# ${name}`,
      files: ['SKILL.md'],
      alreadyImported: false
    }
  ],
  skipped: []
})

test('loads Skill approval on first request and preserves queued and subsequent approvals', async ({
  app
}) => {
  const { page, requestedResources } = await prepareHome(app)
  await app.emitSkillImportApprovalRequest(skillRequest('first-import', 'First Skill'))
  await app.emitSkillImportApprovalRequest(skillRequest('second-import', 'Second Skill'))
  const dialog = page.getByRole('dialog', { name: 'Import Skill package?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('First Skill')
  await expect
    .poll(() => [...requestedResources])
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^AgentMarkdown-.*\.js$/),
        expect.stringMatching(/^SkillImportApprovalDialog-.*\.js$/)
      ])
    )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toContainText('Second Skill')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await app.emitSkillImportApprovalRequest(skillRequest('third-import', 'Third Skill'))
  await expect(dialog).toContainText('Third Skill')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled()
})

test('loads Search on first activation and restores input focus on reopen', async ({ app }) => {
  const { page, requestedResources } = await prepareHome(app)
  const searchButton = page.getByRole('button', { name: 'Search', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  const input = dialog.getByRole('combobox', { name: 'Global search' })
  for (let attempt = 0; attempt < 2; attempt++) {
    await searchButton.click()
    await expect(dialog).toBeVisible()
    await expect(input).toBeFocused()
    await expect
      .poll(() => [...requestedResources])
      .toEqual(expect.arrayContaining([expect.stringMatching(/^GlobalSearchDialog-.*\.js$/)]))
    await input.fill('no-matching-startup-fixture')
    await input.press('Escape')
    await expect(dialog).toBeHidden()
  }
})

test('loads update notes on first activation and shows fresh status after reopening', async ({
  app
}) => {
  const { page, requestedResources } = await prepareHome(app)
  for (const [latest, notes] of [
    ['0.32.0', 'First release notes'],
    ['0.33.0', 'Refreshed release notes']
  ]) {
    await app.emitUpdateStatus({
      state: 'available',
      current: '0.31.1',
      latest,
      notes: `## ${notes}`
    })
    const capsule = page.getByRole('button', { name: `New version: Update (v${latest})` })
    await expect(capsule).toBeVisible()
    await capsule.click()
    const dialog = page.getByRole('dialog', { name: 'Update available' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(notes)
    await expect
      .poll(() => [...requestedResources])
      .toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^AgentMarkdown-.*\.js$/),
          expect.stringMatching(/^UpdateDialog-.*\.js$/)
        ])
      )
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
})
