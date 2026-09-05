!macro customInstallMode
  # Notebook AppContainer profiles are per-user durable resources. A machine-wide installation
  # cannot safely create, identify, and remove one profile for every Windows account, so keep the
  # assisted installer and uninstaller bound to the current user.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  # Updates run the old uninstaller with isUpdated set and must retain the durable profile. Only a
  # real product uninstall removes the AppContainer resources.
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\windows-notebook-sandbox-uninstall.ps1" -SandboxRoot "$INSTDIR\resources\notebook-network-sandbox\windows"'
    Pop $0
    StrCmp $0 "0" notebookSandboxCleanupComplete
    MessageBox MB_OK|MB_ICONSTOP "Open Science could not safely remove its owned Notebook isolation resources. The uninstall was stopped so the cleanup can be retried."
    Abort
    notebookSandboxCleanupComplete:
  ${endif}
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

# Registry values that identify the same Windows directory may differ only in letter case or a
# trailing separator. LogicLib's == comparison is already case-insensitive; trim separators here
# so every later shared-path decision uses one canonical form. Keep drive roots such as C:\ intact.
Function normalizeRegisteredInstallPath
  Exch $R0
  Push $R1

  normalizeRegisteredInstallPath_loop:
    StrLen $R1 $R0
    IntCmp $R1 3 normalizeRegisteredInstallPath_done normalizeRegisteredInstallPath_done
    StrCpy $R1 $R0 1 -1
    StrCmp $R1 "\" normalizeRegisteredInstallPath_trim
    StrCmp $R1 "/" normalizeRegisteredInstallPath_trim normalizeRegisteredInstallPath_done

  normalizeRegisteredInstallPath_trim:
    StrCpy $R0 $R0 -1
    Goto normalizeRegisteredInstallPath_loop

  normalizeRegisteredInstallPath_done:
    Pop $R1
    Exch $R0
FunctionEnd

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

# Run only after installMode is final. Interactive assisted installers reach this from the
# instfiles-page preflight; silent installs have no page callbacks, so customInit calls it after
# initMultiUser has resolved the command-line/previous-install mode. A distinct HKLM tree must not
# be touched for a current-user install merely because the process already has admin rights.
!macro protectMachineDataRootForSelectedMode
  ${if} $dataProtectionFailed == "0"
  ${andIf} $installMode == "all"
    ${if} $perMachineInstallDirCache == $perUserInstallDirCache
      StrCpy $perMachineDataBackup $perUserDataBackup
    ${elseif} ${UAC_IsAdmin}
      !insertmacro preserveNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup machine
    ${elseif} $perMachineInstallDirCache != ""
      # The unelevated assisted outer process stops on the install-mode page while its elevated
      # inner process completes the install. The inner process runs this same protection path.
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

# electron-builder already installs an instfiles PRE callback that sanitizes the selected install
# directory. Preserve that callback and chain the final-mode data preflight after it.
!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define openScienceOriginalInstFilesPre ${MUI_PAGE_CUSTOMFUNCTION_PRE}
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE protectNestedDataRootsForInstall
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
  Push $perMachineInstallDirCache
  Call normalizeRegisteredInstallPath
  Pop $perMachineInstallDirCache
  Push $perUserInstallDirCache
  Call normalizeRegisteredInstallPath
  Pop $perUserInstallDirCache

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

  ${if} $dataProtectionFailed != "0"
    !insertmacro restoreAllNestedDataRoots
    SetErrorLevel 2
    Quit
  ${endif}
  # Page callbacks do not run in silent mode. There is no later user choice in that mode, so the
  # installMode selected by initMultiUser is already final and machine protection can run now.
  ${if} ${Silent}
    Call ensureExistingUninstallerIsWritable
    !insertmacro protectMachineDataRootForSelectedMode
  ${endif}
!macroend

