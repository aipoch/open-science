!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\windows-runtime-cache-uninstall.ps1"'
!macroend

!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_ABORT restorePreservedOnAbort

Var perMachineInstallDirCache
Var perUserInstallDirCache
Var perMachineDataBackup
Var perUserDataBackup
Var dataProtectionFailed
Var dataRestoreFailed

# Move a data root outside the installation before the OLD uninstaller sees it. A deterministic
# sibling path lets an elevated inner installer or a later retry recover data left by an
# interrupted outer installer without relying on process-local registers.
!macro preserveNestedDataRoot DIR BACKUP SLOT
  StrCpy ${BACKUP} ""
  ${if} "${DIR}" != ""
    ClearErrors
    GetFullPathName $R2 "${DIR}\.."
    ${if} ${Errors}
      DetailPrint `Could not safely preserve "${DIR}\OpenScience"; its parent path could not be resolved.`
      MessageBox MB_OK|MB_ICONSTOP "Open Science could not safely protect its data folder before updating.$\r$\nThe existing data was left untouched."
      StrCpy $dataProtectionFailed "1"
    ${else}
      StrCpy ${BACKUP} "$R2\.open-science-update-data-${SLOT}"
      ${if} ${FileExists} "${DIR}\OpenScience\*.*"
        ${if} ${FileExists} "${BACKUP}\*.*"
          DetailPrint `Could not safely preserve "${DIR}\OpenScience" because the backup path already exists: ${BACKUP}`
          MessageBox MB_OK|MB_ICONSTOP "Open Science found both the current data folder and an earlier update backup.$\r$\nNo data was changed. Please inspect:$\r$\n${BACKUP}"
          StrCpy ${BACKUP} ""
          StrCpy $dataProtectionFailed "1"
        ${else}
          ClearErrors
          Rename "${DIR}\OpenScience" "${BACKUP}"
          ${if} ${Errors}
            DetailPrint `Could not safely preserve "${DIR}\OpenScience"; leaving the existing installation untouched.`
            MessageBox MB_OK|MB_ICONSTOP "Open Science could not safely protect its data folder before updating.$\r$\nThe existing data was left untouched."
            StrCpy ${BACKUP} ""
            StrCpy $dataProtectionFailed "1"
          ${else}
            DetailPrint `Protected the data folder at: ${BACKUP}`
          ${endif}
        ${endif}
      ${elseif} ${FileExists} "${BACKUP}\*.*"
        # A previous installer exited before it could restore. Adopt that deterministic backup
        # and restore it through the normal post-uninstall path.
        DetailPrint `Found data preserved by an interrupted update at: ${BACKUP}`
      ${else}
        StrCpy ${BACKUP} ""
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro restoreNestedDataRoot DIR BACKUP
  ${if} "${DIR}" != ""
  ${andIf} "${BACKUP}" != ""
    ${if} ${FileExists} "${BACKUP}\*.*"
      ${if} ${FileExists} "${DIR}\OpenScience\*.*"
        DetailPrint `The preserved data remains at: ${BACKUP}`
        MessageBox MB_OK|MB_ICONSTOP "Open Science could not restore its data folder because the destination already exists.$\r$\nThe preserved data remains at:$\r$\n${BACKUP}"
        StrCpy $dataRestoreFailed "1"
      ${else}
        CreateDirectory "${DIR}"
        ClearErrors
        Rename "${BACKUP}" "${DIR}\OpenScience"
        ${if} ${Errors}
          DetailPrint `The preserved data remains at: ${BACKUP}`
          MessageBox MB_OK|MB_ICONSTOP "Open Science could not restore its data folder after updating.$\r$\nThe preserved data remains at:$\r$\n${BACKUP}"
          StrCpy $dataRestoreFailed "1"
        ${else}
          DetailPrint `Restored the data folder to: ${DIR}\OpenScience`
          StrCpy ${BACKUP} ""
        ${endif}
      ${endif}
    ${else}
      # Another installer instance may already have restored the deterministic backup.
      StrCpy ${BACKUP} ""
    ${endif}
  ${endif}
!macroend

!macro restoreAllNestedDataRoots
  StrCpy $dataRestoreFailed "0"
  !insertmacro restoreNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup
  !insertmacro restoreNestedDataRoot $perUserInstallDirCache $perUserDataBackup
!macroend

