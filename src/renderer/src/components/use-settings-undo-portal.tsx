import { useCallback, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Move one portal container into Settings' focus scope without remounting receipts or resetting
// their countdowns. React owns its children; the two empty hosts only own its DOM placement.
export const useSettingsUndoPortal = (
  children: ReactNode
): {
  background: React.JSX.Element
  settingsHostRef: (host: HTMLDivElement | null) => void
} => {
  const [container] = useState(() => document.createElement('div'))
  const backgroundHost = useRef<HTMLDivElement | null>(null)
  const settingsHost = useRef<HTMLDivElement | null>(null)
  const attachBackground = useCallback(
    (host: HTMLDivElement | null) => {
      backgroundHost.current = host
      if (host && !settingsHost.current) host.appendChild(container)
    },
    [container]
  )
  const attachSettings = useCallback(
    (host: HTMLDivElement | null) => {
      settingsHost.current = host
      const target = host ?? backgroundHost.current
      if (target) target.appendChild(container)
    },
    [container]
  )

  return {
    background: <div ref={attachBackground}>{createPortal(children, container)}</div>,
    settingsHostRef: attachSettings
  }
}
