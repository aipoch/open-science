!include "${BUILD_RESOURCES_DIR}\windows-program-cleanup.nsh"

!macro customInstallMode
  # Notebook AppContainer profiles are per-user durable resources. A machine-wide installation
  # cannot safely create, identify, and remove one profile for every Windows account, so keep the
  # assisted installer and uninstaller bound to the current user.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  # Cleanup can fail after removing some program files. Keep retry's lifecycle scripts in the
  # uninstaller itself, so their availability never depends on a partly removed installation.
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  File "${BUILD_RESOURCES_DIR}\windows-update-handoff-uninstall.ps1"
  File "${BUILD_RESOURCES_DIR}\windows-notebook-sandbox-uninstall.ps1"
  File "${BUILD_RESOURCES_DIR}\windows-runtime-cache-uninstall.ps1"
  # Updates run the old uninstaller with isUpdated set and must retain the durable profile. Only a
  # real product uninstall removes the AppContainer resources.
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-update-handoff-uninstall.ps1" -InstallPath "$INSTDIR"'
    Pop $0
    StrCmp $0 "0" updatePresentationCleanupComplete
    DetailPrint `Open-Science update presentation cleanup failure code=$0`
    MessageBox MB_OK|MB_ICONSTOP "An Open-Science update may still be active. Finish the update and close its update window, then retry uninstall."
    Abort
    updatePresentationCleanupComplete:
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-notebook-sandbox-uninstall.ps1" -SandboxRoot "$INSTDIR\resources\notebook-network-sandbox\windows"'
    Pop $0
    StrCmp $0 "0" notebookSandboxCleanupComplete
    DetailPrint `Open-Science Notebook cleanup failure code=$0 sandboxRoot="$INSTDIR\resources\notebook-network-sandbox\windows"`
    MessageBox MB_OK|MB_ICONSTOP "Open-Science could not safely remove its owned Notebook isolation resources. The uninstall was stopped so the cleanup can be retried."
    Abort
    notebookSandboxCleanupComplete:
    # A second installation may now own the scheme. Never remove its association.
    ReadRegStr $0 HKCU "Software\Classes\open-science\shell\open\command" ""
    ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      DeleteRegKey HKCU "Software\Classes\open-science"
    ${endif}
  ${endif}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-runtime-cache-uninstall.ps1"'
!macroend

!ifndef BUILD_UNINSTALLER
!macro customCopyUninstaller
  # Old binaries cannot accept new deletion exclusions. Use the current signed uninstaller for
  # both the first attempt and recovery, retaining upstream registration/shortcut handling.
  File "/oname=$PLUGINSDIR\old-uninstaller.exe" "${UNINSTALLER_OUT_FILE}"
  # The upstream launch fallback must never execute the destructive installed old binary.
  StrCpy $uninstallerFileName "$PLUGINSDIR\old-uninstaller.exe"
!macroend

!define MUI_CUSTOMFUNCTION_ABORT restorePreservedOnAbort
!include "${BUILD_RESOURCES_DIR}\windows-update-handoff.nsh"
!include "${BUILD_RESOURCES_DIR}\windows-install-publication.nsh"
!include "${BUILD_RESOURCES_DIR}\windows-app-running.nsh"

# Quit bypasses .onInstFailed and every other NSIS callback. Publish the existing failure
# receipt at each explicit failure exit so the detached presentation can become dismissible.
!macro quitFailedUpdate
  Call cleanupInstallPublication
  Push "failed"
  Call writeUpdateReceipt
  SetErrorLevel 2
  Quit
!macroend

Var perMachineInstallDirCache
Var perUserInstallDirCache
Var perMachineDataBackup
Var perUserDataBackup
Var perUserDataBackupBranded
Var perMachineDataBackupBranded
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

