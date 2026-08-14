import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Project files journey'
const FILE_NAME = 'research-notes.md'
const FILE_CONTENT = '# Fixture findings\n\nDeterministic preview content.'
const IMAGE_NAME = 'preview.png'
const IMAGE_CONTENT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const VERSION_TWO_CONTENT = '# Fixture findings\n\nFirst edited version.'
const VERSION_THREE_CONTENT = '# Fixture findings\n\nSecond edited version.'

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

const saveTextVersion = async (
  preview: Locator,
  baseline: string,
  nextContent: string
): Promise<void> => {
  await preview.getByRole('button', { name: `Edit ${FILE_NAME}` }).click()
  const editor = preview.getByRole('textbox', { name: `Edit ${FILE_NAME} source` })
  await expect(editor).toHaveValue(baseline)
  await editor.fill(nextContent)
  await preview.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
}

test('edits uploaded Markdown versions and keeps diff navigation coherent', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: FILE_NAME,
    mimeType: 'text/markdown',
    buffer: Buffer.from(FILE_CONTENT)
  })
  await expect(page.getByRole('button', { name: `Remove attachment ${FILE_NAME}` })).toBeVisible()

  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Use the attached research notes.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByTestId('files-view')).toBeVisible()
  await page.getByRole('button', { name: `Preview uploaded file ${FILE_NAME}` }).click()

  const preview = page.getByRole('dialog', { name: `Preview ${FILE_NAME}` })
  await expect(preview).toBeVisible()
  await expect(preview.getByText('Fixture findings', { exact: true })).toBeVisible()
  await expect(preview.getByText('Deterministic preview content.', { exact: true })).toBeVisible()

  // Three immutable versions let this journey prove that an active diff follows version changes.
  const versionNavigation = preview.getByTestId('managed-preview-version-navigation')
  await saveTextVersion(preview, FILE_CONTENT, VERSION_TWO_CONTENT)
  await expect(versionNavigation.getByText('v2', { exact: true })).toBeVisible()
  await expect(preview.getByText('First edited version.', { exact: true })).toBeVisible()

  await saveTextVersion(preview, VERSION_TWO_CONTENT, VERSION_THREE_CONTENT)
  await expect(versionNavigation.getByText('v3', { exact: true })).toBeVisible()
  await expect(preview.getByText('Second edited version.', { exact: true })).toBeVisible()

  await preview
    .getByRole('button', { name: `Compare ${FILE_NAME} with its source version` })
    .click()
  const differences = preview.getByRole('region', { name: 'File version differences' })
  await expect(
    differences.locator('[data-diff-kind="removed"]').filter({ hasText: 'First edited version.' })
  ).toBeVisible()
  await expect(
    differences.locator('[data-diff-kind="added"]').filter({ hasText: 'Second edited version.' })
  ).toBeVisible()

  await versionNavigation.getByRole('button', { name: 'Previous file version' }).click()
  await expect(versionNavigation.getByText('v2', { exact: true })).toBeVisible()
  await expect(preview.getByRole('button', { name: `Stop comparing ${FILE_NAME}` })).toBeVisible()
  await expect(
    differences
      .locator('[data-diff-kind="removed"]')
      .filter({ hasText: 'Deterministic preview content.' })
  ).toBeVisible()
  await expect(
    differences.locator('[data-diff-kind="added"]').filter({ hasText: 'First edited version.' })
  ).toBeVisible()

  await preview.getByRole('button', { name: `Stop comparing ${FILE_NAME}` }).click()
  await expect(differences).toBeHidden()
  await expect(preview.getByText('First edited version.', { exact: true })).toBeVisible()
  await versionNavigation.getByRole('button', { name: 'Previous file version' }).click()
  await expect(versionNavigation.getByText('v1', { exact: true })).toBeVisible()
  await expect(preview.getByText('Deterministic preview content.', { exact: true })).toBeVisible()
  await expect(preview.locator('[data-diff-kind]')).toHaveCount(0)

  await preview.getByRole('button', { name: `Close preview of ${FILE_NAME}` }).click()
  await expect(preview).toBeHidden()
})

test('loads managed image previews from Project files', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: IMAGE_NAME,
    mimeType: 'image/png',
    buffer: IMAGE_CONTENT
  })
  await expect(page.getByRole('button', { name: `Remove attachment ${IMAGE_NAME}` })).toBeVisible()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Use the attached image.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const image = page.getByRole('img', { name: `Preview of ${IMAGE_NAME}` })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
})
