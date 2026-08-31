import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

describe('main startup ordering', () => {
  it('installs power-monitor listeners before loading startup shell modules', () => {
    const electronReady = mainSource.indexOf('await app.whenReady()')
    const installPowerMonitor = mainSource.indexOf('installPowerMonitorListeners()')
    const loadStartupModules = mainSource.indexOf(
      "startupDiagnostics?.phase('load-startup-shell-modules')"
    )

    expect(electronReady).toBeGreaterThan(-1)
    expect(installPowerMonitor).toBeGreaterThan(electronReady)
    expect(loadStartupModules).toBeGreaterThan(installPowerMonitor)
  })

  it('registers the managed-preview protocol bridge before creating the first window', () => {
    const registerBridge = mainSource.indexOf(
      'const managedPreviewProtocolBridge = createManagedPreviewProtocolBridge(protocol)'
    )
    const createFirstWindow = mainSource.indexOf(
      'createMainWindow(startupWindowCloseOptions, translate)'
    )

    expect(registerBridge).toBeGreaterThan(-1)
    expect(createFirstWindow).toBeGreaterThan(registerBridge)
  })

  it('binds the startup locale owner into native windows and close confirmation', () => {
    const createOwner = mainSource.indexOf('const localeOwner = new LocalePreferenceOwner(')
    const bindTranslator = mainSource.indexOf('const translate = localeOwner.t.bind(localeOwner)')
    const createFirstWindow = mainSource.indexOf(
      'createMainWindow(startupWindowCloseOptions, translate)'
    )
    const createCloseConfirm = mainSource.indexOf('createElectronCloseConfirm(')
    const closeConfirmTranslation = mainSource.indexOf(
      'translate\n                )',
      createCloseConfirm
    )

    expect(createOwner).toBeGreaterThan(-1)
    expect(bindTranslator).toBeGreaterThan(createOwner)
    expect(createFirstWindow).toBeGreaterThan(bindTranslator)
    expect(createCloseConfirm).toBeGreaterThan(bindTranslator)
    expect(closeConfirmTranslation).toBeGreaterThan(createCloseConfirm)
  })
})
