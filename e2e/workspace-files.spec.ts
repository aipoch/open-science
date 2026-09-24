import { readFile, realpath, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { sendPrompt } from './certification/helpers'

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
  await sendPrompt(page, 'Use the attached script.', 'Deterministic reply:')

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
  // File previews depend on the committed upload, not on the agent finishing its reply.
  await expect(
    page.getByRole('button', { name: `Preview uploaded attachment ${IMAGE_NAME}`, exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const image = page.getByRole('img', { name: `Preview of ${IMAGE_NAME}` })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
})

test.describe('Preview scroll isolation', () => {
  test.use({ windowMode: 'normal' })

  test('scrolls the preview without mutating the application scrollbar styles', async ({ app }) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await app.setMainWindowSize(1280, 900)
    await createProject(page)
    await page.locator('input[type="file"][multiple]').setInputFiles({
      name: 'scroll.pdf',
      mimeType: 'application/pdf',
      buffer: createTwoPagePdf()
    })
    await sendPrompt(page, 'Use the attached PDF.', 'Deterministic reply:')
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const trigger = page.getByRole('button', { name: 'Preview uploaded file scroll.pdf' })
    const body = page.locator('body')
    await expect(body).toHaveCSS('overflow-y', 'hidden')

    for (let cycle = 0; cycle < 2; cycle++) {
      await trigger.click()
      const preview = page.getByRole('dialog', { name: 'Preview scroll.pdf' })
      await expect(preview).toBeVisible()
      await expect(body).not.toHaveAttribute('data-scroll-locked')
      await expect(page.locator('#root')).toHaveAttribute('inert', '')
      const scroller = preview.getByRole('region', { name: 'scroll.pdf scrollable preview' })
      await expect
        .poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight))
        .toBeGreaterThan(100)
      const before = await scroller.evaluate((node) => node.scrollTop)
      await scroller.hover({ position: { x: 100, y: 100 } })
      await page.mouse.wheel(0, 250)
      await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(before)
      await page.keyboard.press('Tab')
      expect(await preview.evaluate((node) => node.contains(document.activeElement))).toBe(true)
      await preview.getByRole('button', { name: 'Close preview of scroll.pdf' }).click()
      await expect(preview).toBeHidden()
      await expect(page.locator('#root')).not.toHaveAttribute('inert')
      await expect(trigger).toBeFocused()
      await expect(body).toHaveCSS('overflow-y', 'hidden')
      await expect(body).not.toHaveAttribute('data-scroll-locked')
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
    }
  })
})

