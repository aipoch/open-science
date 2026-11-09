!ifndef OPEN_SCIENCE_INSTALL_PUBLICATION_INCLUDED
!define OPEN_SCIENCE_INSTALL_PUBLICATION_INCLUDED
!include x64.nsh
!include "${BUILD_RESOURCES_DIR}\windows-install-diagnostics.nsh"

!ifdef APP_64
  # APP_64 is the final archive, including files added after afterSign (elevate.exe).
  # Generate at compile time for normal and --prepackaged builds; fail closed on errors.
  !system '"node" "${BUILD_RESOURCES_DIR}/prepare-windows-extraction.cjs" "${APP_64}" "${PROJECT_DIR}/out/windows-installer/x64/extraction"' = 0
!endif

Var publicationDirectory
Var publicationState
Var publicationResult
Var publicationOutput
Var publicationPowerShell
Var publicationPhase
Var publicationSource
Var publicationReport
Var publicationCleanupReport
Var publicationCleanupResult
Var publicationCleanupOutput
Var publicationFailure
Var publicationFailurePrompted
Var publicationMessage

!macro runInstallPublication ACTION
  StrCpy $publicationPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  # NSIS is 32-bit: Sysnative avoids WOW64 redirection on native AMD64 Windows.
  # Keep the existing host on other architectures or when the alias is unavailable.
  ${If} ${IsNativeAMD64}
    IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
      StrCpy $publicationPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  !if "${ACTION}" == "cleanup"
    !define PUBLICATION_ACTION_REPORT "$publicationCleanupReport"
  !else
    !define PUBLICATION_ACTION_REPORT "$publicationReport"
  !endif
  nsExec::ExecToStack /TIMEOUT=120000 '"$publicationPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-publication.ps1" -Action ${ACTION} -InstallPath "$INSTDIR" -StatePath "$publicationState" -ReportPath "${PUBLICATION_ACTION_REPORT}"'
  !undef PUBLICATION_ACTION_REPORT
  Pop $publicationResult
  Pop $publicationOutput
!macroend

  Function cleanupInstallPublication
    StrCpy $publicationCleanupResult "not-needed"
    StrCmp $publicationState "" cleanupInstallPublication_done
    IfFileExists "$publicationState" 0 cleanupInstallPublication_done
    # Failure cleanup must never overwrite the result/output of prepare, extract or publish.
    Push $publicationResult
    Push $publicationOutput
    !insertmacro runInstallPublication cleanup
    DetailPrint "Payload cleanup: $publicationResult $publicationOutput"
    StrCpy $publicationCleanupResult $publicationResult
    StrCpy $publicationCleanupOutput $publicationOutput
    Push $0
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\publication-cleanup-output.txt" w
    IfErrors +3
      FileWriteUTF16LE $0 "$publicationCleanupOutput"
      FileClose $0
    Pop $0
    Pop $publicationOutput
    Pop $publicationResult
    ClearErrors
    StrCmp $publicationCleanupResult "0" 0 cleanupInstallPublication_failed
    StrCpy $publicationState ""
    StrCpy $publicationDirectory ""
    Goto cleanupInstallPublication_done
    cleanupInstallPublication_failed:
      SetErrors
    cleanupInstallPublication_done:
  FunctionEnd

Function recordInstallPublicationFailure
  StrCpy $publicationFailure "1"
  Push $0
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\publication-output.txt" w
  IfErrors +3
    FileWriteUTF16LE $0 "$publicationOutput"
    FileClose $0
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-diagnostics.ps1" -Action record -ReportPath "$publicationReport" -Phase "$publicationPhase" -ErrorSource "$publicationSource" -ExitCode "$publicationResult" -OutputPath "$PLUGINSDIR\publication-output.txt"'
  Pop $0
  Pop $0
  Pop $0
FunctionEnd

Function describeInstallPublicationFailure
  Push $0
  StrCpy $installDiagnosticMessagePath "$PLUGINSDIR\publication-notice.txt"
  Delete "$installDiagnosticMessagePath"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-diagnostics.ps1" -Action finalize -ReportPath "$publicationReport" -CleanupReportPath "$publicationCleanupReport" -CleanupExitCode "$publicationCleanupResult" -CleanupOutputPath "$PLUGINSDIR\publication-cleanup-output.txt" -ReportsDirectory "$PLUGINSDIR" -InstallPath "$INSTDIR" -Phase "$publicationPhase" -ExitCode "$publicationResult" -AppVersion "${OPEN_SCIENCE_DIAGNOSTIC_VERSION}" -ProductName "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT}" -Language $LANGUAGE -LogDirectory "$installDiagnosticDirectory" -MessagePath "$installDiagnosticMessagePath"'
  Pop $0
  Pop $publicationMessage
  Call readInstallDiagnosticMessage
  StrCpy $publicationMessage $installDiagnosticMessage
  ${If} $0 != 0
  ${OrIf} $publicationMessage == ""
    StrCpy $publicationMessage "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT} could not install the new application files. Installation is incomplete and the application may not start. Check the installation path, disk space and security software, then run the same official installer again. The diagnostic could not be saved."
  ${EndIf}
  DetailPrint "$publicationMessage"
  Pop $0
