!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\windows-runtime-cache-uninstall.ps1"'
!macroend

!macro customInit
  # Cache any stray per-user install location NOW (install start), BEFORE any uninstall pass
  # runs: the HKCU uninstall pass deletes this value on success, so customUnInstallCheckCurrentUser
  # — which runs after that pass — could never read it there. Declared inside this macro (rather
  # than at file scope) because customInit only expands into the installer build; a file-scope
  # Var would be declared-but-unused in the uninstaller build, and makensis fails that warning.
  Var /GLOBAL perUserInstallDirCache
  ReadRegStr $perUserInstallDirCache HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
!macroend

# Resilient replacement for handleUninstallResult's default failure handling, installed via
# electron-builder's customUnInstallCheck hooks below. During an in-app update the new installer
# runs the OLD uninstaller and treats any non-zero exit code as fatal ("Failed to uninstall old
# application files. Please try running the installer again.: <code>") — aborting the update.
# That code is not trustworthy for our assisted installer (oneClick: false): electron-builder only
# normalizes the uninstaller's exit code (quitSuccess, "avoid exit code 2") for ONE_CLICK builds,
# so a benign trailing error leaks out as exit code 2 even when the old version was fully removed
# (electron-userland/electron-builder#9593). And when the code IS real, it is usually a background
# child still running from the install dir (micromamba provisioning, the CLI in Node mode, an
# agent child) locking files — worth one more attempt after a force-kill instead of failing.
# Recovery order (${DIR} = the installation this pass was uninstalling):
#   1. Exit code non-zero but the old executable is already gone -> the uninstall did its job
#      despite the reported code; log and continue installing.
#   2. Files remain -> force-kill processes running from the install dir, wait, and run the old
#      uninstaller once more. Only if it still fails show the original dialog and quit.
# Symbol constraints: handleUninstallResult is parsed BEFORE uninstallOldVersion and
# CHECK_APP_RUNNING declare their globals ($installationDir, $PowerShellPath, ...), and makensis
# treats unknown variables as errors — so this stays self-contained: registers, built-in
# constants, and the literal temp-uninstaller path uninstallOldVersion uses.
!macro uninstallFailureRecoveryAt DIR
  ${ifNot} ${FileExists} "${DIR}\${APP_EXECUTABLE_FILENAME}"
    DetailPrint `Old uninstaller exited with $R0 but the previous installation is already removed; continuing.`
  ${else}
    DetailPrint `Old uninstaller exited with $R0; closing leftover app processes and retrying once.`
    # Force-kill anything still running from the install dir, then retry. The PowerShell sweep
    # matches on ExecutablePath (Win32_Process has no Path property) with a trailing-backslash
    # boundary so a sibling directory can never match, and receives the directory as an ARGUMENT —
    # never interpolated into the script source — so a custom install dir containing an apostrophe
    # breaks nothing and injects nothing. The image-name taskkills are ONLY a fallback for when
    # the sweep could not run (PowerShell missing or policy-blocked): they match by exe name in
    # ANY directory — open-science.exe covers the app and its Electron-as-Node children (the
    # CLI), micromamba.exe covers in-flight provisioning — so a second install, the portable zip
    # copy, or an unrelated micromamba would be killed too. Acceptable solely when no path-scoped
    # option exists. Both are best-effort; the retry is the verdict.
    # $0 keeps the uninstaller arguments (/currentuser etc.) — neither nsExec call touches it.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "$$root = $$args[0].TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | ? { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, 'CurrentCultureIgnoreCase') } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }" "${DIR}"`
    Pop $R1
    # nsExec pushes "error" when powershell.exe cannot even start, otherwise its exit code — any
    # non-zero means the sweep did not run, so only then widen to the image-name kills.
    ${if} $R1 != 0
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $R1
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM micromamba.exe`
      Pop $R1
    ${endif}
    ClearErrors
    Sleep 1000
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=${DIR}' $R0
    ${if} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
      DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend

!macro customUnInstallCheck
  ${if} $R0 != 0
    # SHELL_CONTEXT pass: the old installation sits at $INSTDIR (an update installs over it).
    !insertmacro uninstallFailureRecoveryAt $INSTDIR
  ${endif}
!macroend

!macro customUnInstallCheckCurrentUser
  ${if} $R0 != 0
    # installMode==all pass: it removes a stray PER-USER install, which may live anywhere —
    # $INSTDIR/$appExe describe the new (machine-wide) target, not it. Use the location cached in
    # customInit: reading the registry HERE is useless for the spurious-failure case, because a
    # successful per-user uninstall deletes InstallLocation before returning its (untrustworthy)
    # exit code. Empty cache means no per-user install was registered at install start; keep
    # electron-builder's default fatal handling rather than retry against an unknown directory.
    ${if} $perUserInstallDirCache == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
      DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
      SetErrorLevel 2
      Quit
    ${endif}
    !insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache
  ${endif}
!macroend
