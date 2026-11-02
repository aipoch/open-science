!ifndef OPEN_SCIENCE_PROGRAM_CLEANUP_INCLUDED
!define OPEN_SCIENCE_PROGRAM_CLEANUP_INCLUDED

!include "LogicLib.nsh"

!ifdef BUILD_UNINSTALLER
Var programSourceRoot
Var programTargetRoot
Var programStagingDirectory
Var programConfigRoot
Var programConfigTarget
Var programDataRoot
Var programDataTarget

Function un.loadProgramDataPaths
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  File "${BUILD_RESOURCES_DIR}\windows-program-data-paths.ps1"
  File "${BUILD_RESOURCES_DIR}\windows-program-cleanup.ps1"
  # The shared managed helper is AnyCPU, including in universal installers.
  !ifdef APP_64
    File "${PROJECT_DIR}\out\windows-installer\x64\windows-install-publication.dll"
  !else ifdef APP_ARM64
    File "${PROJECT_DIR}\out\windows-installer\arm64\windows-install-publication.dll"
  !else
    File "${PROJECT_DIR}\out\windows-installer\ia32\windows-install-publication.dll"
  !endif
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-program-data-paths.ps1" -InstallPath "$INSTDIR" -OutputPath "$PLUGINSDIR\program-data-paths.txt" -MaxLineLength ${NSIS_MAX_STRLEN}'
  Pop $R0
  ${if} $R0 != 0
    SetErrorLevel 2
    Abort "Could not resolve the configured data locations."
  ${endif}
  ClearErrors
  FileOpen $R1 "$PLUGINSDIR\program-data-paths.txt" r
  FileReadUTF16LE $R1 $programConfigRoot
  FileReadUTF16LE $R1 $programConfigTarget
  FileReadUTF16LE $R1 $programDataRoot
  FileReadUTF16LE $R1 $programDataTarget
  FileClose $R1
  ${if} ${Errors}
    SetErrorLevel 2
    Abort "Could not read the configured data locations."
  ${endif}
  # The helper writes exactly four UTF-16LE lines without a BOM, including empty paths.
  StrCpy $programConfigRoot $programConfigRoot -2
  StrCpy $programConfigTarget $programConfigTarget -2
  StrCpy $programDataRoot $programDataRoot -2
  StrCpy $programDataTarget $programDataTarget -2
FunctionEnd

!macro returnIfProgramDataPath CANDIDATE ROOT DONE
  ${if} "${ROOT}" != ""
    StrLen $R4 "${ROOT}"
    StrCpy $R3 "${CANDIDATE}" $R4
    ${if} $R3 == "${ROOT}"
      StrCpy $R3 "${CANDIDATE}" 1 $R4
      ${if} $R3 == ""
      ${orIf} $R3 == "\"
        StrCpy $R3 0
        Goto ${DONE}
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro returnIfProgramDataAncestor CANDIDATE ROOT
  StrLen $R4 "${CANDIDATE}"
  StrCpy $R3 "${ROOT}" $R4
  ${if} $R3 == "${CANDIDATE}"
    StrCpy $R3 "${ROOT}" 1 $R4
    ${if} $R3 == "\"
      StrCpy $R3 0
      Goto programMove_done
    ${endif}
  ${endif}
!macroend

# Assisted NSIS uninstallers otherwise leak a trailing error flag as exit code 2. Only a
# completed uninstall normalizes success; Abort from cleanup must retain its failure result.
Function un.onUninstSuccess
  SetErrorLevel 0
FunctionEnd

