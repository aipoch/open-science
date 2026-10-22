import { createContext, useContext } from 'react'

import type { PreviewFileItem } from '@/stores/preview-workbench-contract'

type PreviewDownloadVersionContext = {
  versionId: string
  versionNumber: number
  latestVersionId: string
  latestVersionNumber: number
}

type PreviewRuntime = {
  attempt: number
  item: PreviewFileItem
  retry: () => void
  downloadVersionContext?: PreviewDownloadVersionContext
}

const PreviewRuntimeContext = createContext<PreviewRuntime | undefined>(undefined)

const usePreviewRuntime = (): PreviewRuntime | undefined => useContext(PreviewRuntimeContext)

export { PreviewRuntimeContext, usePreviewRuntime }
export type { PreviewDownloadVersionContext, PreviewRuntime }
