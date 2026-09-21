import { useState } from 'react'
import {
  PdfExportActionContext,
  PdfExportRegistrationContext,
  type PdfExportAction
} from './pdf-export-context'

export const PdfExportProvider = ({ children }: React.PropsWithChildren): React.JSX.Element => {
  const [action, setAction] = useState<PdfExportAction>()
  return (
    <PdfExportRegistrationContext.Provider value={setAction}>
      <PdfExportActionContext.Provider value={action}>{children}</PdfExportActionContext.Provider>
    </PdfExportRegistrationContext.Provider>
  )
}
