import { describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import { ensureWindowsProtocolRegistration } from './windows-protocol-registration'

const executable = 'D:\\Research Apps\\研究\\open-science.exe'
const setup = (): {
  isPackaged: boolean
  isDefaultProtocolClient: ReturnType<typeof vi.fn<App['isDefaultProtocolClient']>>
  setAsDefaultProtocolClient: ReturnType<typeof vi.fn<App['setAsDefaultProtocolClient']>>
} => ({
  isPackaged: true,
  isDefaultProtocolClient: vi.fn<App['isDefaultProtocolClient']>(() => false),
  setAsDefaultProtocolClient: vi.fn<App['setAsDefaultProtocolClient']>(() => true)
})

describe('Windows protocol registration', () => {
  it.each([undefined, 'C:\\Old Install\\open-science.exe'])(
    'repairs an upgraded installation with previous handler %s',
    (previous) => {
      const app = setup()
      let registered = previous
      app.isDefaultProtocolClient.mockImplementation((_scheme, path) => registered === path)
      app.setAsDefaultProtocolClient.mockImplementation((_scheme, path) => {
        registered = path
        return true
      })

      expect(ensureWindowsProtocolRegistration(app, 'win32', executable)).toBe(true)
      expect(app.setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith(
        'open-science',
        executable,
        []
      )
      expect(app.isDefaultProtocolClient).toHaveBeenLastCalledWith('open-science', executable, [])
      expect(ensureWindowsProtocolRegistration(app, 'win32', executable)).toBe(true)
      expect(app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(2)
    }
  )

  it('restores the URL Protocol marker even when the command already matches', () => {
    const app = setup()
    let hasUrlProtocol = false
    // Electron only compares shell/open/command; it does not validate the scheme marker.
    app.isDefaultProtocolClient.mockReturnValue(true)
    app.setAsDefaultProtocolClient.mockImplementation(() => {
      hasUrlProtocol = true
      return true
    })
    expect(ensureWindowsProtocolRegistration(app, 'win32', executable)).toBe(true)
    expect(hasUrlProtocol).toBe(true)
  })

  it.each([
    ['darwin', true],
    ['linux', true],
    ['win32', false]
  ] as const)('does not take over associations on %s with packaged=%s', (platform, isPackaged) => {
    const app = { ...setup(), isPackaged }
    expect(ensureWindowsProtocolRegistration(app, platform, executable)).toBe(true)
    expect(app.isDefaultProtocolClient).not.toHaveBeenCalled()
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  it('reports a rejected write', () => {
    const app = setup()
    app.setAsDefaultProtocolClient.mockReturnValue(false)
    expect(ensureWindowsProtocolRegistration(app, 'win32', executable)).toBe(false)
  })

  it('does not report success until the effective handler has been checked again', () => {
    expect(ensureWindowsProtocolRegistration(setup(), 'win32', executable)).toBe(false)
  })

  it.each(['isDefaultProtocolClient', 'setAsDefaultProtocolClient'] as const)(
    'keeps startup available when %s throws',
    (method) => {
      const app = setup()
      app[method].mockImplementation(() => {
        throw new Error('Registry access denied')
      })
      expect(ensureWindowsProtocolRegistration(app, 'win32', executable)).toBe(false)
    }
  )
})
