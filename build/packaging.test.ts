import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const repoRoot = join(__dirname, '..')
// Exercise the same packaging dependencies as the installed electron-builder.
const require = createRequire(import.meta.url)

describe('desktop packaging preparation', () => {
  function preparation(platform: string): {
    run: (context: unknown) => Promise<void>
    calls: string[]
  } {
    const config = load(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')) as {
      beforePack: string
    }
    expect(config.beforePack).toBe('build/prepare-desktop.cjs')
    const calls: string[] = []
    const module = { exports: undefined as unknown as (context: unknown) => Promise<void> }
    const dependencies = Object.assign(
      (name: string): unknown => {
        if (name === './stage-desktop-runtime.cjs')
          return async () => {
            calls.push('stage')
          }
        return require(name)
      },
      { resolve: require.resolve }
    )
    runInNewContext(readFileSync(join(repoRoot, config.beforePack), 'utf8'), {
      module,
      require: dependencies,
      process: { platform, arch: 'x64', execPath: process.execPath }
    })
    return { run: module.exports, calls }
  }

  it.each(['win32', 'darwin', 'linux'])(
    'prepares application resources before staging on %s',
    async (platform) => {
      const { run, calls } = preparation(platform)
      await run({
        electronPlatformName: platform,
        arch: require('builder-util').Arch.x64,
        packager: { projectDir: repoRoot }
      })
      expect(calls).toEqual(['stage'])
    }
  )

  it('rejects cross packaging before starting a compiler or staging', async () => {
    const { run, calls } = preparation('win32')
    await expect(
      run({
        electronPlatformName: 'win32',
        arch: require('builder-util').Arch.arm64,
        packager: { projectDir: repoRoot }
      })
    ).rejects.toThrow('target platform/architecture')
    expect(calls).toEqual([])
  })
})
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const appBuilderLibPath = builderRequire.resolve('app-builder-lib/package.json')
const appBuilderLibRoot = dirname(appBuilderLibPath)
const appBuilderRequire = createRequire(appBuilderLibPath)
const { createPackageWithOptions, listPackage } = appBuilderRequire('@electron/asar')

// Use an existing electron-builder NSIS cache; tests must not download a compiler.
function findNsisCompiler(): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (process.env.NSIS_TEST_COMPILER) return process.env.NSIS_TEST_COMPILER
  const cache =
    process.env.ELECTRON_BUILDER_CACHE ??
    join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
  if (!existsSync(cache)) return undefined
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('nsis')) continue
    const directory = join(cache, entry.name)
    const direct = join(directory, 'makensis.exe')
    if (existsSync(direct)) return direct
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const compiler = join(directory, child.name, 'makensis.exe')
      if (child.isDirectory() && existsSync(compiler)) return compiler
    }
  }
  return undefined
}

const nsisCompiler = findNsisCompiler()

