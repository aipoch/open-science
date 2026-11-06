// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAccessMode, RemoteAccessSnapshot } from '../../../../shared/remote-access'
import { ConnectMobilePanel } from './ConnectMobileWindow'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
  vi.unstubAllGlobals()
})

const snapshotFor = (mode: RemoteAccessMode): RemoteAccessSnapshot => ({
  canManage: true,
  canManagePairing: true,
  mode,
  enabled: mode !== 'off',
  lifecycle: mode === 'off' ? 'disabled' : 'running',
  remoteIt: { installed: false, loggedIn: false, registered: false },
  pendingRequests: [],
  trustedBrowsers: []
})

const mount = async (mode: RemoteAccessMode): Promise<ReturnType<typeof vi.fn>> => {
  const setMode = vi.fn(async ({ mode: next }: { mode: RemoteAccessMode }) => snapshotFor(next))
  ;(window as unknown as { api: unknown }).api = {
    remoteAccess: {
      getSnapshot: vi.fn(async () => snapshotFor(mode)),
      onChanged: vi.fn(() => () => undefined),
      setMode
    }
  }
  await act(async () => root.render(<ConnectMobilePanel embedded />))
  await act(async () => undefined)
  return setMode
}

describe('ConnectMobilePanel default mode', () => {
  it('starts WiFi pairing when remote access is off', async () => {
    const setMode = await mount('off')
    expect(setMode).toHaveBeenCalledOnce()
    expect(setMode).toHaveBeenCalledWith({ mode: 'lan' })
  })

  it.each(['lan', 'pinggy', 'remoteit', 'remoteit-public'] as const)(
    'keeps the explicitly chosen %s mode',
    async (mode) => {
      const setMode = await mount(mode)
      expect(setMode).not.toHaveBeenCalled()
    }
  )
})
