// @vitest-environment jsdom
import { act, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useSettingsUndoPortal } from './use-settings-undo-portal'
import { useNoticeCountdown } from './use-notice-countdown'

it('moves the same receipt between hosts without resetting its countdown', async () => {
  vi.useFakeTimers()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const mounted = vi.fn()
  function Receipt(): React.JSX.Element {
    const [expired, setExpired] = useState(false)
    useEffect(() => {
      mounted()
    }, [])
    useNoticeCountdown(8_000, false, () => setExpired(true))
    return <span data-testid="receipt">{expired ? 'expired' : 'active'}</span>
  }
  function Fixture({ open }: { open: boolean }): React.JSX.Element {
    const portal = useSettingsUndoPortal(<Receipt />)
    return (
      <>
        <div data-testid="background" inert={open}>
          {portal.background}
        </div>
        {open && <div data-testid="settings" ref={portal.settingsHostRef} />}
      </>
    )
  }
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Fixture open={false} />
        </StrictMode>
      )
    )
    const receipt = container.querySelector<HTMLElement>('[data-testid="receipt"]')
    const mounts = mounted.mock.calls.length
    await act(async () => vi.advanceTimersByTime(3_000))
    await act(async () =>
      root.render(
        <StrictMode>
          <Fixture open />
        </StrictMode>
      )
    )
    expect(container.querySelector('[data-testid="settings"]')?.contains(receipt)).toBe(true)
    expect(receipt?.closest('[inert]')).toBeNull()
    await act(async () => vi.advanceTimersByTime(3_000))
    await act(async () =>
      root.render(
        <StrictMode>
          <Fixture open={false} />
        </StrictMode>
      )
    )
    expect(container.querySelector('[data-testid="background"]')?.contains(receipt)).toBe(true)
    expect(mounted).toHaveBeenCalledTimes(mounts)
    await act(async () => vi.advanceTimersByTime(2_000))
    expect(receipt?.textContent).toBe('expired')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  }
})
