import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// Requires the real versioned NSIS fixture built by fixtures/windows-update-notice/build.mjs.
// Opt in on a Windows desktop at medium integrity. Portable CI does not certify native dialogs.
const fixture = process.env.OPEN_SCIENCE_UPDATE_NOTICE_FIXTURE
const makensis = process.env.OPEN_SCIENCE_MAKENSIS

// These small native programs execute the production NSIS instructions without registering or
// replacing an application. Keep failures on disk for diagnosis; no UI automation is involved.
describe.skipIf(process.platform !== 'win32' || !makensis)(
  'NSIS update handoff failure paths',
  () => {
    const hook = readFileSync('build/installer.nsh', 'utf8')
    const nativeProbe = (name: string, section: string): string => {
      const parent = resolve('tmp/nsis-handoff-regression')
      mkdirSync(parent, { recursive: true })
      const root = mkdtempSync(join(parent, `${name}-`))
      const source = join(root, 'probe.nsi')
      const executable = join(root, 'probe.exe')
      const preflight = hook.match(
        / {2}Function ensureExistingUninstallerIsWritable\r?\n[\s\S]*? {2}FunctionEnd/
      )?.[0]
      expect(preflight).toBeDefined()
      writeFileSync(
        source,
        [
          'Unicode true',
          'RequestExecutionLevel user',
          'SilentInstall silent',
          `OutFile "${executable}"`,
          '!include LogicLib.nsh',
          '!define isUpdated \'"0" == "1"\'',
          '!define isForceRun \'"0" == "1"\'',
          '!define UNINSTALL_FILENAME "fixture-uninstaller.exe"',
          `!define BUILD_RESOURCES_DIR "${resolve('build')}"`,
          `!include "${resolve('build/installer.nsh')}"`,
          'Var installMode',
          '!insertmacro defineUpdateReceiptFunctions',
          preflight,
          'Section',
          'StrCpy $INSTDIR "$EXEDIR"',
          'StrCpy $updateReceiptRoot "$EXEDIR"',
          'StrCpy $updateOperation "6157a13e-f045-406d-a985-cab500eb0ce3"',
          section,
          'SectionEnd'
        ].join('\n')
      )
      const compile = spawnSync(makensis!, ['/V2', source], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000
      })
      expect(compile.error).toBeUndefined()
      expect(compile.status, compile.stdout + compile.stderr).toBe(0)
      const run = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      expect(run.error).toBeUndefined()
      writeFileSync(
        join(root, 'result.json'),
        JSON.stringify({ exitCode: run.status, stdout: run.stdout, stderr: run.stderr })
      )
      expect(run.status, `${name}: evidence in ${root}`).toBe(name === 'locked' ? 2 : 0)
      return root
    }

    it('preserves uninstall arguments while selecting and restoring the retry temp directory', () => {
      const preparation = hook.match(
        / {4}StrCpy \$R5 ""\r?\n {4}ClearErrors[\s\S]*?(?= {4}ExecWait '"\$PLUGINSDIR\\old-uninstaller.exe)/
      )?.[0]
      const restoration = hook.match(
        / {4}ExecWait '"\$PLUGINSDIR\\old-uninstaller.exe[^\n]*\n([\s\S]*?)(?= {4}!insertmacro restoreRetryDataRoot)/
      )?.[1]
      expect(preparation).toBeDefined()
      expect(restoration).toBeDefined()
      const root = nativeProbe(
        'retry-arguments',
        [
          'StrCpy $0 "/currentuser --keep-shortcuts --updated"',
          'ReadEnvStr $7 "TEMP"',
          'ReadEnvStr $8 "TMP"',
          preparation!.replaceAll('${DIR}', '$INSTDIR'),
          'FileOpen $9 "$EXEDIR\\arguments.txt" w',
          'FileWrite $9 "$0$\\r$\\n$R6$\\r$\\n"',
          restoration,
          'ReadEnvStr $R2 "TEMP"',
          'ReadEnvStr $R3 "TMP"',
          '${if} $7 != $R2',
          'SetErrorLevel 41',
          '${endif}',
          '${if} $8 != $R3',
          'SetErrorLevel 42',
          '${endif}',
          'FileWrite $9 "$0$\\r$\\n"',
          'FileClose $9'
        ].join('\n')
      )
      expect(readFileSync(join(root, 'arguments.txt'), 'utf8')).toBe(
        '/currentuser --keep-shortcuts --updated\r\n1\r\n/currentuser --keep-shortcuts --updated\r\n'
      )
    })

    it('keeps the caller registers intact when probing a writable uninstaller', () => {
      const root = nativeProbe(
        'writable',
        [
          'FileOpen $9 "$INSTDIR\\${UNINSTALL_FILENAME}" w',
          'FileClose $9',
          'StrCpy $0 "/currentuser --updated"',
          'Call ensureExistingUninstallerIsWritable',
          'FileOpen $9 "$EXEDIR\\arguments.txt" w',
          'FileWrite $9 "$0"',
          'FileClose $9'
        ].join('\n')
      )
      expect(readFileSync(join(root, 'arguments.txt'), 'utf8')).toBe('/currentuser --updated')
    })

    it('publishes a failure receipt before quitting on a locked uninstaller', () => {
      const root = nativeProbe(
        'locked',
        [
          'FileOpen $9 "$INSTDIR\\${UNINSTALL_FILENAME}" w',
          'FileClose $9',
          'System::Call \'kernel32::CreateFile(t "$INSTDIR\\${UNINSTALL_FILENAME}", i 0x80000000, i 1, p 0, i 3, i 0x80, p 0) p.r8\'',
          'Call ensureExistingUninstallerIsWritable',
          "System::Call 'kernel32::CloseHandle(p r8)'",
          'SetErrorLevel 43'
        ].join('\n')
      )
      expect(readFileSync(join(root, 'failed.receipt'), 'utf8')).toBe(
        '6157a13e-f045-406d-a985-cab500eb0ce3\r\nfailed\r\n'
      )
    })
  }
)