test('normalizes OpenCode inline thinking before publishing sanitized message images', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await app.setMainWindowSize(1024, 720)
  expect(page.url()).toMatch(/^file:/)
  await page.evaluate(async () => {
    const settings = await window.api.settings.upsertProvider({
      type: 'custom',
      name: 'Inline thinking replay',
      apiEndpoints: ['openai'],
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'MiniMax-M3',
      key: 'e2e-key',
      supportsImageInput: true
    })
    const provider = settings.providers.find((p) => p.name === 'Inline thinking replay')!
    await window.api.settings.setActiveProvider({ id: provider.id, model: 'MiniMax-M3' })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await createProject(page)
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'sanitized-performance.png',
    mimeType: 'image/png',
    buffer: await readFile('e2e/fixtures/sanitized-performance.png')
  })
  await expect(
    page.getByRole('button', { name: 'Remove attachment sanitized-performance.png' })
  ).toBeVisible()
  const prompt = 'Replay inline thinking. Render the sanitized message images.'
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  const images = page.locator(
    '[data-slot="message-scroller-content"] [data-session-artifact-image] img'
  )
  // The response text can render before the artifact references have been resolved into image
  // nodes. Wait for the turn to finish before scrolling individual figures into view.
  await expect(page.getByTestId('message-completion-live-region')).toContainText(
    'Response completed.',
    { timeout: 60_000 }
  )
  // Offscreen figures stay as placeholders until they approach the viewport.
  // Visit each figure so this also verifies decoding on smaller Windows windows.
  for (const index of [1, 2, 3]) {
    await page
      .getByText(`Synthetic figure ${index}. This image contains generated geometry only.`, {
        exact: true
      })
      .scrollIntoViewIfNeeded()
    const image = page.getByRole('img', { name: `Sanitized message figure ${index}`, exact: true })
    await image
      .or(page.getByText(`Sanitized message figure ${index}`, { exact: true }))
      .first()
      .scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        image.evaluate((img: HTMLImageElement) => ({
          complete: img.complete,
          width: img.naturalWidth,
          height: img.naturalHeight
        }))
      )
      .toEqual({ complete: true, width: 1024, height: 1024 })
  }
  await expect(images).toHaveCount(3)
  const events = await page.evaluate(async () => (await window.api.acp.getState()).events)
  expect(
    events
      .filter((e) => e.kind === 'thought')
      .map((e) => e.text)
      .join('')
  ).toContain('Synthetic reasoning only.')
  expect(
    events
      .filter((e) => e.kind === 'message' && e.role === 'assistant')
      .map((e) => e.text)
      .join('')
  ).not.toMatch(/Synthetic reasoning|<\/?think>/)
  const saved = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  const session = saved.find((s) =>
    s.messages.some((m) => m.role === 'user' && m.content.includes('Replay inline thinking.'))
  )!
  expect(
    session.messages
      .filter((m) => m.role === 'agent')
      .map((m) => m.content)
      .join('')
  ).not.toMatch(/Synthetic reasoning|<\/?think>/)
  await page.screenshot({ path: test.info().outputPath('inline-thinking-images.png') })
  page = await app.restart()
  const restored = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
  expect(
    restored
      .find((s) => s.id === session.id)
      ?.messages.filter((m) => m.role === 'agent')
      .map((m) => m.content)
      .join('')
  ).toBe(
    session.messages
      .filter((m) => m.role === 'agent')
      .map((m) => m.content)
      .join('')
  )
})

