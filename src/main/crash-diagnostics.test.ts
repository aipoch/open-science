import { describe, expect, it, vi } from 'vitest'

import { installChildProcessGoneLogging, startLocalCrashReporting } from './crash-diagnostics'

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
