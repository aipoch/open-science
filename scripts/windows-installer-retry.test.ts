import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Run the actual NSIS preprocessor on the shipped hooks. This checks generated installer
// instructions on any build host; executing the resulting Windows installer is a separate lane.
const compiler = process.env.OPEN_SCIENCE_MAKENSIS
const optionPrefix = process.platform === 'win32' ? '/' : '-'

// The default portable lane guards the ownership contract even without an NSIS toolchain.
// Actual instruction expansion and compilation below remain opt-in, not Windows execution.
describe('Windows uninstall retry ownership contract', () => {
  it('keeps recreated directories separate from both authoritative registered backups', () => {
    const include = readFileSync('build/installer.nsh', 'utf8')
    const macro = (name: string): string => {
      const body = include.match(new RegExp(`!macro ${name}[^\\n]*\\n([\\s\\S]*?)!macroend`))?.[1]
      expect(body, `Missing installer macro ${name}`).toBeDefined()
      return body!
    }
    const recovery = macro('uninstallFailureRecoveryAt')
    const retry = recovery.indexOf('ExecWait ')
    expect(retry).toBeGreaterThan(0)
    for (const [name, slot, registered] of [
      ['OpenScience', '$retryLegacyDataBackup', '${REGISTERED_BACKUP}'],
      ['Open-Science', '$retryBrandedDataBackup', '${REGISTERED_BRANDED_BACKUP}']
    ]) {
      expect(recovery.slice(0, retry)).toContain(
        `!insertmacro preserveNamedRetryDataRoot "\${DIR}" ${slot} "${name}"`
      )
      expect(macro('restoreRetryDataRoots')).toContain(
        `!insertmacro restoreNamedRetryDataRoot "\${DIR}" ${slot} "${registered}" "${name}"`
      )
    }
    expect(recovery.slice(retry)).toContain('!insertmacro restoreRetryDataRoots ')
    expect(macro('preserveNamedRetryDataRoot')).toContain('Rename "${DIR}\\${NAME}" "${BACKUP}"')
    expect(macro('restoreNamedRetryDataRoot')).toContain('Rename "${BACKUP}" "${DIR}\\${NAME}"')
    expect(macro('customUnInstallCheck')).toContain('StrCpy $R9 $perUserBrandedDataBackup')
    expect(macro('customUnInstallCheck')).toContain('StrCpy $R9 $perMachineBrandedDataBackup')
    expect(macro('customUnInstallCheckCurrentUser')).toContain(
      '!insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache $perUserDataBackup $perUserBrandedDataBackup'
    )
    // The selected ownership pointers must survive process cleanup and both retry helpers.
    for (const body of [
      recovery,
      macro('preserveNamedRetryDataRoot'),
      macro('restoreNamedRetryDataRoot')
    ]) {
      expect(body).not.toMatch(
        /(?:StrCpy|Pop|ReadEnvStr|GetTempFileName|GetFullPathName) \$R[89]\b/
      )
    }
  })
})

