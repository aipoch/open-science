import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES,
  WINDOWS_CACHE_TRUSTED_OWNER_SIDS
} from '../src/main/notebook/micromamba-cache'

describe('electron-builder native image processing', () => {
  it('ships sharp and its platform binary outside the ASAR archive', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      asarUnpack?: string[]
    }

    expect(config.asarUnpack).toContain('node_modules/sharp/**')
    expect(config.asarUnpack).toContain('node_modules/@img/**')
  })
})

describe('electron-builder Windows targets', () => {
  it('ships both the NSIS installer and the portable zip', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const windowsConfig = config.match(/^win:\n([\s\S]*?)(?=^[^\s#])/m)?.[1]

    expect(windowsConfig).toBeDefined()
    // Both formats, mirroring mac (dmg + zip): the installer plus a portable, no-install build.
    expect(windowsConfig).toMatch(/^\s+- nsis\s*$/m)
    expect(windowsConfig).toMatch(/^\s+- zip\s*$/m)
  })

  it('ships and invokes the owned managed-runtime cache cleanup on uninstall', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const include = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const cleanup = readFileSync(
      join(process.cwd(), 'build', 'windows-runtime-cache-uninstall.ps1'),
      'utf8'
    )

    expect(config).toContain('from: build/windows-runtime-cache-uninstall.ps1')
    expect(config).toContain('include: build/installer.nsh')
    expect(include).toContain('windows-runtime-cache-uninstall.ps1')
    const customUninstall = include.match(/!macro customUnInstall\n([\s\S]*?)!macroend/)?.[1]
    expect(customUninstall).toContain('$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(customUninstall).not.toMatch(/ExecToLog 'powershell\.exe\b/)
    expect(cleanup).toContain('.open-science-cache.json')
    expect(cleanup).toContain('Get-CompactCacheLeaf')
    expect(cleanup).toContain('$compactLeaf = Get-CompactCacheLeaf $canonicalRoot $userIdentity')
    expect(cleanup).toContain('Get-WorkingCacheLeaf')
    expect(cleanup).toContain('$workingLeaf = Get-WorkingCacheLeaf $canonicalRoot $userIdentity')
    expect(cleanup).toContain('foreach ($configuredTemp in @($env:TEMP, $env:TMP))')
    expect(cleanup).toContain("(Join-Path $configuredTemp 'OpenScienceTmp')")
    expect(cleanup).toContain("(Join-Path $env:USERPROFILE 'os-tmp')")
    expect(cleanup).toContain('Test-TrustedManagedParent')
    expect(cleanup).toContain('Test-NoReparsePointInPath')
    expect(cleanup).toContain("'.open-science-temp.json'")
    expect(cleanup).toContain('$env:TMP')
    expect(cleanup).toContain('$trustedOwnerSids -notcontains $ownerSid')
    expect(cleanup).toContain('elseif ($candidate.ManagedParent')
    expect(cleanup).toContain('(Join-Path $env:PUBLIC $leaf)')
    expect(cleanup).toContain('(Join-Path $env:USERPROFILE $compactLeaf)')
    for (const sid of WINDOWS_CACHE_TRUSTED_OWNER_SIDS) {
      expect(cleanup).toContain("'" + sid + "'")
    }
    expect(cleanup).toContain('$trustedWriteSids -notcontains $sid')
    for (const right of WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES) {
      expect(cleanup).toContain(`[System.Security.AccessControl.FileSystemRights]::${right}`)
    }
    expect(cleanup).toContain('Remove-Item -LiteralPath $candidate')
  })

  it('does not claim a Windows publisher while packages remain unsigned', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      win?: { publisherName?: string; verifyUpdateCodeSignature?: boolean }
    }

    expect(config.win?.publisherName).toBeUndefined()
    expect(config.win?.verifyUpdateCodeSignature).toBeUndefined()
  })
})

describe('electron-builder Linux desktop identity', () => {
  it('keeps Electron and the installed launcher on the same desktop name', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      name: string
      desktopName: string
    }
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      linux?: { executableName?: string; syncDesktopName?: boolean }
    }
    const desktopBaseName = packageJson.desktopName.replace(/\.desktop$/, '')
    const executableName = config.linux?.executableName ?? packageJson.name

    expect(config.linux?.syncDesktopName).toBe(true)
    expect(desktopBaseName).toBe(executableName)
  })
})

describe('electron-builder macOS icons', () => {
  it('uses Icon Composer for the app and signs the legacy-icon DMG container', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      mac?: { icon?: string; darkModeSupport?: boolean }
      dmg?: { icon?: string; sign?: boolean }
    }

    expect(config.mac?.icon).toBe('build/icon.icon')
    expect(config.mac?.darkModeSupport).toBe(true)
    expect(config.dmg?.icon).toBe('build/icon.icns')
    expect(config.dmg?.sign).toBe(true)

    const iconComposer = JSON.parse(
      readFileSync(join(process.cwd(), 'build', 'icon.icon', 'icon.json'), 'utf8')
    ) as {
      'fill-specializations'?: Array<{ appearance?: string }>
      groups?: Array<{
        layers?: Array<{ 'fill-specializations'?: Array<{ appearance?: string }> }>
      }>
    }
    expect(iconComposer['fill-specializations']?.some((item) => item.appearance === 'dark')).toBe(
      true
    )
    expect(
      iconComposer.groups?.some((group) =>
        group.layers?.some((layer) =>
          layer['fill-specializations']?.some((item) => item.appearance === 'dark')
        )
      )
    ).toBe(true)
  })
})