FunctionEnd

Function showInstallPublicationFailure
  StrCmp $publicationFailure "1" 0 showInstallPublicationFailure_done
  Call describeInstallPublicationFailure
  StrCmp $publicationFailurePrompted "1" showInstallPublicationFailure_done
  IfSilent showInstallPublicationFailure_done
    MessageBox MB_OK|MB_ICONEXCLAMATION "$publicationMessage"
  showInstallPublicationFailure_done:
FunctionEnd

!macro customExtractAppPackage FILE
  File /oname=$PLUGINSDIR\windows-install-publication.ps1 "${BUILD_RESOURCES_DIR}\windows-install-publication.ps1"
  File /oname=$PLUGINSDIR\windows-install-diagnostics.ps1 "${BUILD_RESOURCES_DIR}\windows-install-diagnostics.ps1"
  StrCpy $publicationState "$PLUGINSDIR\publication-state.json"
  StrCpy $publicationReport "$PLUGINSDIR\publication-failure.json"
  StrCpy $publicationCleanupReport "$PLUGINSDIR\publication-cleanup.json"
  Delete "$publicationReport"
  Delete "$publicationCleanupReport"
  Delete "$PLUGINSDIR\publication-output.txt"
  Delete "$PLUGINSDIR\publication-cleanup-output.txt"
  StrCpy $publicationFailure ""
  StrCpy $publicationFailurePrompted ""
  StrCpy $publicationPhase "prepare-new-program-files"
  StrCpy $publicationSource "publication-helper"
  # Keep the current directory outside staging so failed extraction cannot block cleanup.
  SetOutPath "$INSTDIR"
  !ifdef APP_ARM64
    ${If} ${IsNativeARM64}
      File /oname=$PLUGINSDIR\7za.exe "${PROJECT_DIR}\out\windows-installer\arm64\7za.exe"
      File /oname=$PLUGINSDIR\windows-install-publication.dll "${PROJECT_DIR}\out\windows-installer\arm64\windows-install-publication.dll"
    ${Else}
  !endif
  !ifdef APP_64
    ${If} ${RunningX64}
    ${OrIf} ${IsNativeARM64}
      File /oname=$PLUGINSDIR\7za.exe "${PROJECT_DIR}\out\windows-installer\x64\7za.exe"
      File /oname=$PLUGINSDIR\windows-install-publication.dll "${PROJECT_DIR}\out\windows-installer\x64\windows-install-publication.dll"
      File /oname=$PLUGINSDIR\windows-extract-payload.ps1 "${BUILD_RESOURCES_DIR}\windows-extract-payload.ps1"
      File /oname=$PLUGINSDIR\all-files.txt "${PROJECT_DIR}\out\windows-installer\x64\extraction\all-files.txt"
      File /oname=$PLUGINSDIR\all-directories.txt "${PROJECT_DIR}\out\windows-installer\x64\extraction\all-directories.txt"
      File /oname=$PLUGINSDIR\files-2-0.txt "${PROJECT_DIR}\out\windows-installer\x64\extraction\files-2-0.txt"
      File /oname=$PLUGINSDIR\files-2-1.txt "${PROJECT_DIR}\out\windows-installer\x64\extraction\files-2-1.txt"
    ${Else}
  !endif
  !ifdef APP_32
    File /oname=$PLUGINSDIR\7za.exe "${PROJECT_DIR}\out\windows-installer\ia32\7za.exe"
      File /oname=$PLUGINSDIR\windows-install-publication.dll "${PROJECT_DIR}\out\windows-installer\ia32\windows-install-publication.dll"
  !else
    StrCpy $publicationResult "unsupported-architecture"
    Goto publication_failed
  !endif
  !ifdef APP_64
    ${EndIf}
  !endif
  !ifdef APP_ARM64
    ${EndIf}
  !endif
  !insertmacro runInstallPublication prepare
  StrCmp $publicationResult "0" 0 publication_failed
  StrCpy $publicationDirectory $publicationOutput
  StrCpy $publicationPhase "extract-new-program-files"
  StrCpy $publicationSource "7za"
  SetDetailsPrint textonly
  DetailPrint "$(^Extract)Open-Science"
  SetDetailsPrint none
  # Nsis7z discards extraction errors. The CLI reports CRC, incomplete archive, write and
  # cancellation errors. Only exit 0 permits publication; a warning is not success.
  # nsExec hides the console and waits for exit. Its optional timeout is output inactivity,
  # not a work budget, so do not kill a valid large extraction merely because it is quiet.
  !ifdef APP_64
    ${If} ${IsNativeAMD64}
      StrCpy $publicationSource "powershell-extractor"
      nsExec::ExecToStack '"$publicationPowerShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-extract-payload.ps1" -Extractor "$PLUGINSDIR\7za.exe" -Archive "${FILE}" -Target "$publicationDirectory" -ListDirectory "$PLUGINSDIR" -ReportPath "$publicationReport"'
    ${Else}
  !endif
      nsExec::ExecToStack '"$PLUGINSDIR\7za.exe" x -y -bd -bso0 -bsp0 -bse1 "-o$publicationDirectory" "${FILE}"'
  !ifdef APP_64
    ${EndIf}
  !endif
  Pop $publicationResult
  Pop $publicationOutput
  StrCmp $publicationResult "0" 0 publication_failed

  SetDetailsPrint textonly
  DetailPrint "$(^CopyTo)$INSTDIR"
  SetDetailsPrint none
  StrCpy $publicationPhase "publish-new-program-files"
  StrCpy $publicationSource "publication-helper"
  !insertmacro runInstallPublication publish
  DetailPrint "Payload publication: $publicationResult $publicationOutput"
  StrCmp $publicationResult "0" 0 publication_failed
  StrCpy $R1 0
  publication_copy:
    StrCpy $publicationPhase "copy-new-program-files"
    StrCpy $publicationSource "robocopy"
    # Shell CopyFiles rejects long destination paths even when extraction succeeded. Robocopy
    # supports them without changing Windows policy. Copy data/attributes/times only, retaining
    # destination ACL inheritance and unrelated files (never mirror/purge or use backup mode).
    # Force same/tweaked/change-time-only files too: matching metadata does not prove the bytes.
    # The outer loop owns retries; quiet copies must not be killed by an inactivity timeout.
    nsExec::ExecToStack '"$SYSDIR\robocopy.exe" "$publicationDirectory" "$INSTDIR" /E /COPY:DAT /DCOPY:DA /IS /IT /IM /R:0 /W:0 /XJ /XX /NP /NJH /NJS /NFL /NDL /FP /UNICODE'
    Pop $publicationResult
    Pop $publicationOutput
    # Exact comparisons reject launch errors/timeouts as well as nonzero failure bits. Codes
    # 0..3 mean successful/no-op copying, possibly with extra destination files. Mismatches
    # (bit 4) are not acceptable for an application payload, even without the failure bit (8).
    StrCmp $publicationResult "0" publication_copied
    StrCmp $publicationResult "1" publication_copied
    StrCmp $publicationResult "2" publication_copied
    StrCmp $publicationResult "3" publication_copied publication_retry
  publication_copied:
    ClearErrors
    Call cleanupInstallPublication
    ${If} ${Errors}
      StrCpy $publicationPhase "cleanup-payload-staging"
      StrCpy $publicationSource "publication-helper"
      StrCpy $publicationResult $publicationCleanupResult
      StrCpy $publicationOutput $publicationCleanupOutput
      CopyFiles /SILENT "$publicationCleanupReport" "$publicationReport"
      Goto publication_failed
    ${EndIf}
    ${If} $publicationFailure == "1"
      # A user Retry succeeded: retain useful evidence with an explicit recovered result,
      # without a final error notice or an earlier log that still looks like a failed update.
      Push $0
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-diagnostics.ps1" -Action finalize -Outcome recovered -ReportPath "$publicationReport" -CleanupReportPath "$publicationCleanupReport" -CleanupExitCode "$publicationCleanupResult" -InstallPath "$INSTDIR" -Phase "$publicationPhase" -ExitCode 0 -AppVersion "${OPEN_SCIENCE_DIAGNOSTIC_VERSION}" -ProductName "${OPEN_SCIENCE_DIAGNOSTIC_PRODUCT}" -Language $LANGUAGE -LogDirectory "$installDiagnosticDirectory"'
      Pop $0
      Pop $0
      Pop $0
    ${EndIf}
    StrCpy $publicationFailure ""
    Goto publication_done

  publication_retry:
    IntOp $R1 $R1 + 1
    # Retain bounded upstream copy retries, but never replace a failed copy with unchecked
    # extraction into the live target. Already moved directories remain available for verification.
    ${if} $R1 < 5
      Sleep 1000
      Goto publication_copy
    ${endif}
    IfSilent publication_failed
    Call recordInstallPublicationFailure
    Call describeInstallPublicationFailure
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$publicationMessage" /SD IDCANCEL IDRETRY publication_copy
    StrCpy $publicationFailurePrompted "1"

  publication_failed:
    DetailPrint "Payload installation failed: $publicationResult $publicationOutput"
    Call recordInstallPublicationFailure
    !insertmacro quitFailedUpdate
  publication_done:
!macroend

!endif