test.describe('Workspace dividers', () => {
  test.beforeEach(async ({ app }) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await createProject(page)
    const directory = await realpath(await app.createTestDirectory('resize-preview'))
    await writeFile(`${directory}/resize.txt`, 'Resize preview content')
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'Filter project files' }).click()
    await page
      .getByRole('menu', { name: 'Filter project files' })
      .getByRole('menuitemradio')
      .last()
      .click()
    const browser = page.getByLabel('Local file browser')
    // Wait for the initial Home listing to finish populating the address bar before editing it.
    const address = browser.getByLabel('Directory path')
    await expect(address).not.toHaveValue('')
    await address.fill(directory)
    await expect(address).toHaveValue(directory)
    await address.press('Enter')
    await browser
      .getByRole('list', { name: 'Directory contents' })
      .getByRole('button')
      .filter({ hasText: 'resize.txt' })
      .click()
    await expect(page.getByRole('tab').filter({ hasText: 'resize.txt' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('keeps decoded message images visible when resizing and opening their preview', async ({
    app
  }) => {
    const page = app.page
    await app.setMainWindowSize(1280, 900)
    // Exercise the normal upload and provider publication paths using generated geometry only.
    await page.locator('input[type="file"][multiple]').setInputFiles({
      name: 'sanitized-performance.png',
      mimeType: 'image/png',
      buffer: await readFile('e2e/fixtures/sanitized-performance.png')
    })
    await expect(
      page.getByRole('button', { name: 'Remove attachment sanitized-performance.png' })
    ).toBeVisible()
    await page
      .getByRole('textbox', { name: 'Ask anything' })
      .fill('Render the sanitized message images.')
    await page.getByRole('button', { name: 'Send message' }).click()
    const images = page.locator(
      '[data-slot="message-scroller-content"] [data-session-artifact-image] img'
    )
    await expect(images).toHaveCount(3)
    const image = images.last()
    await image.scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => ({
          complete: element.complete,
          width: element.naturalWidth,
          height: element.naturalHeight
        }))
      )
      .toEqual({ complete: true, width: 1024, height: 1024 })
    await expect(image).toBeInViewport({ ratio: 0.5 })
    for (const side of ['left', 'right'] as const) {
      const handle = page.getByRole('separator', { name: `Resize ${side} panel` })
      const box = (await handle.boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await expect(handle).toHaveAttribute('data-separator', /hover|focus/)
      await page.mouse.down()
      await page.mouse.move(x + (side === 'left' ? 60 : -60), y, { steps: 6 })
      await expect
        .poll(async () => Math.abs((await handle.boundingBox())!.x - box.x))
        .toBeGreaterThan(30)
      await expect(image).toBeInViewport({ ratio: 0.5 })
      await page.mouse.move(x, y, { steps: 6 })
      await page.mouse.up()
      await expect.poll(async () => (await handle.boundingBox())!.x).toBeCloseTo(box.x, 0)
    }
    await image.click()
    const modal = page.getByRole('dialog', {
      name: 'Preview sanitized-performance.png',
      exact: true
    })
    await expect(modal).toBeVisible()
    await expect
      .poll(() =>
        modal.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)
      )
      .toBe(1024)
    await modal.getByRole('button', { name: 'Close preview of sanitized-performance.png' }).click()
    await expect(modal).toBeHidden()
    await expect(image).toBeInViewport({ ratio: 0.5 })
  })

  for (const side of ['left', 'right'] as const) {
    test(`${side} divider ignores the bottom edge while a file preview is expanded`, async ({
      app
    }, testInfo) => {
      const page = app.page
      const handle = page.getByRole('separator', {
        name: `Resize ${side} panel`,
        includeHidden: true
      })
      const original = (await handle.boundingBox())!
      await page.getByRole('button', { name: 'Open full screen preview of resize.txt' }).click()
      const modal = page.getByRole('dialog', { name: 'Preview resize.txt' })
      await expect(modal).toBeVisible()
      const x = original.x + original.width / 2
      const y = original.y + original.height - 2
      await page.mouse.move(x, y)
      await expect(handle).not.toHaveAttribute('data-separator', 'hover')
      expect(
        await page.locator('body').evaluate((element) => getComputedStyle(element).cursor)
      ).not.toMatch(/resize/)
      await page.screenshot({ path: testInfo.outputPath(`${side}-modal-isolation.png`) })
      await page.mouse.down()
      await page.mouse.move(x - 60, y, { steps: 5 })
      await page.mouse.up()
      expect((await handle.boundingBox())!.x).toBeCloseTo(original.x, 0)
      // Releasing on the backdrop can dismiss the modal through its normal click behavior.
      if (await modal.isVisible()) {
        await modal.getByRole('button', { name: 'Close preview of resize.txt' }).click()
      }
      await expect(modal).toBeHidden()
      await page.mouse.move(x, y)
      await expect(handle).toHaveAttribute('data-separator', 'hover')
      await page.mouse.down()
      await page.mouse.move(x + (side === 'left' ? 60 : -60), y, { steps: 5 })
      await page.mouse.up()
      expect(Math.abs((await handle.boundingBox())!.x - original.x)).toBeGreaterThan(30)
    })

    test(`${side} workspace divider responds to arrow keys after reopening`, async ({ app }) => {
      const page = app.page
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const handle = page.getByRole('separator', { name: `Resize ${side} panel` })
      const panelName = side === 'left' ? 'sidebar' : 'preview'
      const direction = side === 'left' ? 1 : -1
      for (const reopen of [false, true]) {
        if (reopen) {
          await page.getByRole('button', { name: `Collapse ${panelName} panel` }).click()
          await expect(handle).toHaveCount(0)
          await page.getByRole('button', { name: `Expand ${panelName} panel` }).click()
        }
        await expect(handle).toBeVisible()
        const box = (await handle.boundingBox())!
        await handle.focus()
        await page.keyboard.press(side === 'left' ? 'ArrowRight' : 'ArrowLeft')
        await expect
          .poll(async () => direction * ((await handle.boundingBox())!.x - box.x), {
            timeout: 3000
          })
          .toBeGreaterThan(0)
      }
    })

    test(`${side} workspace divider shows a full-height line on hover`, async ({
      app
    }, testInfo) => {
      const page = app.page
      const handle = page.getByRole('separator', { name: `Resize ${side} panel` })
      await expect(handle).toBeVisible()
      const box = (await handle.boundingBox())!
      // Hover away from the old central tick: the divider itself should be discoverable.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4)
      await page.screenshot({ path: testInfo.outputPath(`${side}-hover.png`) })
      await expect
        .poll(() =>
          handle.evaluate((el) => {
            const line = getComputedStyle(el, '::before')
            return {
              visible: Number(line.opacity) >= 0.9,
              fullHeight: parseFloat(line.height) >= el.getBoundingClientRect().height * 0.9
            }
          })
        )
        .toEqual({ visible: true, fullHeight: true })

      await page.mouse.move(box.x + 40, box.y + box.height / 4)
      await expect
        .poll(() => handle.evaluate((el) => getComputedStyle(el, '::before').opacity))
        .toBe('0')
      await handle.focus()
      // Enter through the keyboard: programmatic focus after a mouse click is not focus-visible.
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect(handle).toBeFocused()
      await expect
        .poll(() => handle.evaluate((el) => Number(getComputedStyle(el, '::before').opacity)))
        .toBeGreaterThanOrEqual(0.9)
    })

    test(`${side} workspace divider can be dragged from either side of its edge`, async ({
      app
    }) => {
      const page = app.page
      const handle = page.getByRole('separator', { name: `Resize ${side} panel` })
      await expect(handle).toBeVisible()
      const direction = side === 'left' ? 1 : -1
      for (const offset of [-8, 8]) {
        const box = (await handle.boundingBox())!
        const x = box.x + box.width / 2 + offset
        const y = box.y + box.height / 4
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + direction * 40, y, { steps: 5 })
        await page.mouse.up()
        await expect
          .poll(async () => direction * ((await handle.boundingBox())!.x - box.x))
          .toBeGreaterThan(30)
      }
      await page
        .getByRole('button', {
          name: side === 'left' ? 'Collapse sidebar panel' : 'Collapse preview panel'
        })
        .click()
      await expect(handle).toHaveCount(0)
      await expect(
        page.getByRole('separator', { name: `Resize ${side} panel`, includeHidden: true })
      ).toHaveAttribute('data-separator', 'disabled')
    })
  }
})

