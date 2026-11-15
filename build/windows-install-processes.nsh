!ifndef OPEN_SCIENCE_INSTALL_PROCESSES_NSH
!define OPEN_SCIENCE_INSTALL_PROCESSES_NSH
!include LogicLib.nsh

# Sizeof PROCESSENTRY32W: th32DefaultHeapID is pointer-sized.
!if ${NSIS_PTR_SIZE} > 4
  !define /ifndef OPEN_SCIENCE_PROCESS_ENTRY_SIZE 568
!else
  !define /ifndef OPEN_SCIENCE_PROCESS_ENTRY_SIZE 556
!endif

# Finds ("find") or terminates ("stop") every process whose full image path is inside ROOT, and
# leaves "0" (at least one match), "1" (none) or "error" (no process inventory) in RESULT.
# Enumerates in-process with Toolhelp: launching powershell.exe from an installer costs 0.6-1.2 s
# per check. The trailing-backslash boundary keeps a sibling directory from ever matching, and
# the path never passes through a command line. The current process is never a target. Uses only
# registers, so callers parsed before any Var declaration can use it: $R1-$R9 are restored, and
# $R0 is overwritten with the result.
!macro openScienceInstallProcesses ROOT ACTION RESULT
  !define _OSP_ID ${__LINE__}
  !if "${ACTION}" == "stop"
    # PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE
    !define _OSP_ACCESS 0x1001
  !else
    !define _OSP_ACCESS 0x1000
  !endif
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R2 "${ROOT}"
  trim_${_OSP_ID}:
    StrCpy $R3 $R2 1 -1
    ${If} $R3 == "\"
      StrCpy $R2 $R2 -1
      Goto trim_${_OSP_ID}
    ${EndIf}
  StrCpy $R2 "$R2\"
  StrLen $R3 $R2
  StrCpy $R9 1
  System::Call 'kernel32::GetCurrentProcessId()i.R1'
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0)p.R4'
  ${If} $R4 = -1
  ${OrIf} $R4 = 0
    StrCpy $R9 "error"
  ${Else}
    System::Alloc ${OPEN_SCIENCE_PROCESS_ENTRY_SIZE}
    Pop $R5
    System::Call '*$R5(i ${OPEN_SCIENCE_PROCESS_ENTRY_SIZE})'
    System::Call 'kernel32::Process32FirstW(pR4, pR5)i.R6 ?e'
    loop_${_OSP_ID}:
      Pop $R7
      ${If} $R6 = 0
        # ERROR_NO_MORE_FILES ends a complete walk; anything else leaves the inventory unproven.
        ${If} $R7 <> 18
          StrCpy $R9 "error"
        ${EndIf}
        Goto done_${_OSP_ID}
      ${EndIf}
      System::Call '*$R5(i, i, i .R7)'
      ${If} $R7 <> $R1
        System::Call 'kernel32::OpenProcess(i ${_OSP_ACCESS}, i 0, i R7)p.R8'
        ${If} $R8 <> 0
          System::Call 'kernel32::QueryFullProcessImageNameW(pR8, i 0, w .R6, *i ${NSIS_MAX_STRLEN})i.R7'
          ${If} $R7 <> 0
            StrCpy $R6 $R6 $R3
            # LogicLib == is case-insensitive, like the previous CIM prefix match.
            ${If} $R6 == $R2
              StrCpy $R9 0
              !if "${ACTION}" == "stop"
                System::Call 'kernel32::TerminateProcess(pR8, i 1)'
              !endif
            ${EndIf}
          ${EndIf}
          System::Call 'kernel32::CloseHandle(pR8)'
          !if "${ACTION}" != "stop"
            ${If} $R9 == 0
              Goto done_${_OSP_ID}
            ${EndIf}
          !endif
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::Process32NextW(pR4, pR5)i.R6 ?e'
      Goto loop_${_OSP_ID}
    done_${_OSP_ID}:
    System::Free $R5
    System::Call 'kernel32::CloseHandle(pR4)'
  ${EndIf}
  StrCpy $R0 $R9
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  StrCpy ${RESULT} $R0
  !undef _OSP_ACCESS
  !undef _OSP_ID
!macroend

!endif
