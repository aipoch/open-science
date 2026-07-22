import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..')

describe('packaging config', () => {
  it('ships the exec-loop scripts unpacked from the asar', () => {
    // The notebook driver resolves <process.resourcesPath>/notebook/python_loop.py and
    // .../r_loop.R in the packaged app, so both must exist in the repo AND asarUnpack must cover
    // them (electron-builder only unpacks matched globs).
    expect(existsSync(join(repoRoot, 'resources/notebook/python_loop.py'))).toBe(true)
    expect(existsSync(join(repoRoot, 'resources/notebook/r_loop.R'))).toBe(true)
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/asarUnpack:\s*\n\s*-\s*resources\/(\*\*|notebook\/\*\*)/)
  })

  it('ships micromamba as a per-platform extraResource to Contents/Resources', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    // Staged per-platform binaries copied to the resources root under the name micromamba(.exe).
    expect(yml).toContain('resources/bin/mac/${arch}/micromamba')
    expect(yml).toContain('resources/bin/win/${arch}/micromamba.exe')
    expect(yml).toContain('resources/bin/linux/${arch}/micromamba')
    expect(yml).toContain('to: micromamba')
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

  it('continues the install when the old version is already gone despite a non-zero exit code', () => {
    // The spurious-exit-2 case: the uninstall completed but a benign trailing error leaked as the
    // process exit code. Detect it by the old executable no longer existing and keep installing.
    // The sentinel is parameterized on the pass's own install dir ($INSTDIR for SHELL_CONTEXT,
    // the registry-read per-user dir for HKEY_CURRENT_USER).
    expect(include).toContain('${FileExists} "${DIR}\\${APP_EXECUTABLE_FILENAME}"')
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
    // PowerShell sweep failed to run (nsExec pushes "error" or a non-zero exit code).
    const code = include
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(code.match(/taskkill/g) ?? []).toHaveLength(1)
    expect(code).toMatch(
      /Pop \$R1[\s\S]*?\$\{if\} \$R1 != 0\s+nsExec::Exec `"\$SYSDIR\\cmd\.exe" \/C taskkill/
    )
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

  it('passes the install dir to PowerShell as an argument, with a directory-boundary match', () => {
    // Custom install dirs may contain apostrophes: interpolating the path into the script source
    // would break the command (or worse, inject into it). The dir goes in as $args[0] and the
    // prefix match is anchored with a trailing backslash so sibling directories never match.
    expect(include).toContain('$$args[0].TrimEnd')
    expect(include).toContain('$$_.ExecutablePath.StartsWith($$root')
    expect(include).not.toContain(`StartsWith('$INSTDIR'`)
  })

  it('targets the real per-user install location in the current-user hook', () => {
    // The installMode==all HKCU pass removes a stray per-user install, which may live anywhere —
    // $INSTDIR/$appExe describe the new machine-wide target. The hook must read InstallLocation
    // from HKCU and fall back to the default fatal handling when it is unreadable, rather than
    // retry against the wrong directory.
    expect(include).toContain(
      '!insertmacro readReg $R9 "HKEY_CURRENT_USER" "${INSTALL_REGISTRY_KEY}" InstallLocation'
    )
    expect(include).toMatch(/\$\{if\} \$R9 == ""/)
    expect(include).toContain('!insertmacro uninstallFailureRecoveryAt $R9')
    expect(include).toContain('!insertmacro uninstallFailureRecoveryAt $INSTDIR')
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
      join(repoRoot, 'node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh'),
      'utf8'
    )
    expect(installUtil).toContain('!ifmacrodef customUnInstallCheck')
    expect(installUtil).toContain('!insertmacro customUnInstallCheck')
    expect(installUtil).toContain('!ifmacrodef customUnInstallCheckCurrentUser')
    expect(installUtil).toContain('!insertmacro customUnInstallCheckCurrentUser')
  })
})
