import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '@aipoch/pdf-translation/writer'
import { pdfTranslationWorkerPath } from '@aipoch/pdf-translation/resources'
import { stat } from 'node:fs/promises'

assert.ok((await stat(pdfTranslationWorkerPath())).isFile())
const original = await PDFDocument.create()
const font = await original.embedFont(StandardFonts.Helvetica)
original.addPage([400, 300]).drawText('Cell growth is measured.', { font, size: 12, x: 30, y: 250 })
const data = await original.save()
const writer = new PdfTranslationWriter()
const controller = new AbortController()
const caller = {
  leaseId: 'packed-consumer',
  generation: 1,
  signal: controller.signal,
  isCurrent: () => !controller.signal.aborted
}
const request = {
  id: 'packed-output',
  data,
  pages: [{ width: 400, height: 300 }],
  units: [
    {
      source: 'Cell growth is measured.',
      translation: '测量细胞生长。',
      fragments: [{ pageNumber: 1, rect: { x: 0.06, y: 0.1, width: 0.88, height: 0.18 } }]
    }
  ]
}
const result = await writer.generateDetailed(request, caller)
assert.ok(result?.data.byteLength)
assert.deepEqual(result.layoutFailures, [])
const loading = getDocument({ data: result.data.slice(), useSystemFonts: true })
try {
  const document = await loading.promise
  assert.equal(document.numPages, 1)
  const text = (await (await document.getPage(1)).getTextContent()).items
    .map((item) => item.str ?? '')
    .join('')
  assert.ok(text.includes('测量细胞生长。'), text)
} finally {
  await loading.destroy()
}
const cancelled = writer.generateDetailed({ ...request, id: 'packed-cancel' }, caller)
controller.abort()
assert.equal(await cancelled, null)
await assert.rejects(import('@aipoch/pdf-translation/reader/source'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
await assert.rejects(import('@aipoch/pdf-translation/dist/writer.js'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
console.log('Packed translation worker, WASM/font output, text roundtrip and cancellation passed.')