# Move individual program files on the installation volume before deleting any of them. A busy
# file can then abort with the old payload restored. Directory links move as entries, never targets.
Function un.moveProgramTree
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  ${if} $programSourceRoot == $INSTDIR
    !insertmacro returnIfProgramDataPath "$programSourceRoot\$R0" $programConfigRoot programMove_done
    !insertmacro returnIfProgramDataPath "$programSourceRoot\$R0" $programConfigTarget programMove_done
    !insertmacro returnIfProgramDataPath "$programSourceRoot\$R0" $programDataRoot programMove_done
    !insertmacro returnIfProgramDataPath "$programSourceRoot\$R0" $programDataTarget programMove_done
  ${endif}
  System::Call 'kernel32::GetFileAttributes(t "$programSourceRoot\$R0") i.R3 ?e'
  Pop $R4
  ${if} $R3 == -1
    ${if} $R4 == 2
    ${orIf} $R4 == 3
      StrCpy $R3 0
    ${else}
      StrCpy $R3 "$programSourceRoot\$R0"
    ${endif}
    Goto programMove_done
  ${endif}
  IntOp $R4 $R3 & 0x400
  ${if} $R4 != 0
  ${andIf} $programSourceRoot == $INSTDIR
    # Keep a junction needed to reach a configured descendant, even if its target is external.
    !insertmacro returnIfProgramDataAncestor "$programSourceRoot\$R0" $programConfigRoot
    !insertmacro returnIfProgramDataAncestor "$programSourceRoot\$R0" $programConfigTarget
    !insertmacro returnIfProgramDataAncestor "$programSourceRoot\$R0" $programDataRoot
    !insertmacro returnIfProgramDataAncestor "$programSourceRoot\$R0" $programDataTarget
    # The comparison macros use $R3, so reload attributes before selecting directory traversal.
    System::Call 'kernel32::GetFileAttributes(t "$programSourceRoot\$R0") i.R3'
  ${endif}
  IntOp $R3 $R3 & 0x410
  ${if} $R3 == 16
    ClearErrors
    CreateDirectory "$programTargetRoot\$R0"
    ${if} ${Errors}
      StrCpy $R3 "$programTargetRoot\$R0"
      Goto programMove_done
    ${endif}
    FindFirst $R1 $R2 "$programSourceRoot\$R0\*.*"
    programMove_next:
      StrCmp $R2 "" programMove_close
      StrCmp $R2 "." programMove_continue
      StrCmp $R2 ".." programMove_continue
      Push "$R0\$R2"
      Call un.moveProgramTree
      Pop $R3
      ${if} $R3 != 0
        FindClose $R1
        Goto programMove_done
      ${endif}
      programMove_continue:
        FindNext $R1 $R2
        Goto programMove_next
    programMove_close:
      FindClose $R1
      StrCpy $R3 0
  ${else}
    ClearErrors
    Rename "$programSourceRoot\$R0" "$programTargetRoot\$R0"
    StrCpy $R3 0
    ${if} ${Errors}
      StrCpy $R3 "$programSourceRoot\$R0"
    ${endif}
  ${endif}
  programMove_done:
    StrCpy $R0 $R3
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

# Remove only empty scaffolding. Never delete a file or follow a reparse entry here.
Function un.removeEmptyProgramDirectories
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  !insertmacro returnIfProgramDataPath "$R0" $programConfigRoot programTree_done
  !insertmacro returnIfProgramDataPath "$R0" $programConfigTarget programTree_done
  !insertmacro returnIfProgramDataPath "$R0" $programDataRoot programTree_done
  !insertmacro returnIfProgramDataPath "$R0" $programDataTarget programTree_done
  System::Call 'kernel32::GetFileAttributes(t R0) i.R3 ?e'
  Pop $R4
  ${if} $R3 == -1
    ${if} $R4 == 2
    ${orIf} $R4 == 3
      StrCpy $R3 0
    ${else}
      StrCpy $R3 $R0
    ${endif}
    Goto programTree_done
  ${endif}
  IntOp $R3 $R3 & 0x400
  ${if} $R3 != 0
    StrCpy $R3 0
    Goto programTree_done
  ${endif}
  FindFirst $R1 $R2 "$R0\*.*"
  programTree_next:
    StrCmp $R2 "" programTree_close
    StrCmp $R2 "." programTree_continue
    StrCmp $R2 ".." programTree_continue
    System::Call 'kernel32::GetFileAttributes(t "$R0\$R2") i.R3'
    IntOp $R3 $R3 & 0x10
    ${if} $R3 != 0
      Push "$R0\$R2"
      Call un.removeEmptyProgramDirectories
      Pop $R3
    ${else}
      StrCpy $R3 0
    ${endif}
    ${if} $R3 != 0
      FindClose $R1
      Goto programTree_done
    ${endif}
    programTree_continue:
      FindNext $R1 $R2
      Goto programTree_next
  programTree_close:
    FindClose $R1
    ClearErrors
    RMDir "$R0"
    StrCpy $R3 0
  programTree_done:
    StrCpy $R0 $R3
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd
!endif

!macro stageProgramEntry NAME
  Push "${NAME}"
  Call un.moveProgramTree
  Pop $R0
  ${if} $R0 != 0
    DetailPrint `Could not stage application file: $R0`
    Goto programCleanup_rollback
  ${endif}
!macroend

