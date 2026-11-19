!ifndef OPEN_SCIENCE_INSTALL_DIAGNOSTICS_INCLUDED
!define OPEN_SCIENCE_INSTALL_DIAGNOSTICS_INCLUDED

!include LogicLib.nsh
Var cleanupReport
!ifdef VERSION
  !define OPEN_SCIENCE_DIAGNOSTIC_VERSION "${VERSION}"
!else
  !define OPEN_SCIENCE_DIAGNOSTIC_VERSION "unknown"
!endif
!ifdef PRODUCT_NAME
  !define OPEN_SCIENCE_DIAGNOSTIC_PRODUCT "${PRODUCT_NAME}"
!else
  !define OPEN_SCIENCE_DIAGNOSTIC_PRODUCT "Open-Science"
!endif

!ifndef BUILD_UNINSTALLER
Var cleanupAttempt
Var cleanupUninstallArguments
Var cleanupMessage
Var installDiagnosticDirectory
Var installDiagnosticMessagePath
Var installDiagnosticMessage

# nsExec's stack capture can truncate a UTF-16 message by bytes and corrupt its final path.
# Read the private UTF-16 notice directly; all installer notices use this same transport.
Function readInstallDiagnosticMessage
  Push $0
  Push $1
  StrCpy $installDiagnosticMessage ""
  ClearErrors
  FileOpen $0 "$installDiagnosticMessagePath" r
  IfErrors readInstallDiagnosticMessage_done
  readInstallDiagnosticMessage_line:
    ClearErrors
    FileReadUTF16LE $0 $1
    IfErrors readInstallDiagnosticMessage_close
    StrCpy $installDiagnosticMessage "$installDiagnosticMessage$1"
    Goto readInstallDiagnosticMessage_line
  readInstallDiagnosticMessage_close:
    FileClose $0
  readInstallDiagnosticMessage_done:
    Pop $1
    Pop $0
FunctionEnd

# A fresh filename per launch prevents an earlier failure being mistaken for the final result,
# including when the child never starts or exits before it can write a report.
!macro beginCleanupAttempt
  IntOp $cleanupAttempt $cleanupAttempt + 1
  StrCpy $cleanupReport "$PLUGINSDIR\cleanup-attempt-$cleanupAttempt.json"
  Delete "$cleanupReport"
  StrCpy $0 '$cleanupUninstallArguments --cleanup-report="$cleanupReport"'
  ClearErrors
!macroend

Function showCleanupFailure
  Push $R0
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  !ifdef OPEN_SCIENCE_PROGRAM_CLEANUP_INCLUDED
    !insertmacro extractUninstallHelper
  !endif
  StrCpy $installDiagnosticMessagePath "$PLUGINSDIR\cleanup-notice.txt"
  Delete "$PLUGINSDIR\cleanup-notice.txt"
  # Derive the notice path from the report inside the helper. nsExec truncates long expanded
  # argument values, so passing the absolute message path directly is unsafe.
  nsExec::ExecToStack '"$PLUGINSDIR\windows-uninstall-helper.exe" diagnostics --action finalize --report-path "$cleanupReport" --reports-directory "$PLUGINSDIR" --install-path "$INSTDIR" --exit-code "$R0" --app-version "${OPEN_SCIENCE_DIAGNOSTIC_VERSION}" --product-name "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT}" --language $LANGUAGE --log-directory "$installDiagnosticDirectory" --write-message-next-to-report'
  Pop $R1
  Pop $cleanupMessage
  Call readInstallDiagnosticMessage
  StrCpy $cleanupMessage $installDiagnosticMessage
  ${if} $R1 != 0
  ${orIf} $cleanupMessage == ""
    StrCpy $cleanupMessage "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT} could not remove the old application files. Restoration could not be confirmed. Run the official installer again or contact support. The diagnostic could not be saved."
  ${endif}
  DetailPrint "$cleanupMessage"
  IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "$cleanupMessage"
  Pop $R0
FunctionEnd
!endif

!endif
