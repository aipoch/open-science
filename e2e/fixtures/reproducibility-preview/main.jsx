import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FilePreviewDialog } from '../../../src/renderer/src/pages/workspace/FilePreviewDialog'
import { initI18n } from '../../../src/renderer/src/i18n'
import '../../../src/renderer/src/assets/main.css'

initI18n(new URLSearchParams(location.search).get('locale') === 'de' ? 'de' : 'en')
export function Fixture() {
  const [open, setOpen] = useState(true)
  return (
    <FilePreviewDialog
      item={
        open
          ? {
              id: 'fixture',
              sessionId: 'fixture',
              type: 'file',
              title: 'result.csv',
              name: 'result.csv',
              path: 'result.csv',
              format: 'text',
              source: 'artifact'
            }
          : undefined
      }
      onClose={() => setOpen(false)}
    />
  )
}
createRoot(document.getElementById('root')).render(<Fixture />)