!macro customRemoveFiles
  GetFullPathName $INSTDIR "$INSTDIR"
  programCleanup_normalize:
    StrLen $R0 $INSTDIR
    IntCmp $R0 3 programCleanup_normalized programCleanup_normalized
    StrCpy $R0 $INSTDIR 1 -1
    StrCmp $R0 "\" 0 programCleanup_normalized
    StrCpy $INSTDIR $INSTDIR -1
    Goto programCleanup_normalize
  programCleanup_normalized:
  Call un.loadProgramDataPaths
  SetOutPath $TEMP
  ClearErrors
  GetTempFileName $programStagingDirectory "$INSTDIR"
  ${ifNot} ${Errors}
    Delete "$programStagingDirectory"
    CreateDirectory "$programStagingDirectory"
  ${endif}
  ${if} ${Errors}
    SetErrorLevel 2
    Abort "Could not prepare application cleanup."
  ${endif}
  StrCpy $programSourceRoot $INSTDIR
  StrCpy $programTargetRoot $programStagingDirectory
  # Stage only reserved application payload paths. Unknown files and directories (including
  # root-level workspaces and custom data locations) remain in place; never sweep $INSTDIR.
  !insertmacro stageProgramEntry resources
  !insertmacro stageProgramEntry locales
  !insertmacro stageProgramEntry chrome_100_percent.pak
  !insertmacro stageProgramEntry chrome_200_percent.pak
  !insertmacro stageProgramEntry d3dcompiler_47.dll
  !insertmacro stageProgramEntry dxcompiler.dll
  !insertmacro stageProgramEntry dxil.dll
  !insertmacro stageProgramEntry ffmpeg.dll
  !insertmacro stageProgramEntry icudtl.dat
  !insertmacro stageProgramEntry libEGL.dll
  !insertmacro stageProgramEntry libGLESv2.dll
  !insertmacro stageProgramEntry LICENSE.electron.txt
  !insertmacro stageProgramEntry LICENSES.chromium.html
  !insertmacro stageProgramEntry resources.pak
  !insertmacro stageProgramEntry snapshot_blob.bin
  !insertmacro stageProgramEntry v8_context_snapshot.bin
  !insertmacro stageProgramEntry vk_swiftshader_icd.json
  !insertmacro stageProgramEntry vk_swiftshader.dll
  !insertmacro stageProgramEntry vulkan-1.dll
  !insertmacro stageProgramEntry uninstallerIcon.ico
  !insertmacro stageProgramEntry "${APP_EXECUTABLE_FILENAME}"
  !insertmacro stageProgramEntry "${UNINSTALL_FILENAME}"
  # Hold all deletion dispositions until the complete program payload can be removed. A late
  # access/sharing failure cancels earlier dispositions, leaving every byte available to restore.
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-program-cleanup.ps1" -StagingPath "$programStagingDirectory"'
  Pop $R0
  ${if} $R0 != 0
    DetailPrint `Could not commit program cleanup: $R0`
    Goto programCleanup_rollback
  ${endif}
  # Data roots stay in the source tree. Remove only empty program scaffolding around them.
  Push "$INSTDIR\resources"
  Call un.removeEmptyProgramDirectories
  Pop $R0
  Push "$INSTDIR\locales"
  Call un.removeEmptyProgramDirectories
  Pop $R0
  StrCpy $R5 10
  programCleanup_removeEmptyStaging:
    Push $programStagingDirectory
    Call un.removeEmptyProgramDirectories
    Pop $R0
    IfFileExists "$programStagingDirectory" 0 programCleanup_removedStaging
    IntOp $R5 $R5 - 1
    ${if} $R5 > 0
      Sleep 100
      Goto programCleanup_removeEmptyStaging
    ${endif}
    DetailPrint `Program files removed; empty staging directories remain: $programStagingDirectory`
  programCleanup_removedStaging:
  # Remove an empty installation directory only. A directory containing user data is retained.
  RMDir "$INSTDIR"
  ClearErrors
  Goto programCleanup_done

  programCleanup_rollback:
    StrCpy $programSourceRoot $programStagingDirectory
    StrCpy $programTargetRoot $INSTDIR
    # Retry only this run's staged files; never discover or sweep another run's staging.
    StrCpy $R5 10
    programCleanup_restoreAttempt:
      Push ""
      Call un.moveProgramTree
      Pop $R0
      ${if} $R0 == 0
        Push $programStagingDirectory
        Call un.removeEmptyProgramDirectories
        Pop $R0
        IfFileExists "$programStagingDirectory" 0 +2
        StrCpy $R0 $programStagingDirectory
      ${endif}
      ${if} $R0 != 0
        IntOp $R5 $R5 - 1
        ${if} $R5 > 0
          Sleep 100
          Goto programCleanup_restoreAttempt
        ${endif}
        DetailPrint `Could not restore or clean up application file: $R0. Remaining program files: $programStagingDirectory`
      ${endif}
    SetErrorLevel 2
    Abort
  programCleanup_done:
!macroend

!endif
