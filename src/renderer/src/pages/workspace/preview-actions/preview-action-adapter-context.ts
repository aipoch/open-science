import { createContext } from 'react'

export type PreviewContextMenuFrameRegistration = Readonly<{
  id: string
  frameUrl: string
  getFrame: () => HTMLIFrameElement | null
}>

export type PreviewActionMenuAdapter = {
  openContextMenu: (pointer: { x: number; y: number }, focusTarget?: Element | null) => void
  registerFrame: (registration: PreviewContextMenuFrameRegistration) => () => void
}

export const PreviewActionMenuAdapterContext = createContext<PreviewActionMenuAdapter | null>(null)
