# Presentation-only protocol. NSIS remains the sole installer; no caller-supplied write path.
Var updateOperation
Var updateReceiptRoot

# electron-builder loads custom includes before LogicLib and $installMode exist. Declare the
# shared variables early, but emit functions from customHeader after those dependencies load.
!macro defineUpdateReceiptFunctions
Function initializeUpdateReceipts
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  StrCpy $updateOperation ""
  StrCpy $updateReceiptRoot ""
  # FileFunc.GetOptions treats '-' inside UUIDs as an option separator. Parse the actual Windows
  # argv instead, preserving UUIDs, quoted paths and surrounding electron-updater flags.
  System::Call 'shell32::CommandLineToArgvW(w c, *i .R0) p.R1'
  StrCmp $R1 0 updateReceipt_invalid
  StrCpy $R2 $R1
  StrCpy $R5 0
  StrLen $R7 "--open-science-update-operation="
  updateReceipt_argument:
    IntCmp $R0 0 updateReceipt_argumentsDone updateReceipt_argumentsDone
    System::Call '*$R2(p .R3)'
    System::Call 'kernel32::lstrcpynW(w .R4, p R3, i ${NSIS_MAX_STRLEN})'
    StrCpy $R6 $R4 $R7
    ${if} $R6 == "--open-science-update-operation="
      IntOp $R5 $R5 + 1
      StrCpy $updateOperation $R4 "" $R7
    ${endif}
    IntPtrOp $R2 $R2 + ${NSIS_PTR_SIZE}
    IntOp $R0 $R0 - 1
    Goto updateReceipt_argument
  updateReceipt_argumentsDone:
    System::Call 'kernel32::LocalFree(p R1)'
    StrCmp $R5 1 0 updateReceipt_invalid
  StrLen $R0 $updateOperation
  StrCmp $R0 36 0 updateReceipt_invalid
  StrCpy $R0 0
  updateReceipt_validate:
    StrCpy $R1 $updateOperation 1 $R0
    ${if} $R0 == 8
    ${orIf} $R0 == 13
    ${orIf} $R0 == 18
    ${orIf} $R0 == 23
      StrCmp $R1 "-" updateReceipt_next updateReceipt_invalid
    ${endif}
    StrCpy $R2 0
    updateReceipt_hex:
      StrCpy $R3 "0123456789abcdef" 1 $R2
      StrCmp $R1 $R3 updateReceipt_next
      IntOp $R2 $R2 + 1
      IntCmp $R2 16 updateReceipt_invalid updateReceipt_hex updateReceipt_invalid
    updateReceipt_next:
      IntOp $R0 $R0 + 1
      IntCmp $R0 36 updateReceipt_valid updateReceipt_validate updateReceipt_invalid
  updateReceipt_valid:
    # Get the original current-user roaming root even when installer shell context is all-users.
    SetShellVarContext current
    StrCpy $updateReceiptRoot "$APPDATA\Open-Science\UpdateHandoffs\$updateOperation"
    StrCpy $R6 "$APPDATA\Open-Science-UpdateHandoffs\$updateOperation"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    # Never prefer one of two copies of the same operation. Older leases stay at the first root.
    System::Call 'kernel32::GetFileAttributesW(w "$updateReceiptRoot") i.R0'
    System::Call 'kernel32::GetFileAttributesW(w R6) i.R1'
    ${if} $R0 != -1
      ${if} $R1 != -1
        Goto updateReceipt_invalid
      ${endif}
    ${else}
      StrCpy $updateReceiptRoot $R6
    ${endif}
    IfFileExists "$updateReceiptRoot\request.json" 0 updateReceipt_invalid
    Push "accepted"
    Call writeUpdateReceipt
    Goto updateReceipt_done
  updateReceipt_invalid:
    StrCpy $updateOperation ""
    StrCpy $updateReceiptRoot ""
    ClearErrors
  updateReceipt_done:
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

Function writeUpdateReceipt
  Exch $R4
  Push $R0
  Push $R1
  ${if} $updateReceiptRoot != ""
    # Different stages have separate immutable files. Publish the complete ASCII payload atomically.
    ClearErrors
    FileOpen $R0 "$updateReceiptRoot\$R4.receipt.tmp" w
    ${ifNot} ${Errors}
      FileWrite $R0 "$updateOperation$\r$\n$R4$\r$\n"
      System::Call 'kernel32::FlushFileBuffers(p R0)'
      FileClose $R0
      System::Call 'kernel32::MoveFileEx(t "$updateReceiptRoot\$R4.receipt.tmp", t "$updateReceiptRoot\$R4.receipt", i 9) i.R1'
    ${endif}
    # Observation failure cannot change installation or imply success. The companion stays unknown.
    ClearErrors
  ${endif}
  Pop $R1
  Pop $R0
  Pop $R4
FunctionEnd
!macroend
