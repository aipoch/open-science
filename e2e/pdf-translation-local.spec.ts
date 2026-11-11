import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import { expect } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PdfTranslationBeginRequest } from '../src/shared/pdf-translation'
import { test } from './fixtures/electron-app'

const sources = ['The sky is blue.', 'Water is a liquid.']

test('rejects unopened local translation and model installation through Electron', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await expect(
    page.evaluate(() => window.api.localModels.install('pdf-translation'))
  ).rejects.toThrow('Local translation is unavailable.')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const source of sources)
    pdf.addPage([612, 792]).drawText(source, { font, x: 40, y: 710, size: 12 })
  const attachmentVersionId = await page.evaluate(
    async ({ bytes, item }) => {
      const created = await window.api.literature.transact({ kind: 'create-item', item })
      const transferId = crypto.randomUUID()
      const chunk = new Uint8Array(bytes)
      await window.api.uploads.beginTransfer({
        transferId,
        name: 'local-translation.pdf',
        mimeType: 'application/pdf',
        size: chunk.length
      })
      await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
      const attachment = await window.api.uploads.finishTransfer({ transferId })
      const imported = await window.api.literature.importPdf({ itemId: created.id, attachment })
      return imported.item.attachments[0].versions[0].id
    },
    {
      bytes: [...(await pdf.save())],
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Unavailable local translation'
      })
    }
  )
  const request: PdfTranslationBeginRequest = {
    resourceRequestKey: attachmentVersionId,
    attachmentVersionId,
    fingerprint: 'local-onnx-smoke-v1',
    targetId: 'local',
    language: 'Chinese',
    glossary: [],
    batchShortSources: false,
    sources
  }
  await expect(
    page.evaluate((request) => window.api.pdfTranslation!.begin(request), request)
  ).rejects.toThrow('[pdf-translation:unsupported-model]')
  expect(
    await page.evaluate((id) => window.api.pdfTranslation!.readCheckpoint(id), attachmentVersionId)
  ).toBeNull()
  expect(
    await page.evaluate(() => window.api.localModels.getSnapshot('pdf-translation'))
  ).toMatchObject({ availability: 'notInstalled', hasFiles: false, inUse: false })
})