# These callbacks cover cancellation or an installer failure before the post-uninstall hooks run.
# The normal path restores each directory immediately after its matching old-uninstaller pass.
!macro customHeader
  # NSIS extracts the new uninstaller after the application package. Probe the same write access
  # its File command will request before uninstalling the old app, and again before extraction.
  # Checking only after uninstalling can reject the update with the old executable already gone.
  # A stale locked uninstaller must not turn a silent install into a false success or offer the unsafe
  # Ignore choice. OPEN_EXISTING keeps this check non-destructive; Retry lets the user release a
  # transient lock, while silent installs take the Cancel path and return a failure code.
  Function ensureExistingUninstallerIsWritable
    IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" ensureExistingUninstallerIsWritable_retry ensureExistingUninstallerIsWritable_done

    ensureExistingUninstallerIsWritable_retry:
      System::Call 'kernel32::SetLastError(i 0)'
      System::Call 'kernel32::CreateFile(t "$INSTDIR\${UNINSTALL_FILENAME}", i 0x40000000, i 1, i 0, i 3, i 0x80, i 0) i.rR0 ?e'
      Pop $R1
      StrCmp $R1 0 0 ensureExistingUninstallerIsWritable_failed
      System::Call 'kernel32::CloseHandle(i rR0)'
      Return

    ensureExistingUninstallerIsWritable_failed:
      DetailPrint `Cannot replace the existing uninstaller: "$INSTDIR\${UNINSTALL_FILENAME}".`
      IfSilent ensureExistingUninstallerIsWritable_cancel
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(uninstallFailed)$\r$\n$INSTDIR\${UNINSTALL_FILENAME}" IDRETRY ensureExistingUninstallerIsWritable_retry

    ensureExistingUninstallerIsWritable_cancel:
      # customInit may already have moved nested user data outside the old installation.
      !insertmacro restoreAllNestedDataRoots
      SetErrorLevel 2
      Quit

    ensureExistingUninstallerIsWritable_done:
      Return
  FunctionEnd

  Function protectNestedDataRootsForInstall
    !ifdef openScienceOriginalInstFilesPre
      Call ${openScienceOriginalInstFilesPre}
    !endif
    Call ensureExistingUninstallerIsWritable
    !insertmacro protectMachineDataRootForSelectedMode
  FunctionEnd

  Function restorePreservedOnAbort
    !insertmacro restoreAllNestedDataRoots
  FunctionEnd

  Function .onInstFailed
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
!macro uninstallFailureRecoveryAt DIR REGISTERED_BACKUP
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
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "notebook-appcontainer-host.exe"`
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
      ${if} "${REGISTERED_BACKUP}" != ""
      ${andIf} ${FileExists} "${REGISTERED_BACKUP}\*.*"
        # customInit already holds the authoritative registered data outside the install tree.
        # Do not overwrite either copy if the old process recreated data before it was killed;
        # retain that additional directory at its unique sibling path for manual reconciliation.
        DetailPrint `Additional data created during the update remains at: $R7`
        MessageBox MB_OK|MB_ICONEXCLAMATION "Open Science found additional data created while closing the previous version.$\r$\nYour original data will be restored; the additional data remains at:$\r$\n$R7"
      ${else}
        # No registered backup exists (recovery can also be used independently). The retry may
        # have removed ${DIR}; recreate only the parent and put the retry-local data back before
        # deciding whether the retry's exit code represents success or failure.
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
  # customInit. Keep registered data outside the install tree through any non-zero-exit recovery:
  # a live old process can recreate OpenScience, and restoring first would make the recovery path
  # abort on that destination conflict. $R8 selects the authoritative backup for this pass.
  ${if} $R0 != 0
    StrCpy $R8 $perUserDataBackup
    ${if} $installMode == "all"
      StrCpy $R8 $perMachineDataBackup
    ${endif}
    # SHELL_CONTEXT pass: the old installation sits at $INSTDIR (an update installs over it).
    !insertmacro uninstallFailureRecoveryAt $INSTDIR $R8
  ${endif}

  # A current-user install has no second pass, so restore every cached root. An all-users install
  # restores HKLM here and keeps HKCU protected for the following explicit pass.
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
    Call ensureExistingUninstallerIsWritable
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
      !insertmacro restoreAllNestedDataRoots
      SetErrorLevel 2
      Quit
    ${endif}
    !insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache $perUserDataBackup
  ${endif}
  # The old uninstall may have removed its registry key, so restore using the path cached before
  # either pass rather than reading InstallLocation here. Recovery must finish first because the
  # still-preserved backup is what keeps a recreated data directory from short-circuiting retry.
  !insertmacro restoreNestedDataRoot $perUserInstallDirCache $perUserDataBackup
  !insertmacro quitIfDataRestoreFailed
  Call ensureExistingUninstallerIsWritable
!macroend

!endif
