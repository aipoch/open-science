!include "${__FILEDIR__}\windows-install-processes.nsh"
# Defining the hook makes electron-builder skip these declarations. GetProcessInfo still guards an
# installer that shares the application's executable name.
!include getProcessInfo.nsh
Var pid

# electron-builder's _CHECK_APP_RUNNING flow (prompt, update-mode waits, graceful then forced stop,
# and the "cannot be closed" retry), with the PowerShell process queries replaced by the in-process
# openScienceInstallProcesses check. Every Stop-Process call there terminated the process, so
# both stop passes terminate here as well. An unavailable inventory counts as running: files are
# never removed on an unverified process list.
!macro openScienceCheckAppRunning
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      # allow app to exit without explicit kill
      Sleep 300
    ${endIf}

    !insertmacro openScienceInstallProcesses "$INSTDIR" find $R0
    ${if} $R0 != 1
      ${if} ${isUpdated}
        # allow app to exit without explicit kill
        Sleep 1000
        Goto openScienceStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK openScienceStopProcess
      Quit

      openScienceStopProcess:

      DetailPrint "$(appClosing)"

      !insertmacro openScienceInstallProcesses "$INSTDIR" stop $R0
      # to ensure that files are not "in-use"
      Sleep 300

      # Retry counter
      StrCpy $R1 0

      openScienceStopLoop:
        IntOp $R1 $R1 + 1

        !insertmacro openScienceInstallProcesses "$INSTDIR" find $R0
        ${if} $R0 != 1
          # wait to give a chance to exit gracefully
          Sleep 1000
          !insertmacro openScienceInstallProcesses "$INSTDIR" stop $R0
          !insertmacro openScienceInstallProcesses "$INSTDIR" find $R0
          ${if} $R0 != 1
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto openScienceNotRunning
          ${endIf}
        ${else}
          Goto openScienceNotRunning
        ${endIf}

        # App likely running with elevated permissions.
        # Ask user to close it manually
        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY openScienceStopLoop
          Quit
        ${else}
          Goto openScienceStopLoop
        ${endIf}
      openScienceNotRunning:
    ${endIf}
  ${endIf}
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    # Silent uninstall checks processes before customUnInit. Acquire the installer lock before
    # the check can terminate an application launched by a competing update.
    !insertmacro checkManualUninstallCoordination
  !endif
  !insertmacro openScienceCheckAppRunning
!macroend
