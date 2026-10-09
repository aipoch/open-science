import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
const backendSource = readFileSync(resolve(__dirname, 'node-entry.ts'), 'utf8')
const before = (first: string, second: string): void => {
  expect(mainSource.indexOf(first), first).toBeGreaterThan(-1)
  expect(mainSource.indexOf(second), second).toBeGreaterThan(mainSource.indexOf(first))
}
describe('single Node runtime production startup', () => {
  it('hands a second shell to its owner before reading Chromium-locked credentials', () => {
    before("app.setPath('userData', profilePath)", 'app.requestSingleInstanceLock()')
    before('app.requestSingleInstanceLock()', 'prepareCredentialValidation(identity,')
    before('prepareCredentialValidation(identity,', 'initializeNodeWindowsProfileKey(profilePath)')
  })
  it('installs native shutdown listeners before launching Node and protects a quit during startup', () => {
    before('await app.whenReady()', 'system.installPowerMonitorListeners()')
    before('system.installPowerMonitorListeners()', 'await startOrAttachDesktopBackend(')
    before("app.on('before-quit', holdStartupQuit)", 'await app.whenReady()')
    before('if (startupQuitRequested)', "app.removeListener('before-quit', holdStartupQuit)")
  })
  it('installs preview handlers in both native sessions before a first window can exist', () => {
    before('await startOrAttachDesktopBackend(', 'session.defaultSession')
    before('await startOrAttachDesktopBackend(', "session.fromPartition('reviewer-paged-preview')")
    before(
      "session.fromPartition('reviewer-paged-preview')",
      'const lifecycle = installAppLifecycle('
    )
    before('registerOfficePreviewRuntimeProtocol(', 'const lifecycle = installAppLifecycle(')
  })
  it('constructs the shared business runtime only in Node and publishes ready after database and Web startup', () => {
    expect(mainSource).not.toMatch(
      /(?:createCoreRuntime|registerIpcHandlers|new SettingsDocumentStore|new LocalePreferenceOwner|prepareApplicationLocations)/
    )
    expect(backendSource).toContain('runtime = await createCoreRuntime(')
    expect(backendSource.indexOf('await waitForVerifiedDatabaseStartup(')).toBeLessThan(
      backendSource.indexOf('runtime = await createCoreRuntime(')
    )
    expect(backendSource.indexOf('await web.ensureStarted(')).toBeLessThan(
      backendSource.indexOf('databaseStartup.complete()')
    )
    before('await connectDesktopRuntime(', 'const lifecycle = installAppLifecycle(')
  })
  it('projects authoritative locale without writing it before the renderer imports its historical cache', () => {
    expect(mainSource).toContain("client.invokeHost('locale:snapshot')")
    expect(mainSource).not.toContain("invokeHost('locale:initialize'")
    before('await i18n.changeLanguage(locale.locale)', 'const lifecycle = installAppLifecycle(')
    expect(mainSource).toContain("invokeHost('settings:set-close-preference', [preference])")
  })
})