describe.skipIf(!nsisCompiler)('NSIS application process check', () => {
  it('runs the upstream check with native PowerShell on AMD64', () => {
    const root = mkdtempSync(join(tmpdir(), 'nsis-app-check-'))
    try {
      const executable = join(root, 'check.exe')
      const output = join(root, 'result.txt')
      const source = join(root, 'check.nsi')
      // An uncreated, unique executable name keeps this test on the no-process path.
      const name = `unused-${root.split(/[/\\]/).at(-1)}.exe`
      writeFileSync(
        source,
        [
          'Unicode true',
          'RequestExecutionLevel user',
          'SilentInstall silent',
          `OutFile "${executable}"`,
          `InstallDir "${join(root, 'app')}"`,
          `!addincludedir "${join(appBuilderLibRoot, 'templates/nsis/include')}"`,
          '!include LogicLib.nsh',
          '!define isUpdated "0 == 1"',
          `!define APP_EXECUTABLE_FILENAME "${name}"`,
          `!include "${join(repoRoot, 'build/windows-app-running.nsh')}"`,
          '!include allowOnlyOneInstallerInstance.nsh',
          'LoadLanguageFile "${NSISDIR}/Contrib/Language files/English.nlf"',
          'LangString appRunning 1033 "Fixture running"',
          'LangString appClosing 1033 "Closing fixture"',
          'LangString appCannotBeClosed 1033 "Fixture cannot close"',
          'Section',
          '!insertmacro CHECK_APP_RUNNING',
          `nsExec::ExecToStack '"$PowerShellPath" -NoProfile -NonInteractive -Command "[Environment]::Is64BitProcess"'`,
          'Pop $2',
          'Pop $1',
          `FileOpen $0 "${output}" w`,
          'FileWrite $0 "code=$2$\\r$\\nbitness=$1host=$PowerShellPath$\\r$\\n"',
          '${If} ${IsNativeAMD64}',
          'FileWrite $0 "nativeAMD64=true"',
          '${Else}',
          'FileWrite $0 "nativeAMD64=false"',
          '${EndIf}',
          'FileClose $0',
          'SectionEnd'
        ].join('\n')
      )
      const compiled = spawnSync(nsisCompiler!, ['/V2', source], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(compiled.status, compiled.stderr).toBe(0)
      const run = spawnSync(executable, ['/S'], { windowsHide: true, timeout: 30_000 })
      expect(run.error).toBeUndefined()
      expect(run.status).toBe(0)
      const result = readFileSync(output, 'utf8')
      expect(result).toContain('code=0')
      if (result.includes('nativeAMD64=true')) {
        expect(result).toContain('bitness=True')
        expect(result).toMatch(/host=.*\\Sysnative\\WindowsPowerShell/)
      } else {
        expect(result).not.toContain('\\Sysnative\\')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!nsisCompiler).each(['OpenScience', 'Open-Science'])(
  'NSIS data preservation native behavior (%s)',
  (folder) => {
    it.each([
      'missing-parent',
      'missing-install',
      'existing-data',
      'interrupted-backup',
      'backup-conflict',
      'backup-file',
      'invalid-parent'
    ])('protects data during reinstall with %s', (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'nsis-preservation-'))
      const parent = join(
        root,
        scenario === 'invalid-parent' ? 'invalid?parent' : 'Open Science 科学'
      )
      try {
        const install = join(parent, 'open-science')
        const data = join(install, folder)
        const slot = folder === 'OpenScience' ? 'per-user' : 'per-user-branded'
        const backup = join(parent, `.open-science-update-data-${slot}`)
        const conflict = scenario === 'backup-conflict' || scenario === 'backup-file'
        if (scenario !== 'missing-parent' && scenario !== 'invalid-parent') mkdirSync(parent)
        if (scenario === 'existing-data' || conflict) {
          mkdirSync(data, { recursive: true })
          writeFileSync(join(data, 'sentinel.txt'), 'existing user data')
        }
        if (scenario === 'interrupted-backup' || scenario === 'backup-conflict') {
          mkdirSync(backup)
          writeFileSync(join(backup, 'sentinel.txt'), 'preserved user data')
        }
        if (scenario === 'backup-file') writeFileSync(backup, 'unrelated file')
        const include = readFileSync(join(repoRoot, 'build/installer.nsh'), 'utf8')
        const macro = include.match(
          /!macro preserveNamedDataRoot DIR BACKUP SLOT FOLDER[\s\S]*?!macroend/
        )?.[0]
        expect(macro).toBeDefined()
        const restore = include.match(
          /!macro restoreNamedDataRoot DIR BACKUP FOLDER[\s\S]*?!macroend/
        )?.[0]
        expect(restore).toBeDefined()
        // Execute the production macro with real NSIS filesystem operations. Redirect only
        // UI output to a file so an error dialog cannot block unattended regression runs.
        const observed = `${macro}\n${restore}`
          .replace(/^\s*DetailPrint (.+)$/gm, 'FileWriteUTF16LE $9 $1')
          .replace(/^\s*MessageBox MB_OK\|MB_ICONSTOP (.+)$/gm, 'FileWriteUTF16LE $9 $1')
        const output = join(root, 'result.txt')
        const executable = join(root, 'probe.exe')
        const source = join(root, 'probe.nsi')
        writeFileSync(
          source,
          `\uFEFFUnicode true
!include "LogicLib.nsh"
Name "Isolated data preservation regression"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
Var backup
Var dataProtectionFailed
Var dataRestoreFailed
${observed}
Section
FileOpen $9 "${output}" w
StrCpy $dataProtectionFailed "0"
StrCpy $dataRestoreFailed "0"
!insertmacro preserveNamedDataRoot "${install}" $backup ${slot} ${folder}
FileWriteUTF16LE $9 "|failed=$dataProtectionFailed|backup=$backup"
!insertmacro restoreNamedDataRoot "${install}" $backup ${folder}
FileWriteUTF16LE $9 "|restoreFailed=$dataRestoreFailed"
FileClose $9
SetErrorLevel 0
SectionEnd
`
        )
        const compile = spawnSync(nsisCompiler!, ['/V2', source], {
          encoding: 'utf8',
          timeout: 15_000
        })
        expect(compile.error).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 })
        expect(run.error).toBeUndefined()
        expect(run.status, run.stderr).toBe(0)
        const result = readFileSync(output, 'utf16le')
        expect(result, result).toContain(
          `|failed=${conflict || scenario === 'invalid-parent' ? '1' : '0'}`
        )
        expect(result, result).toContain('|restoreFailed=0')
        if (scenario === 'existing-data' || scenario === 'interrupted-backup') {
          expect(result).toContain(
            scenario === 'existing-data' ? '|backup=|restoreFailed=0' : `|backup=${backup}`
          )
          expect(readFileSync(join(data, 'sentinel.txt'), 'utf8')).toBe(
            scenario === 'existing-data' ? 'existing user data' : 'preserved user data'
          )
          expect(existsSync(backup)).toBe(false)
        } else if (scenario === 'invalid-parent') {
          expect(result).toContain('code=parent-path-unresolved')
        } else if (conflict) {
          expect(readFileSync(join(data, 'sentinel.txt'), 'utf8')).toBe('existing user data')
          expect(
            readFileSync(scenario === 'backup-file' ? backup : join(backup, 'sentinel.txt'), 'utf8')
          ).toBe(scenario === 'backup-file' ? 'unrelated file' : 'preserved user data')
        } else {
          expect(existsSync(parent)).toBe(scenario !== 'missing-parent')
          expect(existsSync(data)).toBe(false)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
)

it.skipIf(!nsisCompiler).each(['direct', 'external-alias', 'linked-ancestor'] as const)(
  'preserves co-located data in place when replacing an old installation (%s)',
  (layout) => {
    const root = mkdtempSync(join(tmpdir(), 'nsis-workspace-safety-'))
    const install = join(root, 'Open-Science')
    const restoreAcl = join(root, 'restore-program-acl.ps1')
    const powershell = join(
      process.env.SystemRoot!,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const powershellEnv = {
      ...process.env,
      PSModulePath: join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules')
    }
    const dataRelative =
      layout === 'linked-ancestor' ? 'resources/configured-link/research' : 'resources/custom-data'
    const content = 'sample,value\nA,3935\n'
    const paths = [
      'workspaces/project',
      'content/blobs',
      'custom-research',
      'OpenScience/workspaces/project',
      'Open-Science/workspaces/project',
      `${dataRelative}/content`,
      'locales/custom-config'
    ]
    try {
      if (layout === 'linked-ancestor') {
        mkdirSync(join(root, 'external-data'))
        mkdirSync(join(install, 'resources'), { recursive: true })
        symlinkSync(
          join(root, 'external-data'),
          join(install, 'resources/configured-link'),
          'junction'
        )
      }
      for (const path of paths) {
        mkdirSync(join(install, path), { recursive: true })
        writeFileSync(join(install, path, 'research.csv'), content)
      }
      const configRoot = join(install, 'locales/custom-config')
      let dataRoot = join(install, dataRelative)
      if (layout === 'external-alias') {
        symlinkSync(dataRoot, join(root, 'data-alias'), 'junction')
        dataRoot = join(root, 'data-alias')
      }
      writeFileSync(join(configRoot, 'settings.json'), JSON.stringify({ dataRoot }))
      const applicationFile = join(install, 'open-science.exe')
      writeFileSync(applicationFile, 'old application')
      mkdirSync(join(install, 'resources'), { recursive: true })
      const retryFiles = [
        'resources/windows-update-handoff-uninstall.ps1',
        'resources/windows-notebook-sandbox-uninstall.ps1',
        'resources/windows-runtime-cache-uninstall.ps1',
        'Uninstall open-science.exe'
      ]
      retryFiles.forEach((file, index) =>
        writeFileSync(join(install, file), `retry-payload-${index}`)
      )
      const lateProgramFile = join(install, 'vulkan-1.dll')
      const savedAcl = join(root, 'program-acl.txt')
      writeFileSync(lateProgramFile, 'old program library')
      // NSIS clears READONLY before deletion. Deny only WriteAttributes on this owned file:
      // rename still works, while final deletion fails without a production test seam.
      writeFileSync(
        restoreAcl,
        `$ErrorActionPreference='Stop'\nImport-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force\nif (Test-Path -LiteralPath ${psQuote(savedAcl)}) {\nGet-ChildItem -LiteralPath ${psQuote(install)} -Recurse -Filter 'vulkan-1.dll' | ForEach-Object {\n$acl=New-Object Security.AccessControl.FileSecurity\n$acl.SetSecurityDescriptorSddlForm([IO.File]::ReadAllText(${psQuote(savedAcl)}))\nSet-Acl -LiteralPath $_.FullName -AclObject $acl\n[IO.File]::SetAttributes($_.FullName,[IO.FileAttributes]::Normal)\n}\n}`
      )
      const prepareAcl = `$ErrorActionPreference='Stop'\nImport-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force\n$file=${psQuote(lateProgramFile)}\n$acl=Get-Acl -LiteralPath $file\n[IO.File]::WriteAllText(${psQuote(savedAcl)},$acl.Sddl)\n[IO.File]::SetAttributes($file,[IO.FileAttributes]::ReadOnly)\n$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.AccessControl.FileSystemRights]::WriteAttributes,[Security.AccessControl.AccessControlType]::Deny)\n$acl.AddAccessRule($rule)\nSet-Acl -LiteralPath $file -AclObject $acl`
      const acl = spawnSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(prepareAcl, 'utf16le').toString('base64')
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: powershellEnv }
      )
      expect(acl.status, acl.stderr).toBe(0)
      symlinkSync(
        join(install, 'workspaces'),
        join(install, 'resources', 'linked-data'),
        'junction'
      )
      const include = readFileSync(join(repoRoot, 'build/installer.nsh'), 'utf8')
      const macros = [
        'preserveNamedDataRoot',
        'restoreNamedDataRoot',
        'preserveNestedDataRoot',
        'restoreNestedDataRoot'
      ]
        .map((name) => {
          const match = include.match(new RegExp(`!macro ${name} [\\s\\S]*?!macroend`))
          expect(match, name).not.toBeNull()
          return match![0]
        })
        .join('\n')
        .replace(/^\s*DetailPrint (.+)$/gm, 'FileWriteUTF16LE $9 $1')
        .replace(/^\s*MessageBox MB_OK\|MB_ICONSTOP (.+)$/gm, 'FileWriteUTF16LE $9 $1')
      const upstream = readFileSync(
        join(appBuilderLibRoot, 'templates/nsis/uninstaller.nsh'),
        'utf8'
      )
      const functions = ['un.atomicRMDir', 'un.restoreFiles']
        .map((name) => {
          const match = upstream.match(
            new RegExp(`Function ${name.replace('.', '\\.')}\\r?\\n[\\s\\S]*?FunctionEnd`)
          )
          expect(match, name).not.toBeNull()
          return match![0]
        })
        .join('\n')
      const deletion = upstream.match(
        / {2}# delete the installed files[\s\S]*?(?= {2}\$\{ifNot\} \$\{isKeepShortcuts\})/
      )?.[0]
      expect(deletion).toBeDefined()
      const compileAndRun = (name: string, body: string): void => {
        const executable = join(root, `${name}.exe`)
        const source = join(root, `${name}.nsi`)
        writeFileSync(
          source,
          `\uFEFFUnicode true\n!include LogicLib.nsh\n!define BUILD_RESOURCES_DIR "${join(repoRoot, 'build')}"\n!define PROJECT_DIR "${root}"\nName "Isolated update"\nOutFile "${executable}"\nInstallDir "${install}"\nRequestExecutionLevel user\nSilentInstall silent\nSilentUnInstall silent\n${body}`
        )
        const compiled = spawnSync(nsisCompiler!, ['/V2', source], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15_000
        })
        expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0)
        const run = spawnSync(executable, ['/S'], {
          windowsHide: true,
          timeout: 30_000,
          env: {
            ...powershellEnv,
            OPEN_SCIENCE_E2E_STORAGE_ROOT: '',
            OPEN_SCIENCE_CONFIG_ROOT: configRoot
          }
        })
        expect(run.error).toBeUndefined()
        expect(run.status).toBe(0)
      }
      const cleanupPath = join(repoRoot, 'build/windows-program-cleanup.nsh')
      const cleanup = existsSync(cleanupPath) ? readFileSync(cleanupPath, 'utf8') : ''
      require('./compile-windows-install-publication.cjs')(
        join(repoRoot, 'build/windows-install-publication.cs'),
        join(root, 'out/windows-installer/ia32/windows-install-publication.dll')
      )
      for (const version of ['old', 'current']) {
        compileAndRun(
          `generate-${version}`,
          `
!define BUILD_UNINSTALLER
!define isUpdated "1 == 1"
!define APP_EXECUTABLE_FILENAME "open-science.exe"
!define UNINSTALL_FILENAME "Uninstall open-science.exe"
${version === 'current' ? cleanup : ''}
${functions}
Section
WriteUninstaller "${root}\\${version}-uninstaller.exe"
SectionEnd
Section "un.fixture"
InitPluginsDir
${deletion}
SectionEnd
`
        )
      }
      const installUtil = readFileSync(
        join(appBuilderLibRoot, 'templates/nsis/include/installUtil.nsh'),
        'utf8'
      )
      const selection = installUtil.match(
        / {2}StrCpy \$uninstallerFileNameTemp "\$PLUGINSDIR\\old-uninstaller.exe"[\s\S]*?(?= {2}ExecWait)/
      )?.[0]
      expect(selection).toBeDefined()
      const copyOverride = include.match(/!macro customCopyUninstaller[\s\S]*?!macroend/)?.[0] ?? ''
      // Run the production preservation hooks around the real upstream uninstall deletion section.
      // Only fixture files are touched: no application registration, services or user profile writes.
      compileAndRun(
        'probe',
        `
!define UNINSTALLER_OUT_FILE "${root}\\current-uninstaller.exe"
Var uninstallerFileName
Var uninstallerFileNameTemp
!macro copyFile FROM TO
CopyFiles /SILENT "\${FROM}" "\${TO}"
!macroend
${copyOverride}
Var backup
Var backupBranded
Var dataProtectionFailed
Var dataRestoreFailed
${macros}
Section
InitPluginsDir
FileOpen $9 "${join(root, 'result.txt')}" w
StrCpy $dataProtectionFailed "0"
StrCpy $dataRestoreFailed "0"
StrCpy $uninstallerFileName "${root}\\old-uninstaller.exe"
!insertmacro preserveNestedDataRoot "$INSTDIR" $backup fixture
FileWriteUTF16LE $9 "|protection=$dataProtectionFailed"
${paths.map((path, index) => `IfFileExists "${join(install, path, 'research.csv')}" 0 +2\nFileWriteUTF16LE $9 "|in-place-${index}"`).join('\n')}
\${If} $dataProtectionFailed == "0"
${selection}
  # A live reader blocks deleting the application executable. Failed cleanup must preserve data
  # and leave the executable available to identify an incomplete uninstall; the next attempt works.
  System::Call 'kernel32::CreateFile(t "${applicationFile}", i 0x80000000, i 1, p 0, i 3, i 0, p 0) p.R6'
  ExecWait '"$uninstallerFileNameTemp" /S _?=${install}' $0
  FileWriteUTF16LE $9 "|locked=$0"
  ExecWait '"$uninstallerFileNameTemp" /S _?=${install}' $0
  FileWriteUTF16LE $9 "|still-locked=$0"
  IfFileExists "${applicationFile}" 0 +2
  FileWriteUTF16LE $9 "|application-retained"
${retryFiles.map((file, index) => `FileOpen $8 "${join(install, file)}" r\nFileRead $8 $7\nFileClose $8\nFileWriteUTF16LE $9 "|retry-${index}=$7"`).join('\n')}
  System::Call 'kernel32::CloseHandle(p R6)'
  ExecWait '"$uninstallerFileNameTemp" /S _?=${install}' $0
  FileWriteUTF16LE $9 "|cleanup-failed=$0"
  IfFileExists "${join(install, 'Uninstall open-science.exe')}" 0 +2
  FileWriteUTF16LE $9 "|uninstaller-retained"
  ExecWait '"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${restoreAcl}"' $0
  FileWriteUTF16LE $9 "|acl-restored=$0"
  ExecWait '"$uninstallerFileNameTemp" /S _?=${install}' $0
  FileWriteUTF16LE $9 "|first-uninstall=$0"
  # Match the updater's existing one-retry budget. A standalone uninstall can truthfully fail
  # on a transient program-file lock; data must remain readable before that retry too.
  \${If} $0 != 0
    FileWriteUTF16LE $9 "|retried"
${paths.map((path, index) => `FileOpen $8 "${join(install, path, 'research.csv')}" r\nFileRead $8 $7\nFileWriteUTF16LE $9 "|retry-data-${index}=$7"\nFileRead $8 $7\nFileWriteUTF16LE $9 "$7"\nFileClose $8`).join('\n')}
    Sleep 1000
    ExecWait '"$uninstallerFileNameTemp" /S _?=${install}' $0
  \${EndIf}
  FileWriteUTF16LE $9 "|uninstall=$0"
  !insertmacro restoreNestedDataRoot "$INSTDIR" $backup
\${EndIf}
FileWriteUTF16LE $9 "|restore=$dataRestoreFailed"
FileClose $9
SectionEnd
`
      )
      const result = readFileSync(join(root, 'result.txt'), 'utf16le')
      if (result.includes('|retried'))
        paths.forEach((_, index) => expect(result).toContain(`|retry-data-${index}=${content}`))
      expect(result).toContain('|restore=0')
      expect(result).toContain('|protection=0')
      expect(result).toContain('|uninstall=0')
      expect(existsSync(applicationFile)).toBe(false)
      // Co-located data is supported: the update must proceed and preserve all research bytes at
      // their original paths. Blocking updates or requiring relocation does not satisfy the contract.
      for (const path of paths) {
        const file = join(install, path, 'research.csv')
        expect(existsSync(file), `Research file deleted during update: ${path}`).toBe(true)
        expect(readFileSync(file, 'utf8')).toBe(content)
      }
      paths.forEach((_, index) => expect(result).toContain(`|in-place-${index}`))
      expect(result).toContain('|locked=2|still-locked=2|application-retained')
      expect(result).toContain('|cleanup-failed=2|uninstaller-retained|acl-restored=0')
      retryFiles.forEach((_, index) =>
        expect(result).toContain(`|retry-${index}=retry-payload-${index}`)
      )
      expect(
        readdirSync(install).sort(),
        readdirSync(install, { recursive: true }).join('\n')
      ).toEqual(
        [
          'workspaces',
          'content',
          'custom-research',
          'OpenScience',
          'Open-Science',
          'resources',
          'locales'
        ].sort()
      )
    } finally {
      if (existsSync(restoreAcl)) {
        const restored = spawnSync(
          powershell,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', restoreAcl],
          { windowsHide: true, timeout: 15_000, env: powershellEnv }
        )
        expect(restored.status, 'restore fixture-only ACL before cleanup').toBe(0)
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
  60_000
)

describe('packaging config', () => {
  it('uses the bundled selective uninstaller for the first attempt, fallback and retry', () => {
    const include = readFileSync(join(repoRoot, 'build/installer.nsh'), 'utf8')
    const util = readFileSync(
      join(appBuilderLibRoot, 'templates/nsis/include/installUtil.nsh'),
      'utf8'
    )
    const selection = include.match(/!macro customCopyUninstaller[\s\S]*?!macroend/)?.[0] ?? ''
    expect(selection).toContain(
      'File "/oname=$PLUGINSDIR\\old-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"'
    )
    expect(selection).toContain('StrCpy $uninstallerFileName "$PLUGINSDIR\\old-uninstaller.exe"')
    expect(util).toContain('!insertmacro customCopyUninstaller')
    expect(util.indexOf('!insertmacro customCopyUninstaller')).toBeLessThan(
      util.indexOf('  ExecWait')
    )
    const retry = include.match(/!macro uninstallFailureRecoveryAt[\s\S]*?!macroend/)?.[0] ?? ''
    expect(retry).toContain('"$PLUGINSDIR\\old-uninstaller.exe" /S /KEEP_APP_DATA')
    expect(retry).not.toContain('Rename ')
    expect(retry).not.toContain('preserveRetryDataRoot')
  })

  it.skipIf(process.platform !== 'win32')(
    'covers the installed Electron program payload without a wildcard sweep',
    () => {
      const cleanup = readFileSync(join(repoRoot, 'build/windows-program-cleanup.nsh'), 'utf8')
      const electronRoot = dirname(require('electron') as string)
      for (const name of readdirSync(electronRoot)) {
        // electron-builder renames the executable/LICENSE and excludes its development version file.
        const installed =
          name === 'electron.exe'
            ? '${APP_EXECUTABLE_FILENAME}'
            : name === 'LICENSE'
              ? 'LICENSE.electron.txt'
              : name
        if (name === 'version') continue
        expect(cleanup, installed).toContain(installed)
      }
      expect(cleanup).not.toMatch(/^\s*RMDir \/r/m)
      expect(cleanup).not.toContain('Delete "$INSTDIR\\*')
    }
  )

  it('excludes previous dist artifacts when the output directory is overridden', () => {
    const config = load(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')) as {
      files: string[]
    }
    const { FileMatcher } = appBuilderRequire('./out/fileMatcher')
    const matcher = new FileMatcher(
      repoRoot,
      join(tmpdir(), 'external-package-output'),
      (s: string) => s,
      ['**/*', ...config.files]
    )
    const filter = matcher.createFilter()
    const file = statSync(join(repoRoot, 'package.json'))
    const directory = statSync(repoRoot)
    expect(filter(join(repoRoot, 'dist'), directory)).toBe(false)
    expect(filter(join(repoRoot, 'dist', 'old-setup.exe'), file)).toBe(false)
    expect(filter(join(repoRoot, 'dist', 'win-unpacked', 'resources', 'app.asar'), file)).toBe(
      false
    )
    expect(filter(join(repoRoot, 'out', 'main', 'index.js'), file)).toBe(true)
    expect(filter(join(repoRoot, 'node_modules', 'zod', 'dist', 'index.js'), file)).toBe(true)
  })

  it('loads both tiktoken WASM encodings from a packed ASAR in Electron', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tiktoken-asar-')))
    try {
      const source = join(root, 'source')
      const archive = join(root, 'app.asar')
      mkdirSync(source)
      cpSync(dirname(require.resolve('tiktoken')), join(source, 'node_modules', 'tiktoken'), {
        recursive: true
      })
      writeFileSync(
        join(source, 'probe.cjs'),
        `const { get_encoding } = require('tiktoken')
const counts = {}
for (const profile of ['cl100k_base', 'o200k_base']) {
  const encoding = get_encoding(profile)
  try {
    counts[profile] = encoding.encode('x'.repeat(1024)).length
  } finally {
    encoding.free()
  }
}
process.stdout.write(JSON.stringify({ counts, modulePath: require.resolve('tiktoken') }))
`
      )
      // ASAR resolves with a writable stream before its queued writes finish.
      const archiveStream = await createPackageWithOptions(source, archive, {})
      await finished(archiveStream)
      expect(listPackage(archive).map((entry: string) => entry.replaceAll('\\', '/'))).toContain(
        '/node_modules/tiktoken/tiktoken_bg.wasm'
      )
      // Remove the source tree so the child can only load the archived JavaScript and WASM.
      rmSync(source, { recursive: true, force: true })
      const result = spawnSync(require('electron') as string, [join(archive, 'probe.cjs')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        // A byte-length fallback would return 256; both real encodings return 128.
        counts: { cl100k_base: 128, o200k_base: 128 },
        modulePath: join(archive, 'node_modules', 'tiktoken', 'tiktoken.cjs')
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['module', 'commonjs', undefined])(
    'runs unpacked notebook scripts beneath an ancestor package with type %s',
    async (type) => {
      const root = mkdtempSync(join(tmpdir(), 'notebook-package-scope-'))
      try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ type }))
        const source = join(root, 'source')
        const resources = join(root, 'installed', 'resources')
        mkdirSync(source)
        mkdirSync(resources, { recursive: true })
        // The app manifest stays inside app.asar, outside the unpacked scripts' ancestor chain.
        writeFileSync(join(source, 'package.json'), '{"type":"commonjs"}')
        cpSync(join(repoRoot, 'resources/notebook'), join(source, 'resources/notebook'), {
          recursive: true
        })
        await createPackageWithOptions(source, join(resources, 'app.asar'), {
          unpackDir: 'resources'
        })
        const notebook = join(resources, 'app.asar.unpacked', 'resources', 'notebook')
        const run = (script: string, args: string[] = [], input = ''): SpawnSyncReturns<string> =>
          spawnSync(process.execPath, [join(notebook, script), ...args], {
            cwd: root,
            input,
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          })

        const repl = run('repl_loop.js', [], '{"req_id":"scope","code":"return 6 * 7"}\n')
        expect(repl.stderr).toBe('')
        expect(repl.status).toBe(0)
        expect(JSON.parse(repl.stdout)).toMatchObject({
          req_id: 'scope',
          error: null,
          result: '42'
        })

        const receiptId = 'scope-test'
        const pending = join(root, `kernel.pending.${receiptId}.json`)
        writeFileSync(pending, JSON.stringify({ receiptId }))
        const host = run('kernel_process_host.js', [
          pending,
          receiptId,
          process.execPath,
          '-e',
          'process.stdout.write("started")'
        ])
        expect(host.stderr).toBe('')
        expect(host.status).toBe(0)
        expect(host.stdout).toBe('started')

        // Reach the real worker's protocol validation without creating evidence or requiring Git.
        const worker = run('file_evidence_worker.js', [], '{"operation":"invalid"}')
        expect(worker.stderr).toBe('')
        expect(worker.status).toBe(1)
        expect(JSON.parse(worker.stdout)).toEqual({
          ok: false,
          error: 'Unsupported file-evidence worker operation.'
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('keeps the macOS internal bundle name aligned with generated Helper names', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    const productName = yml.match(/^productName: (.+)$/m)?.[1]
    const bundleName = yml.match(/^ {4}CFBundleName: (.+)$/m)?.[1]
    // Electron resolves its Helper using CFBundleName; electron-builder names it from productName.
    // Finder branding belongs in CFBundleDisplayName and dmg.contents.name instead.
    expect(productName).toBeTruthy()
    expect(bundleName).toBe(productName)
  })

  it('ships the exec-loop scripts unpacked from the asar', () => {
    // The notebook driver resolves <process.resourcesPath>/notebook/python_loop.py and
    // .../r_loop.R in the packaged app, so both must exist in the repo AND asarUnpack must cover
    // them (electron-builder only unpacks matched globs).
    expect(existsSync(join(repoRoot, 'resources/notebook/python_loop.py'))).toBe(true)
    expect(existsSync(join(repoRoot, 'resources/notebook/r_loop.R'))).toBe(true)
    expect(existsSync(join(repoRoot, 'resources/notebook/kernel_process_host.js'))).toBe(true)
    expect(existsSync(join(repoRoot, 'resources/notebook/file_evidence_worker.js'))).toBe(true)
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    const { asarUnpack } = load(yml) as { asarUnpack: string[] }
    expect(
      asarUnpack.some((pattern) => ['resources/**', 'resources/notebook/**'].includes(pattern))
    ).toBe(true)
  })

  it('ships the versioned Specialist contribution template guidance unpacked from the asar', () => {
    expect(existsSync(join(repoRoot, 'resources/specialists/template/v1/README.txt'))).toBe(true)
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect((load(yml) as { asarUnpack: string[] }).asarUnpack).toContain('resources/**')
  })

  it('ships micromamba only through the backend resource tree on every platform', () => {
    const config = load(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')) as {
      extraResources: Array<{ from: string; to: string }>
      mac?: { extraResources?: Array<{ from: string; to: string }> }
      win?: { extraResources?: Array<{ from: string; to: string }> }
      linux?: { extraResources?: Array<{ from: string; to: string }> }
    }
    expect(config.extraResources).toContainEqual({ from: 'out/desktop-backend', to: 'backend' })
    for (const platform of ['mac', 'win', 'linux'] as const)
      for (const entry of [...config.extraResources, ...(config[platform]?.extraResources ?? [])])
        expect(entry.to).not.toMatch(/micromamba/)
  })

  it('macOS entitlements disable library validation for conda dylibs', () => {
    const plist = readFileSync(join(repoRoot, 'build/entitlements.mac.plist'), 'utf8')
    expect(plist).toContain('com.apple.security.cs.disable-library-validation')
    expect(plist).toContain('com.apple.security.cs.allow-dyld-environment-variables')
    expect(plist).toContain('com.apple.security.cs.allow-jit')
    expect(plist).toContain('com.apple.security.cs.allow-unsigned-executable-memory')
  })

  it('the ad-hoc signer signs the bundled micromamba binary', () => {
    const hook = readFileSync(join(repoRoot, 'build/adhoc-sign.cjs'), 'utf8')
    expect(hook).toContain('micromamba')
  })
})

describe('NSIS installer include (build/installer.nsh)', () => {
  const include = readFileSync(join(repoRoot, 'build/installer.nsh'), 'utf8')

  it('overrides the failed-uninstall handling for both registry passes', () => {
    // electron-builder's handleUninstallResult turns ANY non-zero old-uninstaller exit code into
    // a fatal "Failed to uninstall old application files" dialog. The assisted installer
    // (oneClick: false) gets no exit-code normalization (quitSuccess is ONE_CLICK-only), so the
    // code is not trustworthy — the include must install the resilient handler for both the
    // SHELL_CONTEXT and the HKEY_CURRENT_USER passes.
    expect(include).toMatch(/!macro customUnInstallCheck\b/)
    expect(include).toMatch(/!macro customUnInstallCheckCurrentUser\b/)
  })

  it('hands the first failed old-uninstaller attempt to project recovery without a misleading close-app dialog', () => {
    // installUtil runs before customUnInstallCheck. If it loops internally, users see
    // appCannotBeClosed after five non-zero exits even though that same exit may mean a stale or
    // partially removed first-install registration. Return the first failure to the path-scoped
    // recovery in this include instead of blaming a process that may not exist.
    const installUtil = readFileSync(
      join(appBuilderLibRoot, 'templates/nsis/include/installUtil.nsh'),
      'utf8'
    )
    const uninstallOldVersion =
      installUtil.match(/Function uninstallOldVersion([\s\S]*?)FunctionEnd/)?.[1] ?? ''
    const checkResult = uninstallOldVersion.slice(uninstallOldVersion.indexOf('CheckResult:'))

    expect(uninstallOldVersion).not.toContain('$(appCannotBeClosed)')
    expect(checkResult).toMatch(/CheckResult:[\s\S]*?Return\s+DoesNotExist:/)
    expect(checkResult).not.toContain('Goto UninstallLoop')
  })

  it('normalizes completed uninstalls without hiding partial cleanup failures', () => {
    const cleanup = readFileSync(join(repoRoot, 'build/windows-program-cleanup.nsh'), 'utf8')
    expect(cleanup).toMatch(/Function un.onUninstSuccess\s+SetErrorLevel 0\s+FunctionEnd/)
    const recovery =
      include.match(/!macro uninstallFailureRecoveryAt DIR([\s\S]*?)!macroend/)?.[1] ?? ''
    expect(recovery).not.toContain('${FileExists}')
    expect(recovery.slice(recovery.indexOf('ExecWait'))).toMatch(
      /\$\{if\} \$R0 != 0[\s\S]*!insertmacro quitFailedUpdate/
    )
    for (const script of [
      'windows-update-handoff-uninstall.ps1',
      'windows-notebook-sandbox-uninstall.ps1',
      'windows-runtime-cache-uninstall.ps1'
    ]) {
      expect(include).toContain(`File "\${BUILD_RESOURCES_DIR}\\${script}"`)
      expect(include).toContain(`-File "$PLUGINSDIR\\${script}"`)
    }
  })

  it('force-kills install-dir processes and retries the old uninstaller once before failing', () => {
    // The real-lock case: a background child running from the install dir (micromamba
    // provisioning, the CLI in Node mode, an agent child) still holds files. Sweep by executable
    // path (Win32_Process has ExecutablePath, NOT Path) and by image name (taskkill fallback),
    // then retry once; only a repeated failure keeps the original fatal dialog + exit code 2.
    expect(include).toContain('$$_.ExecutablePath')
    expect(include).not.toContain('$$_.Path.')
    expect(include).toContain('taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"')
    expect(include).toContain('$(uninstallFailed): $R0')
    expect(include).toContain('SetErrorLevel 2')
  })

  it('runs the image-name taskkill only as a fallback when the PowerShell sweep cannot run', () => {
    // taskkill /IM matches the exe name in ANY directory — a second install or the portable zip
    // copy would be killed too, discarding unsaved work. It must fire only when the path-scoped
    // PowerShell sweep failed to run (nsExec pushes "error" or a non-zero exit code). micromamba
    // and the Notebook AppContainer host are included: their image names differ from the app exe,
    // so the app-exe kill alone cannot cover an in-flight provisioning or sandbox-host lock on
    // PowerShell-blocked machines.
    const code = include
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(code.match(/taskkill/g) ?? []).toHaveLength(3)
    // Capture the whole guard block and assert BOTH kills live inside it — asserting only the
    // first one's position would still pass with micromamba's taskkill moved outside the guard.
    const guardBlock = code.match(/\$\{if\} \$R1 != 0([\s\S]*?)\$\{endif\}/)?.[1] ?? ''
    expect(guardBlock).toContain('taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"')
    expect(guardBlock).toContain('taskkill /F /IM micromamba.exe')
    expect(guardBlock).toContain('taskkill /F /IM "notebook-appcontainer-host.exe"')
    expect(guardBlock.match(/taskkill/g) ?? []).toHaveLength(3)
  })

  it('retries the old uninstaller exactly once', () => {
    // A single follow-up attempt after the kill; the original ExecWait lives in
    // electron-builder's uninstallOldVersion, so exactly one may appear here. Assert the
    // invocation's semantic parts rather than the full literal line, so a benign reformat
    // (flag reorder, whitespace) does not break the test without a behavior change.
    const attempts = include.match(/ExecWait '"\$PLUGINSDIR\\old-uninstaller\.exe/g) ?? []
    expect(attempts).toHaveLength(1)
    expect(include).toContain('/S /KEEP_APP_DATA $0')
    expect(include).toContain('_?=${DIR}')
  })

  it('discovers interrupted data backups before uninstall and restores them afterwards', () => {
    // Only historical backups are adopted. Live data stays in place; each post-uninstall hook
    // restores the historical root even when the first attempt returns zero.
    const init = include.match(/!macro customInit([\s\S]*?)!macroend/)?.[1] ?? ''
    const machineProtection =
      include.match(/!macro protectMachineDataRootForSelectedMode([\s\S]*?)!macroend/)?.[1] ?? ''
    const shellCheck = include.match(/!macro customUnInstallCheck([\s\S]*?)!macroend/)?.[1] ?? ''
    const userCheck =
      include.match(/!macro customUnInstallCheckCurrentUser([\s\S]*?)!macroend/)?.[1] ?? ''

    expect(init).toContain('ReadRegStr $perMachineInstallDirCache HKEY_LOCAL_MACHINE')
    expect(init).toContain('ReadRegStr $perUserInstallDirCache HKEY_CURRENT_USER')
    expect(init).not.toContain('ReadRegStr $shellInstallDirCache SHELL_CONTEXT')
    expect(init.match(/!insertmacro preserveNestedDataRoot/g) ?? []).toHaveLength(1)
    expect(machineProtection).toContain(
      '!insertmacro preserveNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup machine'
    )
    expect(init).toContain(
      '!insertmacro preserveNestedDataRoot $perUserInstallDirCache $perUserDataBackup per-user'
    )
    expect(shellCheck.indexOf('!insertmacro restoreNestedDataRoot')).toBeGreaterThan(-1)
    expect(shellCheck.indexOf('!insertmacro restoreNestedDataRoot')).toBeGreaterThan(
      shellCheck.indexOf('${if} $R0 != 0')
    )
    expect(userCheck.indexOf('!insertmacro restoreNestedDataRoot')).toBeGreaterThan(-1)
    expect(userCheck.indexOf('!insertmacro restoreNestedDataRoot')).toBeGreaterThan(
      userCheck.indexOf('${if} $R0 != 0')
    )
    expect(include).toContain('!define MUI_CUSTOMFUNCTION_ABORT restorePreservedOnAbort')
    expect(include).toContain('Function restorePreservedOnAbort')
    expect(include).toContain('Function .onInstFailed')
    // Normal GUI shutdown includes the unelevated -> elevated UAC handoff. Restoring there would
    // race the inner installer's later HKCU uninstall pass; interrupted backups are deterministic
    // and are adopted by the next installer instead.
    expect(include).not.toContain('Function .onGUIEnd')
  })

  it('waits for the final all-users mode before touching a distinct machine data root', () => {
    // customInit runs before an elevated assisted user makes the final install-mode choice. A
    // current-user install must not fail because an unrelated HKLM data folder is busy. Keep the
    // silent path protected in customInit, but otherwise chain protection into the instfiles-page
    // preflight, after the mode page has committed the final selection and before the section runs.
    const init = include.match(/!macro customInit([\s\S]*?)!macroend/)?.[1] ?? ''
    const machineProtection =
      include.match(/!macro protectMachineDataRootForSelectedMode([\s\S]*?)!macroend/)?.[1] ?? ''
    const pageHook = include.match(/!macro customPageAfterChangeDir([\s\S]*?)!macroend/)?.[1] ?? ''
    const header = include.match(/!macro customHeader([\s\S]*?)!macroend/)?.[1] ?? ''
    const selectedModeAt = machineProtection.indexOf('$installMode == "all"')
    const preserveMachineAt = machineProtection.indexOf(
      '!insertmacro preserveNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup machine'
    )

    expect(init).not.toContain(
      '!insertmacro preserveNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup machine'
    )
    expect(init).toMatch(
      /\$\{if\} \$\{Silent\}[\s\S]*!insertmacro protectMachineDataRootForSelectedMode/
    )
    expect(selectedModeAt).toBeGreaterThan(-1)
    expect(selectedModeAt).toBeLessThan(preserveMachineAt)
    expect(pageHook).toContain(
      '!define openScienceOriginalInstFilesPre ${MUI_PAGE_CUSTOMFUNCTION_PRE}'
    )
    expect(pageHook).toContain(
      '!define MUI_PAGE_CUSTOMFUNCTION_PRE protectNestedDataRootsForInstall'
    )
    expect(header).toContain('Call ${openScienceOriginalInstFilesPre}')
    expect(header).toContain('!insertmacro protectMachineDataRootForSelectedMode')
  })

  it('defers a shared machine-owned data root to the elevated inner installer', () => {
    // With matching HKCU/HKLM registrations, an unelevated assisted outer process may not be
    // allowed to rename a Program Files child. Probe the sibling directory non-destructively and
    // defer to the elevated inner .onInit when it is not writable, instead of aborting before UAC.
    const init = include.match(/!macro customInit([\s\S]*?)!macroend/)?.[1] ?? ''
    const probeAt = init.indexOf('GetTempFileName $R9 "$R2"')
    const preserveAt = init.indexOf(
      '!insertmacro preserveNestedDataRoot $perUserInstallDirCache $perUserDataBackup per-user'
    )

    expect(init).toContain('${andIfNot} ${UAC_IsAdmin}')
    expect(init).toContain('$perMachineInstallDirCache == $perUserInstallDirCache')
    expect(probeAt).toBeGreaterThan(-1)
    expect(probeAt).toBeLessThan(preserveAt)
    expect(init).toContain('Deferring shared data-folder protection to the elevated installer.')
  })

  it('normalizes registered Windows paths before testing whether they share a directory', () => {
    // NSIS string equality is already case-insensitive, but registry values for the same Windows
    // directory may differ by harmless trailing separators. Normalize both cached locations in
    // place before any shared-path branch so the UAC probe, backup aliasing, and handoff restore
    // all make the same decision.
    const normalizer =
      include.match(/Function normalizeRegisteredInstallPath([\s\S]*?)FunctionEnd/)?.[1] ?? ''
    const init = include.match(/!macro customInit([\s\S]*?)!macroend/)?.[1] ?? ''
    const normalizeMachineAt = init.indexOf(
      'Push $perMachineInstallDirCache\n  Call normalizeRegisteredInstallPath'
    )
    const normalizeUserAt = init.indexOf(
      'Push $perUserInstallDirCache\n  Call normalizeRegisteredInstallPath'
    )
    const firstSharedPathCheckAt = init.indexOf(
      '$perMachineInstallDirCache == $perUserInstallDirCache'
    )

    expect(normalizer).toContain('StrCmp $R1 "\\"')
    expect(normalizer).toContain('StrCmp $R1 "/"')
    expect(normalizeMachineAt).toBeGreaterThan(-1)
    expect(normalizeUserAt).toBeGreaterThan(-1)
    expect(normalizeMachineAt).toBeLessThan(firstSharedPathCheckAt)
    expect(normalizeUserAt).toBeLessThan(firstSharedPathCheckAt)
  })

  it('passes the install dir to PowerShell as an argument, with a directory-boundary match', () => {
    // Custom install dirs may contain apostrophes: interpolating the path into the script source
    // would break the command (or worse, inject into it). The dir goes in as $args[0] and the
    // prefix match is anchored with a trailing backslash so sibling directories never match.
    expect(include).toContain('$$args[0].TrimEnd')
    expect(include).toContain('$$_.ExecutablePath.StartsWith($$root')
    expect(include).not.toContain(`StartsWith('$INSTDIR'`)
  })

  it('caches the per-user install location before the HKCU uninstall pass deletes it', () => {
    // A successful per-user uninstall deletes HKCU InstallLocation, so reading it inside the hook
    // — after the pass — always comes up empty in exactly the spurious-failure case the hook
    // exists for. customInit runs before any uninstall pass; the hook must consume its cached
    // value and fall back to the default fatal handling only when no per-user install was
    // registered at install start.
    expect(include).toMatch(/\$\{if\} \$perUserInstallDirCache == ""/)
    expect(include).toContain('!insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache')
    expect(include).toContain('!insertmacro uninstallFailureRecoveryAt $INSTDIR')
    // The installer-only guard keeps the cache variables out of the separately compiled
    // uninstaller, where file-scope declarations would be unused and fail makensis warnings.
    const initHook = include.match(/!macro customInit([\s\S]*?)!macroend/)?.[1] ?? ''
    expect(include).toMatch(
      /!ifndef BUILD_UNINSTALLER[\s\S]*Var perUserInstallDirCache[\s\S]*!macro customInit/
    )
    expect(initHook).toContain(
      'ReadRegStr $perUserInstallDirCache HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation'
    )
    // The hook itself must not re-read the registry after the pass — that pins the broken order.
    // (Comments may name the value while explaining; strip them before checking.)
    const hkcuHook = (
      include.match(/!macro customUnInstallCheckCurrentUser([\s\S]*?)!macroend/)?.[1] ?? ''
    )
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(hkcuHook).not.toContain('readReg')
    expect(hkcuHook).not.toContain('InstallLocation')
  })

  it('never references symbols declared only after handleUninstallResult is parsed', () => {
    // makensis treats unknown variables as errors (electron-builder builds with warnings as
    // errors): handleUninstallResult is parsed BEFORE uninstallOldVersion / CHECK_APP_RUNNING
    // declare their globals, so the hook body must stay self-contained. Comment lines are
    // stripped before checking — they may name the variables while explaining this.
    const code = include
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(code).not.toContain('$installationDir')
    expect(code).not.toContain('$uninstallerFileNameTemp')
    expect(code).not.toContain('$PowerShellPath')
    expect(code).not.toContain('$CmdPath')
    expect(code).not.toContain('$IsPowerShellAvailable')
    expect(code).not.toContain('IS_POWERSHELL_AVAILABLE')
    expect(code).not.toContain('KILL_PROCESS')
  })

  it('the installed electron-builder still inserts the customUnInstallCheck hooks', () => {
    // The recovery runs only if app-builder-lib's handleUninstallResult keeps inserting these two
    // macro names. electron-builder is a caret-ranged dependency, so a routine bump could rename
    // or drop the insertion points — the macros would compile into dead code while every
    // assertion above stays green. Guard the integration contract itself so such an upgrade
    // fails here instead of silently reverting to the fatal dialog.
    const installUtil = readFileSync(
      join(appBuilderLibRoot, 'templates/nsis/include/installUtil.nsh'),
      'utf8'
    )
    expect(installUtil).toContain('!ifmacrodef customUnInstallCheck')
    expect(installUtil).toContain('!insertmacro customUnInstallCheck')
    expect(installUtil).toContain('!ifmacrodef customUnInstallCheckCurrentUser')
    expect(installUtil).toContain('!insertmacro customUnInstallCheckCurrentUser')
  })

  it('the installed electron-builder still inserts customInit before the uninstall passes', () => {
    // The install-dir cache and data preservation only run if installer.nsi keeps inserting
    // customInit in .onInit, before the install section invokes either old uninstaller.
    const installerNsi = readFileSync(
      join(appBuilderLibRoot, 'templates/nsis/installer.nsi'),
      'utf8'
    )
    expect(installerNsi).toContain('!ifmacrodef customInit')
    expect(installerNsi).toContain('!insertmacro customInit')
    expect(installerNsi.indexOf('!insertmacro customInit')).toBeLessThan(
      installerNsi.indexOf('Section "install"')
    )
  })

  it('records actionable cleanup failure reasons in the NSIS detail log', () => {
    expect(include).toContain('Open-Science Notebook cleanup failure code=$0')
    for (const code of [
      'parent-path-unresolved',
      'backup-already-exists',
      'restore-destination-exists',
      'restore-rename-failed'
    ]) {
      expect(include).toContain(`Open-Science data protection failure code=${code}`)
    }
  })
})

describe.skipIf(!nsisCompiler)('NSIS update receipt protocol', () => {
  it.each([
    'valid',
    'fallback',
    'ambiguous-roots',
    'surrounded',
    'duplicate',
    'missing',
    'invalid'
  ])('publishes correlated receipts for %s operation arguments', (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'nsis-receipt-'))
    try {
      const operation = '00000000-0000-4000-8000-000000000001'
      const primary = join(root, 'primary')
      const fallback = join(root, 'fallback')
      const directory = join(scenario === 'fallback' ? fallback : primary, operation)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'request.json'), '{}')
      if (scenario === 'ambiguous-roots') {
        mkdirSync(join(fallback, operation), { recursive: true })
        writeFileSync(join(fallback, operation, 'request.json'), '{}')
      }
      const include = readFileSync(join(repoRoot, 'build/windows-update-handoff.nsh'), 'utf8')
      const redirected = include
        .replace(
          '"$APPDATA\\Open-Science\\UpdateHandoffs\\$updateOperation"',
          `"${primary}\\$updateOperation"`
        )
        .replace(
          '"$APPDATA\\Open-Science-UpdateHandoffs\\$updateOperation"',
          `"${fallback}\\$updateOperation"`
        )
      expect(redirected).not.toBe(include)
      const includeDirective = readFileSync(join(repoRoot, 'build/installer.nsh'), 'utf8').match(
        /^!include .*windows-update-handoff\.nsh"\r?$/m
      )?.[0]
      expect(includeDirective).toBeDefined()
      writeFileSync(join(root, 'windows-update-handoff.nsh'), redirected)
      const executable = join(root, 'probe.exe')
      const source = join(root, 'probe.nsi')
      writeFileSync(
        source,
        `\uFEFFUnicode true
!define BUILD_RESOURCES_DIR "${root}"
${includeDirective}
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Name "Isolated update receipt regression"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
Var installMode
!insertmacro defineUpdateReceiptFunctions
Section
StrCpy $installMode "current"
Call initializeUpdateReceipts
Push "installing"
Call writeUpdateReceipt
Push "installed"
Call writeUpdateReceipt
Push "failed"
Call writeUpdateReceipt
SectionEnd
`
      )
      const compile = spawnSync(nsisCompiler!, ['/V2', source], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      // Exercise the actual patched updater's argument transport, including its surrounding flags.
      const { NsisUpdater } = require('electron-updater/out/NsisUpdater')
      let args: string[] = []
      expect(
        NsisUpdater.prototype.doInstall.call(
          {
            installerPath: executable,
            openScienceUpdateOperation: operation,
            spawnLog: async (_file: string, values: string[]) => {
              args = values
            },
            dispatchError: (error: Error) => {
              throw error
            }
          },
          { isSilent: false, isForceRunAfter: true }
        )
      ).toBe(true)
      if (scenario === 'surrounded') args.push('/S', '--unused=value with spaces')
      if (scenario === 'duplicate') args.push(`--open-science-update-operation=${operation}`)
      if (scenario === 'missing') args = []
      if (scenario === 'invalid') args = ['--open-science-update-operation=../outside']
      const execution = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000 })
      expect(execution.status, execution.stderr || execution.stdout).toBe(0)
      for (const stage of ['accepted', 'installing', 'installed', 'failed']) {
        const receipt = join(directory, `${stage}.receipt`)
        const valid = scenario === 'valid' || scenario === 'surrounded' || scenario === 'fallback'
        expect(existsSync(receipt)).toBe(valid)
        if (valid) expect(readFileSync(receipt, 'utf8')).toBe(`${operation}\r\n${stage}\r\n`)
        if (scenario === 'ambiguous-roots')
          expect(existsSync(join(fallback, operation, `${stage}.receipt`))).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