!macro quitIfDataRestoreFailed
  ${if} $dataRestoreFailed != "0"
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customInit
  # Cache both registered locations before either uninstall pass can delete their registry data.
  # More importantly, move any nested OpenScience data root OUTSIDE the install directory before
  # the first old uninstaller runs. Its /KEEP_APP_DATA flag only protects the normal OS app-data
  # directory; its update algorithm otherwise moves every child of the install directory into a
  # disposable $PLUGINSDIR and deletes it on success.
  StrCpy $perMachineInstallDirCache ""
  StrCpy $perUserInstallDirCache ""
  StrCpy $perMachineDataBackup ""
  StrCpy $perUserDataBackup ""
  StrCpy $dataProtectionFailed "0"
  StrCpy $dataRestoreFailed "0"
  ReadRegStr $perMachineInstallDirCache HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $perUserInstallDirCache HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation

  # Protect HKCU independently of the mode selected during .onInit: the user can still switch to
  # all-users on the assisted install-mode page, so that early mode is not the uninstall verdict.
  # One exception needs a non-destructive write probe: both registry entries may point at the
  # same machine-owned Program Files tree. An unelevated outer process must defer that shared path
  # to the inner installer instead of failing before the user has a chance to approve UAC.
  StrCpy $R8 "1"
  ${if} $perUserInstallDirCache != ""
  ${andIf} $perMachineInstallDirCache == $perUserInstallDirCache
  ${andIfNot} ${UAC_IsAdmin}
    StrCpy $R8 "0"
    StrCpy $R9 ""
    ClearErrors
    GetFullPathName $R2 "$perUserInstallDirCache\.."
    ${ifNot} ${Errors}
      GetTempFileName $R9 "$R2"
      ${ifNot} ${Errors}
        ClearErrors
        Delete "$R9"
        ${ifNot} ${Errors}
          StrCpy $R8 "1"
        ${endif}
      ${endif}
    ${endif}
    ${if} $R8 == "0"
      DetailPrint `Deferring shared data-folder protection to the elevated installer.`
      ClearErrors
    ${endif}
  ${endif}
  ${if} $R8 == "1"
    !insertmacro preserveNestedDataRoot $perUserInstallDirCache $perUserDataBackup per-user
  ${endif}

  # An assisted per-machine install elevates into a second installer process. An unelevated outer
  # process must not fail merely because it cannot rename a machine installation; the inner/admin
  # .onInit protects HKLM regardless of the mode it initially inherits. If both registry entries
  # point to one tree, the HKCU backup already protects it through both uninstall passes.
  ${if} $dataProtectionFailed == "0"
    ${if} $perMachineInstallDirCache == $perUserInstallDirCache
      StrCpy $perMachineDataBackup $perUserDataBackup
    ${elseif} ${UAC_IsAdmin}
      !insertmacro preserveNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup machine
    ${elseif} $perMachineInstallDirCache != ""
      DetailPrint `Deferring machine data-folder protection to the elevated installer.`
    ${endif}
  ${endif}
  ${if} $dataProtectionFailed != "0"
    # Undo any earlier successful move before refusing to start either old uninstaller.
    !insertmacro restoreAllNestedDataRoots
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