describe.skipIf(process.platform !== 'win32' || !fixture)('Windows update failure notice', () => {
  const root = resolve(fixture ?? '.')
  const runner = join(root, 'notice-regression.exe')
  const env = { ...process.env }
  beforeAll(() => {
    expect(
      readFileSync(join(root, '0.26.0/installer.nsh'), 'utf8'),
      'Rebuild the native fixture after changing build/installer.nsh.'
    ).toBe(readFileSync('build/installer.nsh', 'utf8'))
    expect(readFileSync(join(root, 'elevation/installer.nsh'), 'utf8')).toBe(
      readFileSync('scripts/fixtures/windows-update-notice/elevation-probe.nsh', 'utf8') +
        readFileSync('build/installer.nsh', 'utf8')
    )
    expect(readFileSync(join(root, 'elevated-preflight/installer.nsh'), 'utf8')).toBe(
      readFileSync('scripts/fixtures/windows-update-notice/elevated-preflight-probe.nsh', 'utf8') +
        readFileSync('build/installer.nsh', 'utf8')
    )
    for (const [key, directory] of Object.entries({
      TEMP: 'temp',
      TMP: 'temp',
      APPDATA: 'profile/roaming',
      LOCALAPPDATA: 'profile/local'
    })) {
      env[key] = join(root, directory)
      mkdirSync(env[key]!, { recursive: true })
    }
    const compiler = join(process.env.WINDIR!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    const result = spawnSync(
      compiler,
      [
        '/nologo',
        `/out:${runner}`,
        resolve('scripts/fixtures/windows-update-notice/NoticeRegression.cs')
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
  it.each([
    'denied',
    'locked',
    'locked-retry',
    'denied-silent',
    'locked-silent',
    'denied-elevation',
    'denied-elevation-data',
    'denied-currentuser',
    'denied-elevated-target',
    'writable'
  ])(
    '%s: explains interactive failure and preserves safe installer behavior',
    (scenario) => {
      const result = spawnSync(runner, [root, scenario], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 90000
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain(`PASS: ${scenario}`)
    },
    95000
  )
  it('preserves a pre-existing machine fixture when setup refuses it', () => {
    const directory = join(root, 'machine-installed')
    const sentinel = join(directory, 'Uninstall open-science-update-notice-test.exe')
    mkdirSync(directory)
    try {
      writeFileSync(sentinel, 'pre-existing fixture')
      const result = spawnSync(runner, [root, 'denied-elevated-target'], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 90000
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Simulated machine install already exists.')
      expect(readFileSync(sentinel, 'utf8')).toBe('pre-existing fixture')
    } finally {
      if (existsSync(sentinel)) unlinkSync(sentinel)
      if (existsSync(directory)) rmdirSync(directory)
    }
  }, 95000)
})