test('preserves expanded uploads after saving a file version', async ({ app }, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page)

  for (let batch = 0; batch < 4; batch += 1) {
    const attachments = Array.from({ length: 10 }, (_, index) => ({
      name: `research-${String(batch * 10 + index).padStart(2, '0')}.md`,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Research notes\n\nOriginal findings.')
    }))
    await page.locator('input[type="file"][multiple]').setInputFiles(attachments)
    await expect(page.getByRole('button', { name: /^Remove attachment research-/ })).toHaveCount(10)
    await sendPrompt(page, `Keep research batch ${batch}.`, 'Deterministic reply:')
  }

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  const files = page.getByTestId('files-view')
  const rows = files.getByRole('button', { name: /^Preview uploaded file/ })
  await expect(rows).toHaveCount(20)
  await files.getByRole('button', { name: 'Load more uploaded files' }).click()
  await expect(rows).toHaveCount(40)
  const previousLabels = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')).sort()
  )
  await files
    .getByRole('button', { name: 'Preview uploaded file research-00.md', exact: true })
    .click()
  const preview = page.getByRole('dialog', { name: 'Preview research-00.md', exact: true })
  await saveTextVersion(
    preview,
    '# Research notes\n\nOriginal findings.',
    '# Research notes\n\nUpdated findings.',
    'research-00.md'
  )
  await expect(
    preview.getByTestId('managed-preview-version-navigation').getByText('v2', { exact: true })
  ).toBeVisible()
  await preview.getByRole('button', { name: 'Close preview of research-00.md' }).click()
  await expect(rows).toHaveCount(40)
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')).sort()
    )
  ).toEqual(previousLabels)
  await rows.last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('expanded-uploads-after-save.png') })
})
