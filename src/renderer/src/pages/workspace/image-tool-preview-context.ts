import { createContext } from 'react'

export const ImageToolPreviewContext = createContext<{
  projectId?: string
  sessionId?: string
} | null>(null)
