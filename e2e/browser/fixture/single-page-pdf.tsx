import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PDFDocument, degrees, rgb } from 'pdf-lib'
import { initI18n } from '@/i18n'
import { PdfPreviewContent } from '@/pages/workspace/previews/renderers/PdfPreview'

async function main(): Promise<void> {
  const rotated = new URLSearchParams(location.search).has('rotated')
  const documents = new Map<string, Uint8Array>()
  for (const count of [1, 2]) {
    const pdf = await PDFDocument.create()
    for (let index = 0; index < count; index++) {
      const page = pdf.addPage([600, 400])
      if (rotated) page.setRotation(degrees(90))
      page.drawText('Vector figure', { x: 40, y: 340, size: 24 })
      page.drawLine({ start: { x: 50, y: 50 }, end: { x: 550, y: 50 }, thickness: 2 })
      page.drawLine({ start: { x: 50, y: 50 }, end: { x: 50, y: 300 }, thickness: 2 })
      for (let point = 0; point < 12; point++)
        page.drawCircle({
          x: 80 + point * 35,
          y: 80 + point * 15,
          size: 8,
          color: point < 6 ? rgb(0.2, 0.7, 0.8) : rgb(0.9, 0.2, 0.1)
        })
    }
    documents.set(`${count}.pdf`, await pdf.save())
  }
  // Only transport is stubbed; page count, rotation, painting and zoom use the real PDF.js runtime.
  window.api = {
    previewResources: {
      acquire: async ({ path }: { path: string }) => ({
        id: path,
        url: '',
        size: documents.get(path)!.length,
        mimeType: 'application/pdf',
        version: 1
      }),
      readRange: async ({
        resourceId,
        begin,
        end
      }: {
        resourceId: string
        begin: number
        end: number
      }) => ({
        begin,
        end,
        total: documents.get(resourceId)!.length,
        data: documents.get(resourceId)!.slice(begin, end)
      }),
      release: async () => {}
    }
  } as unknown as Window['api']
  function Fixture(): React.JSX.Element {
    const [count, setCount] = useState(1)
    return (
      <main className="flex h-screen flex-col">
        <div className="flex shrink-0 gap-4 p-2">
          <button onClick={() => setCount(1)}>Single page</button>
          <button onClick={() => setCount(2)}>Two pages</button>
        </div>
        <div className="min-h-0 flex-1 border" data-preview-container>
          <PdfPreviewContent path={`${count}.pdf`} name="figure.pdf" source="local" />
        </div>
      </main>
    )
  }
  initI18n('en')
  createRoot(document.getElementById('root')!).render(<Fixture />)
}
void main()
