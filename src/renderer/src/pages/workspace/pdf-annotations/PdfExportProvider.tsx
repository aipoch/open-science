import { useState } from 'react'
import {
  PdfExportActionContext,
  PdfExportRegistrationContext,
  PdfTranslationExportActionContext,
  PdfTranslationExportRegistrationContext,
  type PdfExportAction,
  type PdfTranslationExportAction
} from './pdf-export-context'

export const PdfExportProvider = ({ children }: React.PropsWithChildren): React.JSX.Element => {
  const [action, setAction] = useState<PdfExportAction>()
  const [translationAction, setTranslationAction] = useState<PdfTranslationExportAction>()
  return (
    <PdfExportRegistrationContext.Provider value={setAction}>
      <PdfExportActionContext.Provider value={action}>
        <PdfTranslationExportRegistrationContext.Provider value={setTranslationAction}>
          <PdfTranslationExportActionContext.Provider value={translationAction}>
            {children}
          </PdfTranslationExportActionContext.Provider>
        </PdfTranslationExportRegistrationContext.Provider>
      </PdfExportActionContext.Provider>
    </PdfExportRegistrationContext.Provider>
  )
}
