!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\windows-runtime-cache-uninstall.ps1"'
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
# Recovery order:
#   1. Exit code non-zero but the old executable is already gone -> the uninstall did its job
#      despite the reported code; log and continue installing.
#   2. Files remain -> force-kill processes running from the install dir, wait, and run the old
#      uninstaller once more. Only if it still fails show the original dialog and quit.
# Symbol constraints: handleUninstallResult is parsed BEFORE uninstallOldVersion and
# CHECK_APP_RUNNING declare their globals ($installationDir, $PowerShellPath, ...), and makensis
# treats unknown variables as errors — so this stays self-contained: only $appExe (set in the
# install section before the uninstall pass), registers, built-in constants, and the literal
# temp-uninstaller path uninstallOldVersion uses. For the SHELL_CONTEXT pass $INSTDIR is the old
# install location (an update installs over it). The rare installMode==all HKEY_CURRENT_USER pass
# targets a stray per-user install elsewhere; re-running its uninstaller against $INSTDIR is a
# harmless no-op that lets the machine-wide install continue.
!macro uninstallFailureRecovery
  ${if} $R0 != 0
    ${ifNot} ${FileExists} "$appExe"
      DetailPrint `Old uninstaller exited with $R0 but the previous installation is already removed; continuing.`
    ${else}
      DetailPrint `Old uninstaller exited with $R0; closing leftover app processes and retrying once.`
      # Force-kill anything still running from the install dir: path-prefix sweep via PowerShell
      # (covers micromamba.exe and any other helper), then an image-name taskkill for machines
      # where PowerShell is unavailable or policy-blocked. Both are best-effort; the retry below
      # is the real verdict. $0 keeps the uninstaller arguments (/currentuser etc.) — neither
      # nsExec call touches it.
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
      Pop $R1
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $R1
      ClearErrors
      Sleep 1000
      ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=$INSTDIR' $R0
      ${if} $R0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
        DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
        SetErrorLevel 2
        Quit
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro uninstallFailureRecovery
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro uninstallFailureRecovery
!macroend
