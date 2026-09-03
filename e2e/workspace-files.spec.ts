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
const VERSION_THREE_CONTENT = '## Fixture findings\n\nSecond edited version.'
const SCRIPT_NAME = 'analysis.sh'
const SCRIPT_CONTENT = '#!/bin/bash\n# stable\necho "old"\n'
const SCRIPT_VERSION_TWO_CONTENT = '#!/bin/bash\n# stable\necho "new"\n'

const createTwoPagePdf = (): Buffer => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'
  ]
  const offsets: number[] = []
  let body = '%PDF-1.4\n'
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body)
  const xref = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')
  return Buffer.from(
    `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  )
}

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
  nextContent: string,
  fileName = FILE_NAME
): Promise<void> => {
  await preview.getByRole('button', { name: `Edit ${fileName}` }).click()
  const editor = preview.getByRole('textbox', { name: `Edit ${fileName} source` })
  await expect(editor).toHaveValue(baseline)
  const saveButton = preview.getByRole('button', { name: 'Save changes' })
  await expect(preview.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(saveButton).toHaveText('Save')
  await expect(saveButton.locator('svg')).toHaveCount(0)
  await expect(preview.getByRole('button', { name: `Download ${fileName}` })).toHaveCount(0)
  await expect(preview.getByRole('button', { name: `Close preview of ${fileName}` })).toHaveCount(0)
  await editor.fill(nextContent)
  await saveButton.click()
  await expect(editor).toBeHidden()
  await expect(preview.getByRole('button', { name: `Download ${fileName}` })).toBeVisible()
  await expect(preview.getByRole('button', { name: `Close preview of ${fileName}` })).toBeVisible()
}

const visibleChangeTextContents = async (changes: Locator): Promise<string[]> =>
  changes.evaluateAll((elements) =>
    elements.map((element) => {
      const copy = element.cloneNode(true) as HTMLElement
      copy.querySelectorAll('.sr-only').forEach((label) => label.remove())
      return copy.textContent ?? ''
    })
  )

const reconstructedDiffText = async (
  container: Locator
): Promise<{ before: string; after: string }> =>
  container.evaluate((element) => {
    const textWithout = (selector: string): string => {
      const copy = element.cloneNode(true) as HTMLElement
      copy.querySelectorAll('.sr-only').forEach((label) => label.remove())
      copy.querySelectorAll(selector).forEach((change) => change.remove())
      return copy.textContent ?? ''
    }
    return {
      before: textWithout('ins[data-managed-diff="added"]'),
      after: textWithout('del[data-managed-diff="removed"]')
    }
  })

test('edits uploaded Markdown versions and keeps diff navigation coherent', async ({ app }) => {
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
  await expect(differences.getByRole('heading', { name: 'Fixture findings' })).toHaveCount(0)
  const rawHeading = differences.locator('[data-diff-kind="mixed"] pre').filter({
    hasText: 'Fixture findings'
  })
  const rawHeadingAdded = rawHeading.locator('ins[data-managed-diff="added"]')
  await expect(rawHeading).toBeVisible()
  expect(await visibleChangeTextContents(rawHeadingAdded)).toEqual(['#'])
  expect(
    await rawHeading.evaluate((element) => {
      const copy = element.cloneNode(true) as HTMLElement
      copy.querySelectorAll('.sr-only').forEach((label) => label.remove())
      return copy.textContent
    })
  ).toBe('## Fixture findings')
  expect(
    await rawHeading.evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor)
  ).toBe('rgba(0, 0, 0, 0)')
  const removedChange = differences.locator('p del[data-managed-diff="removed"]')
  const addedChange = differences.locator('p ins[data-managed-diff="added"]')
  await expect(removedChange).toBeVisible()
  await expect(addedChange).toBeVisible()
  expect(await visibleChangeTextContents(removedChange)).toEqual(['First'])
  expect(await visibleChangeTextContents(addedChange)).toEqual(['Second'])
  await expect(removedChange.locator('.sr-only')).toHaveText('Removed:')
  await expect(addedChange.locator('.sr-only')).toHaveText('Added:')
  expect(
    await removedChange.evaluate(
      (element) =>
        getComputedStyle(element.closest<HTMLElement>('[data-diff-kind]')!).backgroundColor
    )
  ).toBe('rgba(0, 0, 0, 0)')
  const diffColors = await differences.evaluate((region) => {
    const added = getComputedStyle(region.querySelector<HTMLElement>('p ins')!)
    const removed = getComputedStyle(region.querySelector<HTMLElement>('p del')!)
    return {
      addedBackground: added.backgroundColor,
      removedBackground: removed.backgroundColor,
      addedDecoration: added.textDecorationLine,
      removedDecoration: removed.textDecorationLine
    }
  })
  expect(diffColors.addedBackground).not.toBe(diffColors.removedBackground)
  expect(diffColors.addedBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(diffColors.removedBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(diffColors.addedDecoration).not.toContain('underline')
  expect(diffColors.removedDecoration).toContain('line-through')
  await versionNavigation.getByRole('button', { name: 'Previous file version' }).click()
  await expect(versionNavigation.getByText('v2', { exact: true })).toBeVisible()
  await expect(preview.getByRole('button', { name: `Stop comparing ${FILE_NAME}` })).toBeVisible()
  await expect(differences.getByRole('heading', { name: 'Fixture findings' })).toBeVisible()
  const versionTwoParagraph = differences.locator(
    'p:has(del[data-managed-diff="removed"]):has(ins[data-managed-diff="added"])'
  )
  await expect(versionTwoParagraph).toBeVisible()
  expect(await reconstructedDiffText(versionTwoParagraph)).toEqual({
    before: 'Deterministic preview content.',
    after: 'First edited version.'
  })

  await versionNavigation.getByRole('button', { name: 'Previous file version' }).click()
  await expect(versionNavigation.getByText('v1', { exact: true })).toBeVisible()
  await expect(preview.getByRole('button', { name: `Stop comparing ${FILE_NAME}` })).toBeVisible()
  await expect(differences).toBeHidden()
  await expect(preview.getByText('Deterministic preview content.', { exact: true })).toBeVisible()
  await expect(preview.locator('[data-diff-kind]')).toHaveCount(0)

  await versionNavigation.getByRole('button', { name: 'Next file version' }).click()
  await expect(versionNavigation.getByText('v2', { exact: true })).toBeVisible()
  await expect(preview.getByRole('button', { name: `Stop comparing ${FILE_NAME}` })).toBeVisible()
  await expect(differences).toBeVisible()
  await expect(versionTwoParagraph).toBeVisible()
  expect(await reconstructedDiffText(versionTwoParagraph)).toEqual({
    before: 'Deterministic preview content.',
    after: 'First edited version.'
  })

  await preview.getByRole('button', { name: `Close preview of ${FILE_NAME}` }).click()
  await expect(preview).toBeHidden()
})

test('links a multi-page PDF upload as Reading context in a new project', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    buffer: createTwoPagePdf()
  })
  await expect(page.getByTestId('automatic-reading-suggestion')).toContainText(
    '1 PDF will be linked when sent'
  )

  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Summarize the attached paper.')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByTestId('pdf-context-bar')).toContainText('paper.pdf')
  await expect(page.getByRole('button', { name: 'Page 1 of 2' })).toBeVisible()
  await expect(page.getByText('PDF context Version is unavailable in this Project.')).toHaveCount(0)
  await expect(page.getByText('Managed file reference requires a logical identity.')).toHaveCount(0)
})

test('shows structured text replacements with character-level highlights', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: SCRIPT_NAME,
    mimeType: 'text/x-shellscript',
    buffer: Buffer.from(SCRIPT_CONTENT)
  })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Use the attached script.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: `Preview uploaded file ${SCRIPT_NAME}` }).click()
  const preview = page.getByRole('dialog', { name: `Preview ${SCRIPT_NAME}` })
  await saveTextVersion(preview, SCRIPT_CONTENT, SCRIPT_VERSION_TWO_CONTENT, SCRIPT_NAME)

  await preview
    .getByRole('button', { name: `Compare ${SCRIPT_NAME} with its source version` })
    .click()
  const differences = preview.getByRole('region', { name: 'File version differences' })
  const mixedLine = differences.locator('[data-diff-kind="mixed"]')
  const removedText = mixedLine.locator('del[data-diff-segment="removed"]')
  const addedText = mixedLine.locator('ins[data-diff-segment="added"]')
  await expect(removedText.locator('[data-managed-diff-content]')).toHaveText('old')
  await expect(addedText.locator('[data-managed-diff-content]')).toHaveText('new')
  await expect(removedText.locator('.sr-only')).toHaveText('Removed:')
  await expect(addedText.locator('.sr-only')).toHaveText('Added:')
  await expect(mixedLine.locator('pre > span')).toHaveText(['echo "', '"'])
  await expect(mixedLine).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(differences.locator('[data-diff-kind="removed"]')).toHaveCount(0)
  await expect(differences.locator('[data-diff-kind="added"]')).toHaveCount(0)
  await expect(differences.getByTestId('source-line-number')).toHaveCount(0)
  await expect(
    differences.locator('[aria-label="Added line"], [aria-label="Removed line"]')
  ).toHaveCount(0)
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
