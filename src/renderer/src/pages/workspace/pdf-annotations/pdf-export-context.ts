import { createContext, useContext } from 'react'

export type PdfExportAction = {
  path: string
  versionId?: string
  busy: boolean
  saving: boolean
  disabled: boolean
  unavailableReason?: string
  label: string
  execute: () => Promise<void>
  cancel: () => void
}
export const PdfExportActionContext = createContext<PdfExportAction | undefined>(undefined)
export const PdfExportRegistrationContext = createContext<
  React.Dispatch<React.SetStateAction<PdfExportAction | undefined>> | undefined
>(undefined)
export const usePdfExportAction = (): PdfExportAction | undefined =>
  useContext(PdfExportActionContext)
export const usePdfExportRegistration = (): React.ContextType<
  typeof PdfExportRegistrationContext
> => useContext(PdfExportRegistrationContext)