# These callbacks cover cancellation or an installer failure before the post-uninstall hooks run.
# The normal path restores each directory immediately after its matching old-uninstaller pass.
!macro customHeader
  Function restorePreservedOnAbort
    !insertmacro restoreAllNestedDataRoots
  FunctionEnd

  Function .onInstFailed
    !insertmacro restoreAllNestedDataRoots
  FunctionEnd

  Function .onGUIEnd
    !insertmacro restoreAllNestedDataRoots
  FunctionEnd
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
    # A custom data root may live inside the installation itself (the issue reporter uses
    # <install>\OpenScience). The updated uninstaller moves EVERY child of ${DIR} into its
    # disposable $PLUGINSDIR, so making that move reliable without protecting the data root
    # would turn an update failure into silent data loss. Move the directory to a unique sibling
    # on the same volume before retrying, then restore it regardless of the retry's exit code.
    # A failed preserve leaves the original directory in place and aborts before the retry.
    StrCpy $R7 ""
    ${if} ${FileExists} "${DIR}\OpenScience\*.*"
      ClearErrors
      GetFullPathName $R2 "${DIR}\.."
      GetTempFileName $R7 "$R2"
      ${ifNot} ${Errors}
        Delete "$R7"
        ClearErrors
        Rename "${DIR}\OpenScience" "$R7"
      ${endif}
      ${if} ${Errors}
        Delete "$R7"
        DetailPrint `Could not safely preserve "${DIR}\OpenScience"; leaving the existing installation untouched.`
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
        !insertmacro restoreAllNestedDataRoots
        SetErrorLevel 2
        Quit
      ${endif}
    ${endif}

    # During an update, electron-builder's old uninstaller moves every installed file into its
    # $PLUGINSDIR before deleting the old tree. Windows cannot atomically rename across volumes:
    # for a custom D: install and the usual C: TEMP this becomes a slow, failure-prone copy of the
    # whole installation. Give only the recovery child a unique temp directory beside the old
    # install so its plugin directory stays on the same volume. If that directory cannot be
    # created, retain the existing default-TEMP retry rather than turning recovery setup into a
    # new fatal path. $R3/$R4 preserve this installer's environment across the child process.
    StrCpy $R5 ""
    ClearErrors
    GetFullPathName $R2 "${DIR}\.."
    GetTempFileName $R5 "$R2"
    ${ifNot} ${Errors}
      Delete "$R5"
      ClearErrors
      CreateDirectory "$R5"
    ${endif}
    ${ifNot} ${Errors}
      ReadEnvStr $R3 "TEMP"
      ReadEnvStr $R4 "TMP"
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TEMP", "$R5").rR6'
      ${if} $R6 != 0
        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TMP", "$R5").rR6'
      ${endif}
      ${if} $R6 == 0
        # A partial environment update must not leak into the rest of the new installer.
        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TEMP", "$R3").rR6'
        System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TMP", "$R4").rR6'
        RMDir /r "$R5"
        StrCpy $R5 ""
      ${endif}
    ${else}
      StrCpy $R5 ""
    ${endif}

    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=${DIR}' $R0
    ${if} $R5 != ""
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TEMP", "$R3").rR6'
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TMP", "$R4").rR6'
      RMDir /r "$R5"
      ClearErrors
    ${endif}
    ${if} $R7 != ""
      # The retry may have removed ${DIR}; recreate only the parent and put the preserved data
      # back before deciding whether the retry's exit code represents success or failure.
      CreateDirectory "${DIR}"
      ClearErrors
      Rename "$R7" "${DIR}\OpenScience"
      ${if} ${Errors}
        DetailPrint `The preserved data remains at: $R7`
        MessageBox MB_OK|MB_ICONSTOP "Open Science could not restore its data folder after updating.$\r$\nYour data remains at:$\r$\n$R7"
        !insertmacro restoreAllNestedDataRoots
        SetErrorLevel 2
        Quit
      ${endif}
      StrCpy $R7 ""
    ${endif}
    ${if} $R0 != 0
      ${ifNot} ${FileExists} "${DIR}\${APP_EXECUTABLE_FILENAME}"
        DetailPrint `Retry exited with $R0 but the previous installation is already removed; continuing.`
      ${else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
        DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
        !insertmacro restoreAllNestedDataRoots
        SetErrorLevel 2
        Quit
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro customUnInstallCheck
  # SHELL_CONTEXT resolves from the FINAL install-mode page selection, not the mode seen by
  # customInit. A current-user install has no second pass, so restore every cached root. An
  # all-users install restores HKLM here and keeps HKCU protected for the following explicit pass.
  ${if} $installMode == "all"
    ${if} $perMachineInstallDirCache == $perUserInstallDirCache
      DetailPrint `Keeping the shared data folder protected for the matching per-user uninstall pass.`
    ${else}
      !insertmacro restoreNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup
      !insertmacro quitIfDataRestoreFailed
    ${endif}
  ${else}
    !insertmacro restoreAllNestedDataRoots
    !insertmacro quitIfDataRestoreFailed
  ${endif}
  ${if} $R0 != 0
    # SHELL_CONTEXT pass: the old installation sits at $INSTDIR (an update installs over it).
    !insertmacro uninstallFailureRecoveryAt $INSTDIR
  ${endif}
!macroend

!macro customUnInstallCheckCurrentUser
  # The old uninstall may have removed its registry key, so restore using the path cached before
  # either pass rather than reading InstallLocation here.
  !insertmacro restoreNestedDataRoot $perUserInstallDirCache $perUserDataBackup
  !insertmacro quitIfDataRestoreFailed
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
      !insertmacro restoreAllNestedDataRoots
      SetErrorLevel 2
      Quit
    ${endif}
    !insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache
  ${endif}
!macroend

!endif
