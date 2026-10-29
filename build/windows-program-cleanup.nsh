!ifndef OPEN_SCIENCE_PROGRAM_CLEANUP_INCLUDED
!define OPEN_SCIENCE_PROGRAM_CLEANUP_INCLUDED

!include "LogicLib.nsh"

!ifdef BUILD_UNINSTALLER
Var programSourceRoot
Var programTargetRoot
Var programStagingDirectory

# Move individual program files on the installation volume before deleting any of them. A busy
# file can then abort with the old payload restored. Directory links move as entries, never targets.
Function un.moveProgramTree
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
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

# NSIS RMDir /r follows directory junctions. Traverse owned program trees explicitly, removing
# reparse entries themselves without descending into their targets (which may hold research).
Function un.removeProgramTree
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
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
    Goto programTree_removeDirectory
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
      Call un.removeProgramTree
      Pop $R3
    ${else}
      ClearErrors
      Delete "$R0\$R2"
      StrCpy $R3 0
      ${if} ${Errors}
        StrCpy $R3 "$R0\$R2"
      ${endif}
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
  programTree_removeDirectory:
    ClearErrors
    RMDir "$R0"
    StrCpy $R3 0
    ${if} ${Errors}
      StrCpy $R3 $R0
    ${endif}
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
  !insertmacro stageProgramEntry "${UNINSTALL_FILENAME}"
  # Keep the executable until all earlier moves succeed, retaining the existing retry marker.
  !insertmacro stageProgramEntry "${APP_EXECUTABLE_FILENAME}"
  Push "$INSTDIR\resources"
  Call un.removeProgramTree
  Pop $R0
  Push "$INSTDIR\locales"
  Call un.removeProgramTree
  Pop $R0
  Push $programStagingDirectory
  Call un.removeProgramTree
  Pop $R0
  ${if} $R0 != 0
    DetailPrint `Application cleanup left temporary program files at: $programStagingDirectory`
  ${endif}
  # Remove an empty installation directory only. A directory containing user data is retained.
  RMDir "$INSTDIR"
  ClearErrors
  Goto programCleanup_done

  programCleanup_rollback:
    StrCpy $programSourceRoot $programStagingDirectory
    StrCpy $programTargetRoot $INSTDIR
    Push ""
    Call un.moveProgramTree
    Pop $R0
    ${if} $R0 == 0
      Push $programStagingDirectory
      Call un.removeProgramTree
      Pop $R0
    ${else}
      DetailPrint `Could not restore application file: $R0. Remaining program files: $programStagingDirectory`
    ${endif}
    SetErrorLevel 2
    Abort
  programCleanup_done:
!macroend

!endif