# Discover deterministic backups left by an interrupted older installer. Current updates leave
# existing data in place; these compatibility paths only restore data already moved in the past.
!macro preserveNamedDataRoot DIR BACKUP SLOT FOLDER
  StrCpy ${BACKUP} ""
  ${if} "${DIR}" != ""
    ClearErrors
    # NSIS GetFullPathName requires the parent to exist. A stale InstallLocation may outlive
    # that directory after a manual move/delete. Resolve lexically with the Windows API so
    # absent data is a no-op, while existing data and interrupted backups still use the guards.
    System::Call 'kernel32::GetFullPathName(t "${DIR}\..", i ${NSIS_MAX_STRLEN}, t .R2, p 0) i.R3'
    ${if} $R3 == 0
    ${orIf} $R3 >= ${NSIS_MAX_STRLEN}
      SetErrors
    ${else}
      # Only a missing parent is harmless. Keep refusing paths whose attributes cannot be read
      # for other reasons (permissions, unavailable drives, invalid paths).
      System::Call 'kernel32::GetFileAttributes(t R2) i.R3 ?e'
      Pop $R4
      ${if} $R3 == -1
      ${andIf} $R4 != 2
      ${andIf} $R4 != 3
        SetErrors
      ${endif}
    ${endif}
    ${if} ${Errors}
      DetailPrint `Open-Science data protection failure code=parent-path-unresolved path="${DIR}\${FOLDER}"`
      DetailPrint `Could not safely preserve "${DIR}\${FOLDER}"; its parent path could not be resolved.`
      MessageBox MB_OK|MB_ICONSTOP "Open-Science could not safely protect its data folder before updating.$\r$\nThe existing data was left untouched."
      StrCpy $dataProtectionFailed "1"
    ${else}
      StrCpy ${BACKUP} "$R2\.open-science-update-data-${SLOT}"
      ${if} ${FileExists} "${DIR}\${FOLDER}\*.*"
        ${if} ${FileExists} "${BACKUP}"
          DetailPrint `Open-Science data protection failure code=backup-already-exists path="${DIR}\${FOLDER}" backup="${BACKUP}"`
          DetailPrint `Could not safely preserve "${DIR}\${FOLDER}" because the backup path already exists: ${BACKUP}`
          MessageBox MB_OK|MB_ICONSTOP "Open-Science found both the current data folder and an earlier update backup.$\r$\nNo data was changed. Please inspect:$\r$\n${BACKUP}"
          StrCpy ${BACKUP} ""
          StrCpy $dataProtectionFailed "1"
        ${else}
          # Current cleanup excludes data. Do not move it even temporarily. Keep this preflight
          # only to discover interrupted backups made by older installers.
          StrCpy ${BACKUP} ""
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

!macro restoreNamedDataRoot DIR BACKUP FOLDER
  ${if} "${DIR}" != ""
  ${andIf} "${BACKUP}" != ""
    ${if} ${FileExists} "${BACKUP}\*.*"
      ${if} ${FileExists} "${DIR}\${FOLDER}\*.*"
        DetailPrint `Open-Science data protection failure code=restore-destination-exists path="${DIR}\${FOLDER}" backup="${BACKUP}"`
        DetailPrint `The preserved data remains at: ${BACKUP}`
        MessageBox MB_OK|MB_ICONSTOP "Open-Science could not restore its data folder because the destination already exists.$\r$\nThe preserved data remains at:$\r$\n${BACKUP}"
        StrCpy $dataRestoreFailed "1"
      ${else}
        CreateDirectory "${DIR}"
        ClearErrors
        Rename "${BACKUP}" "${DIR}\${FOLDER}"
        ${if} ${Errors}
          DetailPrint `Open-Science data protection failure code=restore-rename-failed path="${DIR}\${FOLDER}" backup="${BACKUP}"`
          DetailPrint `The preserved data remains at: ${BACKUP}`
          MessageBox MB_OK|MB_ICONSTOP "Open-Science could not restore its data folder after updating.$\r$\nThe preserved data remains at:$\r$\n${BACKUP}"
          StrCpy $dataRestoreFailed "1"
        ${else}
          DetailPrint `Restored the data folder to: ${DIR}\${FOLDER}`
          StrCpy ${BACKUP} ""
        ${endif}
      ${endif}
    ${else}
      # Another installer instance may already have restored the deterministic backup.
      StrCpy ${BACKUP} ""
    ${endif}
  ${endif}
!macroend

