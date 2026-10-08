import { expect } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { Page } from 'playwright'
import type { PdfDocumentSource } from '../src/shared/pdf-bookmarks'
import { test } from './fixtures/electron-app'
import { createProject, sendPrompt } from './certification/helpers'

const name = 'workspace-paired.pdf'
const paragraph = 'Cell growth is measured in controlled laboratory cultures.'
const translation = '测量受控实验室培养物中的细胞生长。'
const glossary = {
  source: 'PAIR_PDF_ACCEPTANCE',
  target: 'controlled workspace translation fixture'
}

async function openTranslation(page: Page, source: 'upload' | 'artifact'): Promise<void> {
  await page
    .getByRole('button', {
      name: `Preview ${source === 'upload' ? 'uploaded' : 'generated'} file ${name}`,
      exact: true
    })
    .first()
    .click()
  await page.getByRole('button', { name: /^(Full-text translation|View translation)$/ }).click()
}

for (const source of ['upload', 'artifact'] as const) {
  test(`translates and restores a workspace ${source} PDF without a literature attachment`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    const projectId = await createProject(page, `Workspace ${source} PDF translation`)
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (let number = 0; number < 2; number++)
      pdf.addPage([612, 792]).drawText(paragraph, { font, x: 40, y: 710, size: 16 })
    const bytes = Buffer.from(await pdf.save())
    if (source === 'upload') {
      await page.locator('input[type="file"][multiple]').setInputFiles({
        name,
        mimeType: 'application/pdf',
        buffer: bytes
      })
      await expect(page.getByRole('button', { name: `Remove attachment ${name}` })).toBeVisible()
      await sendPrompt(page, 'Use this workspace PDF.', 'Deterministic reply:')
    } else {
      await sendPrompt(
        page,
        `Create a workspace translation PDF.\nWORKSPACE_TRANSLATION_PDF_BASE64:${bytes.toString('base64')}`,
        'Workspace translation PDF created.',
        90_000
      )
    }
    // The uploaded Version already belongs to this Project. Opening it from a new
    // conversation must not require selecting or creating a Chat Session.
    if (source === 'upload') {
      await page.getByRole('button', { name: 'New', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
    }
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByTestId('files-view')).toBeVisible()
    await openTranslation(page, source)
    const panel = page.locator('[data-pdf-translation-sidebar]')
    await panel.getByRole('button', { name: 'Prepare full text', exact: true }).click()
    await expect(panel).toContainText('Full text prepared')
    await panel.getByRole('combobox', { name: 'Translation method' }).click()
    await page.getByRole('option', { name: 'Agent', exact: true }).click()
    await panel.getByLabel('Target language', { exact: true }).fill('Chinese')
    await panel.getByRole('button', { name: 'Translation glossary', exact: true }).click()
    await panel.getByRole('button', { name: 'Add term', exact: true }).click()
    await panel.getByLabel('Source term 1', { exact: true }).fill(glossary.source)
    await panel.getByLabel('Preferred translation 1', { exact: true }).fill(glossary.target)
    await panel.getByRole('button', { name: 'Translate document', exact: true }).click()
    await expect(
      panel.getByRole('button', { name: /Translation settings.*Text translation complete/ })
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      panel.getByRole('button', { name: 'View translated PDF', exact: true })
    ).toBeEnabled({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'View translated PDF', exact: true }).click()
    const target = page.locator('[data-pdf-translated-page]').first()
    await expect(target).toContainText(translation)
    await expect(target.locator('canvas')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`workspace-${source}-translated.png`) })

    const prompts = (await app.readFakeAgentPrompts()).filter((entry) =>
      entry.prompt.includes(glossary.source)
    )
    expect(prompts.length).toBeGreaterThan(0)
    const binding = await page.evaluate(
      async ({ projectId, source, name }) => {
        const sessions = (await window.api.sessions.loadAll()).sessions
        const session = sessions.find((value) => value.projectId === projectId)
        if (!session) throw new Error('Missing workspace file owner.')
        if (source === 'upload') {
          const attachment = session.messages
            .flatMap((message) => message.uploads ?? [])
            .find((value) => (value.originalName ?? value.name) === name)
          if (!attachment?.versionId) throw new Error('Missing immutable Upload Version.')
          const resolved = await window.api.bookmarks.resolvePdfSource({
            projectId,
            sessionId: session.id,
            sourceKind: 'upload-version',
            sourceFileId: attachment.id,
            versionId: attachment.versionId
          })
          if (!resolved.ok) throw new Error('Upload source did not resolve.')
          return resolved.source
        }
        const artifact = session.artifacts?.find((value) => value.name === name)
        if (!artifact?.artifactId || !artifact.versionId)
          throw new Error('Missing immutable Artifact Version.')
        const resolved = await window.api.bookmarks.resolvePdfSource({
          projectId,
          sessionId: session.id,
          sourceKind: 'artifact-version',
          sourceFileId: artifact.artifactId,
          versionId: artifact.versionId
        })
        if (!resolved.ok) throw new Error('Artifact source did not resolve.')
        return resolved.source
      },
      { projectId, source, name }
    )
    const checkpoint = await page.evaluate(
      (binding) => window.api.pdfTranslation!.readCheckpoint(binding),
      binding as PdfDocumentSource
    )
    expect(checkpoint).toMatchObject({
      documentSource: binding,
      translations: [translation, translation]
    })
    expect(checkpoint).not.toHaveProperty('attachmentVersionId')

    const previewHeader = source === 'artifact' ? page.getByTestId('preview-card-header') : page
    await previewHeader
      .getByRole('button', { name: `Close preview of ${name}`, exact: true })
      .click()
    await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
    await openTranslation(page, source)
    await expect(
      panel.getByRole('button', { name: /Translation settings.*Text translation complete/ })
    ).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole('button', { name: 'Compare PDFs', exact: true })).toBeEnabled({
      timeout: 60_000
    })
    await panel.getByRole('button', { name: 'Compare PDFs', exact: true }).click()
    await expect(page.locator('[data-page-number="1"] canvas')).toHaveCount(2)
    expect(
      (await app.readFakeAgentPrompts()).filter((entry) => entry.prompt.includes(glossary.source))
    ).toHaveLength(prompts.length)
    await page.screenshot({ path: testInfo.outputPath(`workspace-${source}-restored.png`) })
  })
}
