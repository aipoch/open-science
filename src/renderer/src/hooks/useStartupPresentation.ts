import { useEffect } from 'react'
import type { StartupPresentationPhase } from '../../../shared/startup-presentation'

// A terminal acknowledgement belongs to the committed, painted view. Cleanup prevents a loading
// transition or an unmounted/StrictMode render from revealing an obsolete page.
export function useStartupPresentation(phase: StartupPresentationPhase | undefined): void {
  useEffect(() => {
    const bridge = window.startupPresentation
    if (!bridge || !phase) return
    if (phase !== 'interactive' && phase !== 'blocked') {
      bridge.phase(phase)
      return
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => bridge.phase(phase))
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])
}
