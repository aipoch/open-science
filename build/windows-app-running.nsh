# Never call the upstream CIM/name fallback: only this installation grants close authority.
!macro installationProcessCheckFailed
  !ifmacrodef quitFailedUpdate
    !insertmacro quitFailedUpdate
  !else
    SetErrorLevel 2
    Quit
  !endif
!macroend

!macro extractInstallationProcessHelper
  InitPluginsDir
  !ifdef APP_64
    File /oname=$PLUGINSDIR\windows-installation-processes.exe "${PROJECT_DIR}\out\windows-installer\x64\windows-installation-processes.exe"
  !else ifdef APP_ARM64
    File /oname=$PLUGINSDIR\windows-installation-processes.exe "${PROJECT_DIR}\out\windows-installer\arm64\windows-installation-processes.exe"
  !else
    File /oname=$PLUGINSDIR\windows-installation-processes.exe "${PROJECT_DIR}\out\windows-installer\ia32\windows-installation-processes.exe"
  !endif
!macroend

!macro customCheckAppRunning
  !insertmacro extractInstallationProcessHelper
  ${If} ${FileExists} "$INSTDIR\*.*"
    nsExec::ExecToStack /TIMEOUT=20000 '"$PLUGINSDIR\windows-installation-processes.exe" check "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      ${If} $0 != "3"
        DetailPrint "Installation occupancy check failed: $0 $1"
        !insertmacro installationProcessCheckFailed
      ${EndIf}
      ${IfNot} ${isUpdated}
      ${AndIfNot} ${Silent}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" IDOK +3
        SetErrorLevel 2
        Quit
      ${EndIf}
      # One shared normal-close deadline, then termination through the same verified handles.
      nsExec::ExecToStack /TIMEOUT=25000 '"$PLUGINSDIR\windows-installation-processes.exe" close "$INSTDIR" "" 10000'
      Pop $0
      Pop $1
      ${If} $0 != "0"
        DetailPrint "Installation close failed: $0 $1"
        !insertmacro installationProcessCheckFailed
      ${EndIf}
      # Foreign executable file users remain occupants and never become termination targets.
      nsExec::ExecToStack /TIMEOUT=20000 '"$PLUGINSDIR\windows-installation-processes.exe" check "$INSTDIR"'
      Pop $0
      Pop $1
      ${If} $0 != "0"
        DetailPrint "Installation occupancy remains: $0 $1"
        !insertmacro installationProcessCheckFailed
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
