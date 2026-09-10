import { useEffect, useState } from 'react'

import type { WslSetupStatus } from '../../../../shared/wsl-setup'

const STATUS_POLL_INTERVAL_MS = 1_000

export const useWslSetupStatus = (enabled = true): WslSetupStatus | undefined => {
  const [status, setStatus] = useState<WslSetupStatus>()

  useEffect(() => {
    if (!enabled) return () => undefined
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const accept = (next: WslSetupStatus): void => {
      if (!active) return
      setStatus((current) => (!current || next.revision > current.revision ? next : current))
    }
    const onStatusChanged = (
      window.api.settings as {
        onWslSetupChanged?: typeof window.api.settings.onWslSetupChanged
      }
    ).onWslSetupChanged
    const receivesEvents = typeof onStatusChanged === 'function'
    const scheduleRead = (): void => {
      if (!active) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(readStatus, STATUS_POLL_INTERVAL_MS)
    }
    const readStatus = (): void => {
      void window.api.settings
        .getWslSetupStatus()
        .then((next) => {
          accept(next)
          if (!receivesEvents) scheduleRead()
        })
        .catch(scheduleRead)
    }
    const unsubscribe = receivesEvents ? onStatusChanged(accept) : () => undefined
    readStatus()

    return () => {
      active = false
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [enabled])

  return status
}