!macro preserveNestedDataRoot DIR BACKUP SLOT
  !insertmacro preserveNamedDataRoot ${DIR} ${BACKUP} ${SLOT} OpenScience
  ${if} $dataProtectionFailed == "0"
    !insertmacro preserveNamedDataRoot ${DIR} ${BACKUP}Branded ${SLOT}-branded Open-Science
  ${endif}
!macroend

!macro restoreNestedDataRoot DIR BACKUP
  !insertmacro restoreNamedDataRoot ${DIR} ${BACKUP} OpenScience
  !insertmacro restoreNamedDataRoot ${DIR} ${BACKUP}Branded Open-Science
!macroend

!macro restoreAllNestedDataRoots
  StrCpy $dataRestoreFailed "0"
  !insertmacro restoreNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup
  !insertmacro restoreNestedDataRoot $perUserInstallDirCache $perUserDataBackup
!macroend

!macro quitIfDataRestoreFailed
  ${if} $dataRestoreFailed != "0"
    !insertmacro quitFailedUpdate
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
      StrCpy $perMachineDataBackupBranded $perUserDataBackupBranded
    ${elseif} ${UAC_IsAdmin}
      !insertmacro preserveNestedDataRoot $perMachineInstallDirCache $perMachineDataBackup machine
    ${elseif} $perMachineInstallDirCache != ""
      # The unelevated assisted outer process stops on the install-mode page while its elevated
      # inner process completes the install. The inner process runs this same protection path.
      DetailPrint `Deferring machine data-folder protection to the elevated installer.`
    ${endif}
  ${endif}
  ${if} $dataProtectionFailed != "0"
    # Restore any discovered historical backup before stopping this update.
    !insertmacro restoreAllNestedDataRoots
    !insertmacro quitFailedUpdate
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

# Interactive updates retain the native instfiles page after Electron exits. The normal setup
# finish page would strand --force-run at a second confirmation, so update installs complete it
# automatically. Fresh installations keep the standard finish page and optional Run checkbox.
!macro customFinishPage
  Function openScienceStartInstalledApp
    StrCpy $1 ""
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
      ${if} $updateOperation != ""
        StrCpy $1 "$1 --open-science-update-operation=$updateOperation"
      ${endif}
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function openScienceUpdateFinish
    ${if} ${isUpdated}
      ${if} ${isForceRun}
        Call openScienceStartInstalledApp
      ${endif}
      Abort
    ${endif}
  FunctionEnd

  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION openScienceStartInstalledApp
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE openScienceUpdateFinish
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInit
  Call initializeUpdateReceipts
  # Cache both registered locations before either uninstall pass deletes their registry data.
  # Discover interrupted backups from older installers without moving current data. The bundled
  # selective uninstaller replaces the unsafe old implementation on every attempt.
  StrCpy $perMachineInstallDirCache ""
  StrCpy $perUserInstallDirCache ""
  StrCpy $perMachineDataBackup ""
  StrCpy $perUserDataBackup ""
  StrCpy $dataProtectionFailed "0"
  StrCpy $dataRestoreFailed "0"
  # The assisted install section elevates silent per-machine upgrades AFTER .onInit.
  # Match that existing decision before any write probe or historical backup restoration: the outer process
  # must reach UAC, and only its elevated child may protect/replace the old installation.
  ${if} ${Silent}
  ${andIf} $hasPerMachineInstallation == "1"
    ${ifNot} ${UAC_IsAdmin}
      Goto openScienceCustomInit_done
    ${endif}
    # With both HKCU and HKLM registrations, initMultiUser initially chooses CurrentUser,
    # but the silent install section later selects all-users. Preflight that final target.
    !insertmacro setInstallModePerAllUsers
  ${endif}
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
    !insertmacro quitFailedUpdate
  ${endif}
  # Page callbacks do not run in silent mode. There is no later user choice in that mode, so the
  # installMode selected by initMultiUser is already final and machine protection can run now.
  ${if} ${Silent}
    Call ensureExistingUninstallerIsWritable
    !insertmacro protectMachineDataRootForSelectedMode
    Push "installing"
    Call writeUpdateReceipt
  ${endif}
  openScienceCustomInit_done:
!macroend

