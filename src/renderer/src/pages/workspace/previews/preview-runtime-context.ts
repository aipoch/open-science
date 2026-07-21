import { createContext, useContext } from 'react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

type PreviewRuntime = {
  attempt: number
  item: PreviewFileItem
  retry: () => void
}

const PreviewRuntimeContext = createContext<PreviewRuntime | undefined>(undefined)

const usePreviewRuntime = (): PreviewRuntime | undefined => useContext(PreviewRuntimeContext)

export { PreviewRuntimeContext, usePreviewRuntime }
export type { PreviewRuntime }
