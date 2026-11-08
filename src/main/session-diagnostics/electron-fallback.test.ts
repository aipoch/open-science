import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElectronSessionDiagnosticsFallback } from './electron-fallback'

const { createSessionDiagnosticsDesktop } = vi.hoisted(() => ({
  createSessionDiagnosticsDesktop: vi.fn(() => ({}))
}))

vi.mock('./desktop', () => ({ createSessionDiagnosticsDesktop }))
vi.mock('@aipoch/diagnostics/node', () => ({ getLogFilePath: () => '/logs/main.log' }))
vi.mock('../runtime-metadata', () => ({
  runtimeMetadata: () => ({
    version: 'test',
    packaged: false,
    applicationPath: '/app',
    homePath: '/home/test',
    downloadsPath: '/home/test/Downloads',
    resourcesPath: '/resources',
    locale: 'en'
  })
}))
vi.mock('./desktop-log-paths', () => ({ resolveDesktopLogPaths: () => ({}) }))

describe('Electron session diagnostics fallback', () => {
  beforeEach(() => createSessionDiagnosticsDesktop.mockClear())

  it('uses the Electron-owned destination chooser', () => {
    const chooseDestination = vi.fn(async () => undefined)

    createElectronSessionDiagnosticsFallback({
      configRoot: '/config',
      dataRoot: '/data',
      chooseDestination
    })

    expect(createSessionDiagnosticsDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ chooseDestination })
    )
  })
})
