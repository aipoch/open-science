import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..')
const appBuilderLibRoot = dirname(
  createRequire(import.meta.url).resolve('app-builder-lib/package.json')
)

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
    // PowerShell sweep failed to run (nsExec pushes "error" or a non-zero exit code). micromamba
    // is included: its image name differs from the app exe, so the app-exe kill alone cannot
    // cover an in-flight provisioning lock on PowerShell-blocked machines.
    const code = include
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(code.match(/taskkill/g) ?? []).toHaveLength(2)
    // Capture the whole guard block and assert BOTH kills live inside it — asserting only the
    // first one's position would still pass with micromamba's taskkill moved outside the guard.
    const guardBlock = code.match(/\$\{if\} \$R1 != 0([\s\S]*?)\$\{endif\}/)?.[1] ?? ''
    expect(guardBlock).toContain('taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"')
    expect(guardBlock).toContain('taskkill /F /IM micromamba.exe')
    expect(guardBlock.match(/taskkill/g) ?? []).toHaveLength(2)
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

  it('runs the retry with TEMP and TMP on the old installation volume', () => {
    // electron-builder's updated uninstall atomically moves the old installation into the
    // uninstaller's $PLUGINSDIR. A custom D: install with the ordinary C: TEMP turns that into a
    // cross-volume move/copy — including a nested OpenScience data root — and can abort with exit
    // code 2. The recovery attempt must give the child uninstaller a same-volume plugin directory,
    // then restore this installer's environment after ExecWait returns.
    const recovery =
      include.match(/!macro uninstallFailureRecoveryAt DIR([\s\S]*?)!macroend/)?.[1] ?? ''
    const retryAt = recovery.indexOf('ExecWait')

    expect(recovery).toContain('GetFullPathName $R2 "${DIR}\\.."')
    expect(recovery).toContain('GetTempFileName $R5 "$R2"')
    expect(recovery).toMatch(/SetEnvironmentVariable\(t, t\)i \("TEMP", "\$R5"\)/)
    expect(recovery).toMatch(/SetEnvironmentVariable\(t, t\)i \("TMP", "\$R5"\)/)
    expect(recovery.indexOf('("TEMP", "$R5")')).toBeLessThan(retryAt)
    expect(recovery.indexOf('("TMP", "$R5")')).toBeLessThan(retryAt)
    expect(recovery.lastIndexOf('("TEMP", "$R3")')).toBeGreaterThan(retryAt)
    expect(recovery.lastIndexOf('("TMP", "$R4")')).toBeGreaterThan(retryAt)
  })

  it('preserves a nested OpenScience data root around the uninstall retry', () => {
    // The reporter's configured data root is <install dir>\OpenScience. An updated NSIS
    // uninstaller moves every child of the install directory into its disposable $PLUGINSDIR, so
    // a successful retry must first move that data root to a separate sibling and restore it
    // before the new installer continues.
    const recovery =
      include.match(/!macro uninstallFailureRecoveryAt DIR([\s\S]*?)!macroend/)?.[1] ?? ''
    const preserveAt = recovery.indexOf('Rename "${DIR}\\OpenScience" "$R7"')
    const retryAt = recovery.indexOf('ExecWait')
    const restoreAt = recovery.indexOf('Rename "$R7" "${DIR}\\OpenScience"')
    const preserveErrorAt = recovery.indexOf('Could not safely preserve')
    const preserveQuitAt = recovery.indexOf('Quit', preserveErrorAt)
    const restoreErrorAt = recovery.indexOf('The preserved data remains at: $R7')
    const restoreQuitAt = recovery.indexOf('Quit', restoreErrorAt)
    const retryResultAt = recovery.indexOf('${if} $R0 != 0', retryAt)
    const clearPreservedPathAt = recovery.indexOf('StrCpy $R7 ""', restoreAt)

    expect(preserveAt).toBeGreaterThan(-1)
    expect(preserveAt).toBeLessThan(retryAt)
    expect(preserveErrorAt).toBeLessThan(preserveQuitAt)
    expect(preserveQuitAt).toBeLessThan(retryAt)
    expect(restoreAt).toBeGreaterThan(retryAt)
    expect(restoreAt).toBeLessThan(retryResultAt)
    expect(restoreErrorAt).toBeLessThan(restoreQuitAt)
    expect(restoreQuitAt).toBeLessThan(retryResultAt)
    expect(clearPreservedPathAt).toBeGreaterThan(restoreQuitAt)
  })

  it('keeps registered data backups outside the install tree until recovery finishes', () => {
    // A still-running old process can recreate <install>\OpenScience after customInit moved the
    // registered data aside. Run force-kill + retry before restoring the authoritative backup in
    // both uninstall hooks. If recovery also preserves a newly-created directory, retain it at
    // its unique sibling path instead of overwriting either copy or feeding it to the uninstaller.
    const recovery =
      include.match(
        /!macro uninstallFailureRecoveryAt DIR REGISTERED_BACKUP([\s\S]*?)!macroend/
      )?.[1] ?? ''
    const shellCheck = include.match(/!macro customUnInstallCheck([\s\S]*?)!macroend/)?.[1] ?? ''
    const userCheck =
      include.match(/!macro customUnInstallCheckCurrentUser([\s\S]*?)!macroend/)?.[1] ?? ''
    const conflictBranch =
      recovery.match(/\$\{if\} "\$\{REGISTERED_BACKUP\}" != ""([\s\S]*?)\$\{else\}/)?.[1] ?? ''
    const shellRecoveryAt = shellCheck.indexOf('!insertmacro uninstallFailureRecoveryAt')
    const shellRestoreAt = shellCheck.indexOf('!insertmacro restoreNestedDataRoot')
    const userRecoveryAt = userCheck.indexOf('!insertmacro uninstallFailureRecoveryAt')
    const userRestoreAt = userCheck.indexOf('!insertmacro restoreNestedDataRoot')

    expect(shellRecoveryAt).toBeGreaterThan(-1)
    expect(shellRecoveryAt).toBeLessThan(shellRestoreAt)
    expect(userRecoveryAt).toBeGreaterThan(-1)
    expect(userRecoveryAt).toBeLessThan(userRestoreAt)
    expect(shellCheck).toContain('!insertmacro uninstallFailureRecoveryAt $INSTDIR $R8')
    expect(userCheck).toContain(
      '!insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache $perUserDataBackup'
    )
    expect(conflictBranch).toContain('Additional data created during the update remains at: $R7')
    expect(conflictBranch).not.toContain('Rename "$R7" "${DIR}\\OpenScience"')
  })

  it('protects registered nested data roots before the first old-uninstaller attempt', () => {
    // Recovery-only protection is too late: the first old uninstaller can succeed after moving
    // <install>\OpenScience into its disposable $PLUGINSDIR. customInit runs before the install
    // section, so it must move registered data roots out first; each post-uninstall hook restores
    // its root even when the first attempt returns zero.
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

  it('accepts a non-zero retry after the old executable was removed', () => {
    // The old assisted uninstaller can finish removing the application and still leak exit code 2.
    // Recovery already recognizes that result before retrying; it must make the same filesystem
    // check after the retry instead of showing a fatal dialog for a completed uninstall.
    const recovery =
      include.match(/!macro uninstallFailureRecoveryAt DIR([\s\S]*?)!macroend/)?.[1] ?? ''
    const afterRetry = recovery.slice(recovery.indexOf('ExecWait'))
    const removedCheck = '${FileExists} "${DIR}' + '\\' + '${APP_EXECUTABLE_FILENAME}"'

    expect(
      recovery.match(/\$\{FileExists\} "\$\{DIR\}\\\$\{APP_EXECUTABLE_FILENAME\}"/g) ?? []
    ).toHaveLength(2)
    expect(afterRetry.indexOf(removedCheck)).toBeGreaterThan(afterRetry.indexOf('${if} $R0 != 0'))
    expect(afterRetry.indexOf(removedCheck)).toBeLessThan(
      afterRetry.indexOf('MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"')
    )
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
    expect(include).toContain(
      '!insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache $perUserDataBackup'
    )
    expect(include).toContain('!insertmacro uninstallFailureRecoveryAt $INSTDIR $R8')
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
})
