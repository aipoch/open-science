import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Project files journey'
const FILE_NAME = 'research-notes.md'
const FILE_CONTENT = '# Fixture findings\n\nDeterministic preview content.'
const IMAGE_NAME = 'preview.png'
const IMAGE_CONTENT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('uploads an attachment and previews it from Project files', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
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
  await preview.getByRole('button', { name: `Close preview of ${FILE_NAME}` }).click()
  await expect(preview).toBeHidden()
})

test('loads managed image previews from Project files', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
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