describe.skipIf(!compiler)('Windows uninstall retry data protection', () => {
  it.each([
    ['customUnInstallCheck', '$INSTDIR', ['$R8', '$R9']],
    [
      'customUnInstallCheckCurrentUser',
      '$perUserInstallDirCache',
      ['$perUserDataBackup', '$perUserBrandedDataBackup']
    ]
  ] as const)(
    '%s protects both directory generations before the destructive retry',
    (hook, directory, registeredBackups) => {
      const root = mkdtempSync(join(tmpdir(), 'installer-retry-'))
      try {
        const installation = join(root, 'installed')
        const child = join(root, 'old-uninstaller.exe')
        const childSource = join(root, 'old-uninstaller.nsi')
        // The retry child removes only this test's private installation, like electron-builder's
        // old uninstaller. No real application or registry installation participates in the test.
        writeFileSync(
          childSource,
          [
            'Unicode true',
            'RequestExecutionLevel user',
            'SilentInstall silent',
            `OutFile "${child}"`,
            'Section',
            `StrCpy $INSTDIR "${installation}"`,
            'RMDir /r "$INSTDIR"',
            'SetErrorLevel 0',
            'SectionEnd'
          ].join('\n')
        )
        const childBuild = spawnSync(compiler!, [`${optionPrefix}V2`, childSource], {
          encoding: 'utf8'
        })
        expect(childBuild.status, childBuild.stdout + childBuild.stderr).toBe(0)
        const source = join(root, 'retry.nsi')
        writeFileSync(
          source,
          [
            'Unicode true',
            'RequestExecutionLevel user',
            'SilentInstall silent',
            '!include "LogicLib.nsh"',
            '!define APP_EXECUTABLE_FILENAME "open-science-retry-fixture-never-run.exe"',
            'LangString uninstallFailed 1033 "Uninstall failed"',
            'Var installMode',
            `!include "${resolve('build/installer.nsh')}"`,
            'Name "Retry protection fixture"',
            `OutFile "${join(root, 'retry.exe')}"`,
            'Function ensureExistingUninstallerIsWritable',
            'FunctionEnd',
            'Section',
            'InitPluginsDir',
            'SetOutPath "$PLUGINSDIR"',
            `File /oname=old-uninstaller.exe "${child}"`,
            `StrCpy $INSTDIR "${installation}"`,
            'StrCpy $perUserInstallDirCache $INSTDIR',
            'StrCpy $installMode "current"',
            // First protection saw no data; a still-live process then creates both directories.
            '!insertmacro preserveNestedDataRoot $INSTDIR $perUserDataBackup per-user',
            'CreateDirectory "$INSTDIR"',
            'FileOpen $1 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" w',
            'FileClose $1',
            ...['OpenScience', 'Open-Science'].flatMap((name) => [
              `CreateDirectory "$INSTDIR\\${name}"`,
              `FileOpen $1 "$INSTDIR\\${name}\\sentinel.txt" w`,
              `FileWrite $1 "recreated ${name}"`,
              'FileClose $1'
            ]),
            'StrCpy $R0 "2"',
            `!insertmacro ${hook}`,
            'SetErrorLevel 0',
            'SectionEnd'
          ].join('\n')
        )
        const result = spawnSync(compiler!, [`${optionPrefix}V2`, `${optionPrefix}PPO`, source], {
          encoding: 'utf8'
        })
        expect(result.status, result.stderr).toBe(0)
        const lines = result.stdout.split('\n')
        const retry = lines.findIndex(
          (line) => line.startsWith('ExecWait ') && line.includes('old-uninstaller.exe')
        )
        expect(retry).toBeGreaterThan(0)
        const slots = new Set<string>()
        for (const [index, name] of ['OpenScience', 'Open-Science'].entries()) {
          const prefix = `Rename "${directory}\\${name}" "`
          const preserve = lines.findLastIndex(
            (line, index) => index < retry && line.startsWith(prefix)
          )
          expect(preserve, `${name} must be moved out before retry`).toBeGreaterThan(-1)
          expect(preserve).toBeLessThan(retry)
          const slot = lines[preserve].slice(prefix.length, -1)
          slots.add(slot)
          const restore = lines.findIndex(
            (line, index) => index > retry && line === `Rename "${slot}" "${directory}\\${name}"`
          )
          expect(restore, `${name} must be restored after retry`).toBeGreaterThan(retry)
          const ownershipGuard = lines
            .slice(retry + 1, restore)
            .reverse()
            .find((line) => line.startsWith('IfFileExists '))
          expect(
            ownershipGuard,
            'Retain a recreated copy only for its own registered backup'
          ).toMatch(`IfFileExists \`${registeredBackups[index]}\\*.*\``)
        }
        expect(slots.size, 'Each generation needs a separate retry backup').toBe(2)

        // Compile the same expanded hooks too, catching invalid variables, plugins and NSIS syntax.
        const compiled = spawnSync(compiler!, [`${optionPrefix}V2`, source], { encoding: 'utf8' })
        expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0)
        expect(readFileSync(join(root, 'retry.exe')).subarray(0, 2).toString()).toBe('MZ')
        if (process.platform === 'win32') {
          const execution = spawnSync(join(root, 'retry.exe'), ['/S'], {
            encoding: 'utf8',
            timeout: 30000,
            windowsHide: true
          })
          expect(execution.status, execution.stdout + execution.stderr).toBe(0)
          for (const name of ['OpenScience', 'Open-Science']) {
            expect(readFileSync(join(installation, name, 'sentinel.txt'), 'utf8')).toBe(
              `recreated ${name}`
            )
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
