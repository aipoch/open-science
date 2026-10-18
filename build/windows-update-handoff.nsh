# Presentation-only protocol. NSIS remains the sole installer; no caller-supplied write path.
Var updateOperation
Var updateReceiptRoot

Function initializeUpdateReceipts
  StrCpy $updateOperation ""
  StrCpy $updateReceiptRoot ""
  ${GetOptions} $CMDLINE "--open-science-update-operation=" $updateOperation
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
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    IfFileExists "$updateReceiptRoot\request.json" 0 updateReceipt_invalid
    Push "accepted"
    Call writeUpdateReceipt
    Return
  updateReceipt_invalid:
    StrCpy $updateOperation ""
    StrCpy $updateReceiptRoot ""
    ClearErrors
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
      System::Call 'kernel32::FlushFileBuffers(p rR0)'
      FileClose $R0
      System::Call 'kernel32::MoveFileEx(t "$updateReceiptRoot\$R4.receipt.tmp", t "$updateReceiptRoot\$R4.receipt", i 9) i.rR1'
    ${endif}
    # Observation failure cannot change installation or imply success. The companion stays unknown.
    ClearErrors
  ${endif}
  Pop $R1
  Pop $R0
  Pop $R4
FunctionEnd