# These callbacks cover cancellation or an installer failure before the post-uninstall hooks run.
# The normal path restores each directory immediately after its matching old-uninstaller pass.
!macro customHeader
  !insertmacro defineUpdateReceiptFunctions
  # NSIS extracts the new uninstaller after the application package. Probe the same write access
  # its File command will request before uninstalling the old app, and again before extraction.
  # Checking only after uninstalling can reject the update with the old executable already gone.
  # A stale locked uninstaller must not turn a silent install into a false success or offer the unsafe
  # Ignore choice. OPEN_EXISTING keeps this check non-destructive; Retry lets the user release a
  # transient lock. Unattended installs stay silent; a user-requested restart must explain failure
  # even though electron-updater starts NSIS with /S and exits before observing the result.
  Function ensureExistingUninstallerIsWritable
    IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" ensureExistingUninstallerIsWritable_retry ensureExistingUninstallerIsWritable_done

    ensureExistingUninstallerIsWritable_retry:
      System::Call 'kernel32::SetLastError(i 0)'
      System::Call 'kernel32::CreateFile(t "$INSTDIR\${UNINSTALL_FILENAME}", i 0x40000000, i 1, i 0, i 3, i 0x80, i 0) p.R0 ?e'
      Pop $R1
      StrCmp $R1 0 0 ensureExistingUninstallerIsWritable_failed
      System::Call 'kernel32::CloseHandle(p R0)'
      Return

    ensureExistingUninstallerIsWritable_failed:
      DetailPrint `Cannot replace the existing uninstaller: "$INSTDIR\${UNINSTALL_FILENAME}". Windows error: $R1.`
      ${if} ${Silent}
        # --updated + --force-run is the existing Restart to update handoff, including old clients.
        # Plain /S and non-relaunching update jobs must not wait for someone to dismiss a dialog.
        ${ifNot} ${isUpdated}
          Goto ensureExistingUninstallerIsWritable_cancel
        ${endif}
        ${ifNot} ${isForceRun}
          Goto ensureExistingUninstallerIsWritable_cancel
        ${endif}
      ${endif}
      ${if} $R1 == 5
        MessageBox MB_OK|MB_ICONEXCLAMATION|MB_SETFOREGROUND "Open-Science could not finish updating.$\r$\n$\r$\nWindows denied access to:$\r$\n$INSTDIR\${UNINSTALL_FILENAME}$\r$\n$\r$\nClose this notice, then run the official Open-Science installer as administrator to update this installation.$\r$\n$\r$\nWindows error: $R1"
      ${elseif} $R1 == 32
      ${orIf} $R1 == 33
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION|MB_SETFOREGROUND "Open-Science could not finish updating.$\r$\n$\r$\nAnother process is using:$\r$\n$INSTDIR\${UNINSTALL_FILENAME}$\r$\n$\r$\nClose the process using this file, then choose Retry. Choose Cancel to stop this update.$\r$\n$\r$\nWindows error: $R1" IDRETRY ensureExistingUninstallerIsWritable_retry
      ${else}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION|MB_SETFOREGROUND "Open-Science could not finish updating.$\r$\n$\r$\nWindows could not replace:$\r$\n$INSTDIR\${UNINSTALL_FILENAME}$\r$\n$\r$\nChoose Retry to try again, or Cancel to stop this update. If the problem continues, report the file path and Windows error below.$\r$\n$\r$\nWindows error: $R1" IDRETRY ensureExistingUninstallerIsWritable_retry
      ${endif}

    ensureExistingUninstallerIsWritable_cancel:
      # customInit may have discovered data left outside the installation by an older update.
      !insertmacro restoreAllNestedDataRoots
      !insertmacro quitFailedUpdate

    ensureExistingUninstallerIsWritable_done:
      Return
  FunctionEnd

  Function protectNestedDataRootsForInstall
    !ifdef openScienceOriginalInstFilesPre
      # An update must replace the registered installation, including a custom directory that
      # does not contain APP_FILENAME. The setup-page sanitizer would append a second directory.
      ${ifNot} ${isUpdated}
        Call ${openScienceOriginalInstFilesPre}
      ${endif}
    !endif
    Call ensureExistingUninstallerIsWritable
    !insertmacro protectMachineDataRootForSelectedMode
    Push "installing"
    Call writeUpdateReceipt
  FunctionEnd

  Function restorePreservedOnAbort
    Call cleanupInstallPublication
    !insertmacro restoreAllNestedDataRoots
    Push "failed"
    Call writeUpdateReceipt
  FunctionEnd

  Function .onInstFailed
    Call cleanupInstallPublication
    !insertmacro restoreAllNestedDataRoots
    Push "failed"
    Call writeUpdateReceipt
  FunctionEnd
