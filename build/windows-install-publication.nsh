!ifndef OPEN_SCIENCE_INSTALL_PUBLICATION_INCLUDED
!define OPEN_SCIENCE_INSTALL_PUBLICATION_INCLUDED
!include x64.nsh

Var publicationDirectory
Var publicationState
Var publicationResult
Var publicationOutput

!macro runInstallPublication ACTION
  nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-install-publication.ps1" -Action ${ACTION} -InstallPath "$INSTDIR" -StatePath "$publicationState"'
  Pop $publicationResult
  Pop $publicationOutput
!macroend

  Function cleanupInstallPublication
    StrCmp $publicationState "" cleanupInstallPublication_done
    IfFileExists "$publicationState" 0 cleanupInstallPublication_done
    !insertmacro runInstallPublication cleanup
    DetailPrint "Payload cleanup: $publicationResult $publicationOutput"
    StrCmp $publicationResult "0" 0 cleanupInstallPublication_failed
    StrCpy $publicationState ""
    StrCpy $publicationDirectory ""
    Goto cleanupInstallPublication_done
    cleanupInstallPublication_failed:
      SetErrors
    cleanupInstallPublication_done:
  FunctionEnd

!macro customExtractAppPackage FILE
  File /oname=$PLUGINSDIR\windows-install-publication.ps1 "${BUILD_RESOURCES_DIR}\windows-install-publication.ps1"
  StrCpy $publicationState "$PLUGINSDIR\publication-state.json"
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
  SetDetailsPrint textonly
  DetailPrint "$(^Extract)Open-Science"
  SetDetailsPrint none
  # Nsis7z discards extraction errors. The CLI reports CRC, incomplete archive, write and
  # cancellation errors. Only exit 0 permits publication; a warning is not success.
  # nsExec hides the console and waits for exit. Its optional timeout is output inactivity,
  # not a work budget, so do not kill a valid large extraction merely because it is quiet.
  nsExec::ExecToStack '"$PLUGINSDIR\7za.exe" x -y -bd -bso0 -bsp0 -bse1 "-o$publicationDirectory" "${FILE}"'
  Pop $publicationResult
  Pop $publicationOutput
  StrCmp $publicationResult "0" 0 publication_failed

  SetDetailsPrint textonly
  DetailPrint "$(^CopyTo)$INSTDIR"
  SetDetailsPrint none
  !insertmacro runInstallPublication publish
  DetailPrint "Payload publication: $publicationResult $publicationOutput"
  StrCmp $publicationResult "0" 0 publication_failed
  StrCpy $R1 0
  publication_copy:
    ClearErrors
    CopyFiles /SILENT "$publicationDirectory\*" "$INSTDIR"
    IfErrors publication_retry
    ClearErrors
    Call cleanupInstallPublication
    IfErrors publication_failed
    Goto publication_done

  publication_retry:
    StrCpy $publicationResult "copy-failed"
    StrCpy $publicationOutput "NSIS CopyFiles could not replace the remaining application files."
    IntOp $R1 $R1 + 1
    # Retain bounded upstream copy retries, but never replace a failed copy with unchecked
    # extraction into the live target. Already moved directories remain available for verification.
    ${if} $R1 < 5
      Sleep 1000
      Goto publication_copy
    ${endif}
    IfSilent publication_failed
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY publication_copy

  publication_failed:
    DetailPrint "Payload installation failed: $publicationResult $publicationOutput"
    !insertmacro quitFailedUpdate
  publication_done:
!macroend

!endif
