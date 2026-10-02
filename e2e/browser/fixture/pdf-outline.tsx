import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib'
import { initI18n } from '@/i18n'
import { PdfPreviewContent } from '@/pages/workspace/previews/renderers/PdfPreview'

// Only the resource transport is stubbed. Destinations, page geometry, text and scrolling use PDF.js.
async function main(): Promise<void> {
  const pdf = await PDFDocument.create()
  const first = pdf.addPage([600, 1600])
  first.drawText('First heading', { x: 40, y: 1450, size: 24 })
  first.drawText('Second heading', { x: 40, y: 900, size: 24 })
  first.drawText('Last heading', { x: 40, y: 200, size: 24 })
  const rotated = pdf.addPage([600, 1600])
  rotated.setRotation(degrees(90))
  rotated.drawText('Rotated heading', { x: 300, y: 800, size: 24 })
  pdf.addPage([600, 1600]).drawText('End', { x: 40, y: 1450, size: 24 })
  const context = pdf.context
  pdf.catalog.set(
    PDFName.of('PageLabels'),
    context.obj({ Nums: [0, { S: 'D' }, 1, { S: 'r' }, 2, { S: 'D' }] })
  )
  pdf.catalog.set(PDFName.of('Dests'), context.obj({ second: [first.ref, 'XYZ', 40, 900, 2] }))
  const outline = context.obj({ Type: 'Outlines', Count: 5 })
  const outlineRef = context.register(outline)
  const entries = [
    { title: 'First heading', dest: context.obj([first.ref, 'XYZ', 40, 1450, null]) },
    { title: 'Second heading', dest: PDFString.of('second') },
    { title: 'Same destination alias', dest: context.obj([first.ref, 'FitH', 900]) },
    { title: 'Last heading', dest: context.obj([first.ref, 'FitH', 200]) },
    { title: 'Rotated heading', dest: context.obj([rotated.ref, 'XYZ', 300, 800, null]) }
  ].map(({ title, dest }) => {
    const entry = context.obj({ Title: PDFString.of(title), Parent: outlineRef, Dest: dest })
    return { entry, ref: context.register(entry) }
  })
  entries.forEach(({ entry }, index) => {
    if (index > 0) entry.set(PDFName.of('Prev'), entries[index - 1].ref)
    if (index + 1 < entries.length) entry.set(PDFName.of('Next'), entries[index + 1].ref)
  })
  outline.set(PDFName.of('First'), entries[0].ref)
  outline.set(PDFName.of('Last'), entries[entries.length - 1].ref)
  pdf.catalog.set(PDFName.of('Outlines'), outlineRef)
  const bytes = await pdf.save()
  window.api = {
    previewResources: {
      acquire: async () => ({
        id: 'outline',
        url: '',
        size: bytes.length,
        mimeType: 'application/pdf',
        version: 1
      }),
      readRange: async ({ begin, end }: { begin: number; end: number }) => ({
        begin,
        end,
        total: bytes.length,
        data: bytes.slice(begin, end)
      }),
      release: async () => {}
    }
  } as unknown as Window['api']
  initI18n('en')
  createRoot(document.getElementById('root')!).render(
    <main className="h-screen">
      <PdfPreviewContent path="/outline.pdf" name="outline.pdf" />
    </main>
  )
}
void main()
