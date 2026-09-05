import { afterEach, describe, expect, it, vi } from 'vitest'

import { installChildProcessGoneLogging, startLocalCrashReporting } from './crash-diagnostics'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startLocalCrashReporting', () => {
  it.each<NodeJS.Platform>(['win32', 'darwin', 'linux'])(
    'starts local Crashpad on %s with uploads and compression disabled',
    (platform) => {
      const start = vi.fn()

      const status = startLocalCrashReporting({
        platform,
        productName: 'Open Science',
        companyName: 'aipoch',
        appVersion: '0.9.1',
        start
      })

      expect(status).toEqual({ enabled: true, uploadsEnabled: false })
      expect(start).toHaveBeenCalledWith({
        productName: 'Open Science',
        companyName: 'aipoch',
        uploadToServer: false,
        compress: false,
        extra: { appVersion: '0.9.1' }
      })
    }
  )

  it('does not start Crashpad on unsupported Electron platforms', () => {
    const start = vi.fn()

    const status = startLocalCrashReporting({
      platform: 'freebsd',
      productName: 'Open Science',
      companyName: 'aipoch',
      appVersion: '0.9.1',
      start
    })

    expect(status).toEqual({ enabled: false })
    expect(start).not.toHaveBeenCalled()
  })

  it('does not schedule crash-dump cleanup when Crashpad starts', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const start = vi.fn()

    startLocalCrashReporting({
      platform: 'darwin',
      productName: 'Open Science',
      companyName: 'aipoch',
      appVersion: '0.25.1',
      start
    })

    expect(start).toHaveBeenCalledOnce()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})

describe('installChildProcessGoneLogging', () => {
  it('logs only privacy-safe child-process exit metadata', () => {
    type Register = Parameters<typeof installChildProcessGoneLogging>[0]
    type Listener = Parameters<Register>[0]
    let listener: Listener | undefined
    const log = { error: vi.fn() }

    installChildProcessGoneLogging((registeredListener) => {
      listener = registeredListener
    }, log)

    const details = {
      type: 'GPU',
      reason: 'crashed',
      exitCode: -36861,
      serviceName: 'gpu-process',
      name: 'GPU Process',
      commandLine: '--user-data-dir=C:\\Users\\private',
      url: 'https://private.example'
    } as const
    listener!({} as Parameters<Listener>[0], details)

    expect(log.error).toHaveBeenCalledWith('child process gone', {
      type: 'GPU',
      reason: 'crashed',
      exitCode: -36861,
      serviceName: 'gpu-process',
      name: 'GPU Process'
    })
  })
})
