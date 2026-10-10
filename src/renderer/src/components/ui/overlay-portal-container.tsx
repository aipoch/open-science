import { createContext, useContext } from 'react'

/** Explicitly scoped portal root, e.g. for controls inside a fullscreen Replay. */
export const OverlayPortalContainer = createContext<HTMLElement | null>(null)

export function useOverlayPortalContainer(): HTMLElement | undefined {
  return useContext(OverlayPortalContainer) ?? undefined
}
