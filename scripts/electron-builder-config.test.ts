import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES } from '../src/main/notebook/micromamba-cache'

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
    expect(cleanup).toContain('.open-science-cache.json')
    expect(cleanup).toContain('Get-CompactCacheLeaf')
    expect(cleanup).toContain('$compactLeaf = Get-CompactCacheLeaf $canonicalRoot $userIdentity')
    expect(cleanup).toContain('(Join-Path $env:USERPROFILE $compactLeaf)')
    expect(cleanup).toContain('S-1-5-32-544')
    expect(cleanup).toContain('$trustedWriteSids -notcontains $sid')
    for (const right of WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES) {
      expect(cleanup).toContain(`[System.Security.AccessControl.FileSystemRights]::${right}`)
    }
    expect(cleanup).toContain('Remove-Item -LiteralPath $candidate')
  })
})
