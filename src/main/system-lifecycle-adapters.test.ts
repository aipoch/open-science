import { EventEmitter } from 'node:events'

import type { BrowserWindow, PowerMonitor } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  installSystemLifecycleAdapters,
  type ShutdownSignalSource,
  type SystemLifecycleWindow
} from './system-lifecycle-adapters'

const setup = (
  options: { platform?: NodeJS.Platform; headless?: boolean } = {}
): {
  adapters: ReturnType<typeof installSystemLifecycleAdapters>
  signalSource: EventEmitter
  powerMonitor: EventEmitter
  requestSystemShutdown: () => void
  windows: SystemLifecycleWindow[]
} => {
  const signalSource = new EventEmitter()
  const powerMonitor = new EventEmitter()
  const requestSystemShutdown = vi.fn()
  const windows: SystemLifecycleWindow[] = []
  const platform = options.platform ?? 'linux'
  const adapters = installSystemLifecycleAdapters({
    windowSessionEndEvents: platform === 'win32',
    powerShutdownEvent: platform !== 'win32',
    headless: options.headless ?? false,
    signalSource: signalSource as ShutdownSignalSource,
    powerMonitor: powerMonitor as unknown as Pick<PowerMonitor, 'on'>,
    getWindows: () => windows,
    requestSystemShutdown
  })
  return { adapters, signalSource, powerMonitor, requestSystemShutdown, windows }
}

const makeWindow = (): {
  window: SystemLifecycleWindow
  emit: (event: 'query-session-end' | 'session-end', payload?: unknown) => void
  send: ReturnType<typeof vi.fn>
} => {
  const emitter = new EventEmitter()
  const send = vi.fn()
  return {
    window: {
      isDestroyed: () => false,
      on: emitter.on.bind(emitter),
      webContents: { send }
    } as unknown as Pick<BrowserWindow, 'isDestroyed' | 'on' | 'webContents'>,
    emit: (event, payload) => emitter.emit(event, payload),
    send
  }
}

describe('installSystemLifecycleAdapters', () => {
  it.each(['query-session-end', 'session-end'] as const)(
    'routes Windows %s without vetoing the OS event',
    (eventName) => {
      const { adapters, requestSystemShutdown } = setup({ platform: 'win32' })
      const { window, emit } = makeWindow()
      const event = { preventDefault: vi.fn() }

      adapters.bindWindow(window)
      adapters.bindWindow(window)
      emit(eventName, event)

      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(requestSystemShutdown).toHaveBeenCalledOnce()
    }
  )

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'routes Headless %s once and removes the sibling signal listener',
    (signal) => {
      const { signalSource, requestSystemShutdown } = setup({ headless: true })
      const sibling = signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM'

      signalSource.emit(signal)
      signalSource.emit(sibling)

      expect(requestSystemShutdown).toHaveBeenCalledOnce()
    }
  )

  it('routes a preventable non-Windows power shutdown', () => {
    const { adapters, powerMonitor, requestSystemShutdown } = setup({ platform: 'darwin' })
    const event = { preventDefault: vi.fn() }

    adapters.installPowerMonitorListeners()
    powerMonitor.emit('shutdown', event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(requestSystemShutdown).toHaveBeenCalledOnce()
  })

  it('does not install unsupported Windows power shutdown handling', () => {
    const { adapters, powerMonitor, requestSystemShutdown } = setup({ platform: 'win32' })

    adapters.installPowerMonitorListeners()
    powerMonitor.emit('shutdown', { preventDefault: vi.fn() })

    expect(requestSystemShutdown).not.toHaveBeenCalled()
  })

  it('notifies every live Renderer to revalidate network state after resume', () => {
    const { adapters, powerMonitor, windows } = setup({ platform: 'win32' })
    const live = makeWindow()
    windows.push(live.window)

    adapters.installPowerMonitorListeners()
    powerMonitor.emit('resume')

    expect(live.send).toHaveBeenCalledWith('network:system-resumed')
  })
})
