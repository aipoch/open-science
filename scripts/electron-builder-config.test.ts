import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { WSL2_BASH_PREVIEW_MANIFEST } from '../src/shared/wsl2-preview-manifest'

import {
  WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES,
  WINDOWS_CACHE_TRUSTED_OWNER_SIDS
} from '../src/main/notebook/micromamba-cache'

describe('electron-builder native image processing', () => {
  it('excludes private scratch and nested worktrees from the packaged application', () => {
    const root = process.cwd()
    const config = load(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
      files: string[]
    }
    const matches = new FileMatcher(root, root, (pattern) => pattern, [
      '**/*',
      ...config.files
    ]).createFilter()
    const fileStat = statSync(join(root, 'package.json'))

    for (const directory of [
      '.scratch',
      '.worktree',
      '.worktrees',
      '.claude',
      '.codex',
      '.open-science-test-runtime',
      'test-results',
      'playwright-report',
      'coverage',
      'dist',
      'packages/notebook-network-sandbox'
    ]) {
      expect(matches(join(root, directory, 'private-diagnostics.json'), fileStat)).toBe(false)
    }
    expect(matches(join(root, 'out', 'main', 'index.js'), fileStat)).toBe(true)
  })

  it('ships sharp and its platform binary outside the ASAR archive', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      asarUnpack?: string[]
    }

    expect(config.asarUnpack).toContain('node_modules/sharp/**')
    expect(config.asarUnpack).toContain('node_modules/@img/**')
    expect(config.asarUnpack).toContain(
      'node_modules/@aipoch/process-tree-native/build/Release/*.node'
    )
  })

  it('ships the Notebook network sandbox helpers for every supported platform', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      files?: string[]
      win?: { extraResources?: Array<{ from: string; to: string }> }
      mac?: { extraResources?: Array<{ from: string; to: string }> }
      linux?: { extraResources?: Array<{ from: string; to: string }> }
    }

    expect(config.files).toContain('!node_modules/@aipoch/notebook-network-sandbox{,/**/*}')
    expect(config.win?.extraResources).toContainEqual({
      from: 'packages/notebook-network-sandbox/vendor/windows/${arch}/notebook-appcontainer-host.exe',
      to: 'notebook-network-sandbox/windows/${arch}/notebook-appcontainer-host.exe'
    })
    expect(config.win?.extraResources).toContainEqual({
      from: 'packages/notebook-network-sandbox/vendor/wsl2/manifest.json',
      to: 'notebook-network-sandbox/wsl2/manifest.json'
    })
    expect(config.mac?.extraResources).toHaveLength(1)
    expect(config.linux?.extraResources).toHaveLength(1)
  })
})

describe('WSL2 Bash Preview certification', () => {
  it('keeps the certification contract tied to the packaged application version', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }

    expect(WSL2_BASH_PREVIEW_MANIFEST.appVersion).toBe(packageJson.version)
  })

  it('keeps the packaged manifest identical to the main-process certification contract', () => {
    const packagedManifest = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'packages',
          'notebook-network-sandbox',
          'vendor',
          'wsl2',
          'manifest.json'
        ),
        'utf8'
      )
    )

    expect(packagedManifest).toEqual(WSL2_BASH_PREVIEW_MANIFEST)
  })

  it('keeps the versioned reference record privacy-safe and tied to the packaged app', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }
    const record = readFileSync(
      join(process.cwd(), 'docs', 'certification', 'wsl2-bash-preview-v1.md'),
      'utf8'
    )

    expect(record).toContain(`Application version: ${packageJson.version}`)
    expect(record).toContain(`Open Science ${packageJson.version}, Windows x64 package`)
    expect(record).toMatch(/\| WSL\s+\| 2\.1\.5\.0/)
    expect(record).toContain('Ubuntu-22.04')
    expect(record).toContain('networkingMode=mirrored')
    expect(record).not.toContain('open-science-spike')
    expect(record).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('electron-builder Windows targets', () => {
  it('ships only the uninstallable NSIS package for durable AppContainer resources', () => {
    const rawConfig = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const config = load(rawConfig) as {
      nsis?: { oneClick?: boolean; perMachine?: boolean; allowElevation?: boolean }
    }
    const windowsConfig = rawConfig.match(/^win:\n([\s\S]*?)(?=^[^\s#])/m)?.[1]

    expect(windowsConfig).toBeDefined()
    expect(windowsConfig).toMatch(/^\s+- nsis\s*$/m)
    expect(windowsConfig).not.toMatch(/^\s+- zip\s*$/m)
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false
    })
    expect(readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')).toContain(
      'StrCpy $isForceCurrentInstall "1"'
    )
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

  it('ships and enforces owned Notebook AppContainer cleanup on uninstall', () => {
    const config = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    const include = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const cleanup = readFileSync(
      join(process.cwd(), 'build', 'windows-notebook-sandbox-uninstall.ps1'),
      'utf8'
    )

    expect(config).toContain('from: build/windows-notebook-sandbox-uninstall.ps1')
    expect(include).toContain('windows-notebook-sandbox-uninstall.ps1')
    expect(include).toContain('${ifNot} ${isUpdated}')
    expect(include).toContain('notebookSandboxCleanupComplete')
    expect(include).toContain('The uninstall was stopped so the cleanup can be retried.')
    expect(cleanup).toContain('-ArgumentList @($Command, $installationId, $ownershipRoot)')
    expect(cleanup).toContain('& $HostPath $Command $installationId $ownershipRoot')
    expect(cleanup).toContain('& $HostPath prepare-remove $installationId $ownershipRoot')
    expect(cleanup).toContain('& $HostPath finish-remove $installationId $ownershipRoot')
    expect(cleanup).toContain('Test-CurrentUserIsAdministrator')
    expect(cleanup).toContain('Stop-SandboxHostProcesses')
    expect(cleanup).toContain('notebook-sandbox\\$installationId')
    expect(cleanup).toContain("$installationId = '0f3cd2a44c3d4e4e9f1e2a5b'")
    expect(cleanup.indexOf('$ownershipRoot =')).toBeLessThan(cleanup.indexOf('$HostPath ='))
    expect(cleanup).toContain('-Verb RunAs')
    expect(include).toContain('taskkill /F /IM "notebook-appcontainer-host.exe"')
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

  it('declares bubblewrap as a deb runtime dependency', () => {
    const config = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      deb?: { depends?: string[] }
    }

    expect(config.deb?.depends).toContain('bubblewrap')
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
