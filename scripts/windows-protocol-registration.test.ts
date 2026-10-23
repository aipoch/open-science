import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const hook = readFileSync('build/installer.nsh', 'utf8')
const install = hook.match(/!macro customInstall\n([\s\S]*?)!macroend/)?.[1] ?? ''
const uninstall = hook.match(/!macro customUnInstall\n([\s\S]*?)!macroend/)?.[1] ?? ''
const key = 'Software\\Classes\\open-science'

describe('Windows installer protocol association', () => {
  it('checks the association on the owning desktop startup before initializing the backend', () => {
    const source = readFileSync('src/main/index.ts', 'utf8')
    const registration = source.indexOf('ensureWindowsProtocolRegistration(app)')
    expect(registration).toBeGreaterThan(source.indexOf('await app.whenReady()'))
    expect(registration).toBeLessThan(source.indexOf('await connectDesktopRuntimeForStartup('))
    expect(source).toContain("from './windows-protocol-registration'")
  })

  it('uses the same post-install hook for fresh, overwrite and updater installations', () => {
    const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
      nsis: { include: string }
    }
    expect(readFileSync(config.nsis.include, 'utf8')).toContain('\\installer.nsh"')
    const require = createRequire(import.meta.url)
    const builderRoot = dirname(require.resolve('app-builder-lib/package.json'))
    const section = readFileSync(join(builderRoot, 'templates/nsis/installSection.nsh'), 'utf8')
    expect(section.indexOf('!insertmacro customInstall')).toBeGreaterThan(
      section.indexOf('!insertmacro installApplicationFiles')
    )
    expect(install).not.toContain('isUpdated')
    expect(install).not.toContain('IfSilent')
    expect(install).toContain(`WriteRegStr HKCU "${key}" "" "URL:Open-Science"`)
    expect(install).toContain(`WriteRegStr HKCU "${key}" "URL Protocol" ""`)
    expect(install).toContain(
      `WriteRegStr HKCU "${key}\\shell\\open\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%1"'`
    )
    expect(install.indexOf('WriteRegStr')).toBeLessThan(install.indexOf('Push "installed"'))
    expect(install).toContain('!insertmacro quitFailedUpdate')
  })

  it('only removes its own protocol association on a real uninstall', () => {
    expect(uninstall).toContain(`ReadRegStr $0 HKCU "${key}\\shell\\open\\command" ""`)
    expect(uninstall).toContain('${ifNot} ${isUpdated}')
    expect(uninstall).toContain('${if} $0 == \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"\'')
    expect(uninstall).toContain(`DeleteRegKey HKCU "${key}"`)
  })
})