!macroend

!macro customInstall
  # NSIS does not consume electron-builder's protocols option. Run after the old uninstaller
  # and file publication on EVERY install, including silent and in-app updates.
  ClearErrors
  WriteRegStr HKCU "Software\Classes\open-science" "" "URL:Open-Science"
  WriteRegStr HKCU "Software\Classes\open-science" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\open-science\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\open-science\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${if} ${Errors}
    DetailPrint "Open-Science protocol registration failed."
    !insertmacro quitFailedUpdate
  ${endif}
  Push "installed"
  Call writeUpdateReceipt
!macroend

# Retry the bundled selective uninstaller once after releasing leftover program processes.
# Its success callback normalizes the assisted-uninstaller exit code. A non-zero result is a
# real failure even if the main executable has already been removed during payload cleanup.
# Symbol constraints: handleUninstallResult is parsed BEFORE uninstallOldVersion and
# CHECK_APP_RUNNING declare their globals ($installationDir, $PowerShellPath, ...), and makensis
# treats unknown variables as errors — so this stays self-contained: registers, built-in
# constants, and the literal temp-uninstaller path uninstallOldVersion uses.
!macro uninstallFailureRecoveryAt DIR
  DetailPrint `Old uninstaller exited with $R0; closing leftover app processes and retrying once.`
  # Force-kill anything still running from the install dir, then retry. The PowerShell sweep
  # matches on ExecutablePath (Win32_Process has no Path property) with a trailing-backslash
  # boundary so a sibling directory can never match, and receives the directory as an ARGUMENT —
  # never interpolated into the script source — so a custom install dir containing an apostrophe
  # breaks nothing and injects nothing. If inspection is unavailable, never widen the target
  # to executable names: another installation or an unrelated tool may use the same name.
  # $0 keeps the uninstaller arguments (/currentuser etc.) — nsExec does not touch it.
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "$$root = $$args[0].TrimEnd('\') + '\'; Get-CimInstance -ClassName Win32_Process | ? { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, 'CurrentCultureIgnoreCase') } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }" "${DIR}"`
  Pop $R1
  # The existing uninstall retry remains the verdict even when process inspection fails.
  ${if} $R1 != 0
    DetailPrint `Could not inspect installation processes: $R1; retrying without terminating unverified processes.`
  ${endif}
  ClearErrors
  Sleep 1000
  # The bundled current uninstaller excludes data on every attempt. Never move a data root
  # around retry and never fall back to the old installed uninstaller.

  ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=${DIR}' $R0
  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    !insertmacro restoreAllNestedDataRoots
    !insertmacro quitFailedUpdate
  ${endif}
!macroend

!macro customUnInstallCheck
  # SHELL_CONTEXT resolves from the FINAL install-mode page selection, not the mode seen by
  # customInit. Finish cleanup/retry before restoring any historical interrupted-update backup.
  ${if} $R0 != 0
    # SHELL_CONTEXT pass: the old installation sits at $INSTDIR (an update installs over it).
    !insertmacro uninstallFailureRecoveryAt $INSTDIR
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
      !insertmacro quitFailedUpdate
    ${endif}
    !insertmacro uninstallFailureRecoveryAt $perUserInstallDirCache
  ${endif}
  # The old uninstall may have removed its registry key, so restore using the path cached before
  # either pass rather than reading InstallLocation here. Recovery must finish first because the
  # still-preserved backup is what keeps a recreated data directory from short-circuiting retry.
  !insertmacro restoreNestedDataRoot $perUserInstallDirCache $perUserDataBackup
  !insertmacro quitIfDataRestoreFailed
  Call ensureExistingUninstallerIsWritable
!macroend

!endif
