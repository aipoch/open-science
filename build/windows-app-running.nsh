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
# Re-checks for at most TIMEOUT ms of wall time instead of sleeping the full TIMEOUT: an update
# hands off after the application has already quit, so the fixed waits were usually idle. One
# inventory takes about 0.2 s, so the deadline uses GetTickCount rather than summed sleeps. Leaves
# the last find result in $R0, so callers keep electron-builder's decision after the same budget.
!macro openScienceWaitForInstallProcesses TIMEOUT
  !define _OSW_ID ${__LINE__}
  Push $R2
  Push $R3
  System::Call 'kernel32::GetTickCount()i.R2'
  IntOp $R2 $R2 + ${TIMEOUT}
  wait_${_OSW_ID}:
    !insertmacro openScienceInstallProcesses "$INSTDIR" find $R0
    ${if} $R0 != 1
      System::Call 'kernel32::GetTickCount()i.R3'
      IntOp $R3 $R2 - $R3
      ${if} $R3 > 0
        Sleep 50
        Goto wait_${_OSW_ID}
      ${endIf}
    ${endIf}
  Pop $R3
  Pop $R2
  !undef _OSW_ID
!macroend

!macro openScienceCheckAppRunning
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      # allow app to exit without explicit kill
      !insertmacro openScienceWaitForInstallProcesses 1300
    ${else}
      !insertmacro openScienceInstallProcesses "$INSTDIR" find $R0
    ${endIf}
    ${if} $R0 != 1
      ${if} ${isUpdated}
        Goto openScienceStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK openScienceStopProcess
      Quit

      openScienceStopProcess:

      DetailPrint "$(appClosing)"

      !insertmacro openScienceInstallProcesses "$INSTDIR" stop $R0
      # to ensure that files are not "in-use"; TerminateProcess returns before the exit completes
      !insertmacro openScienceWaitForInstallProcesses 300

      # Retry counter
      StrCpy $R1 0
      Goto openScienceStopChecked

      openScienceStopLoop:
        !insertmacro openScienceInstallProcesses "$INSTDIR" find $R0
      openScienceStopChecked:
        IntOp $R1 $R1 + 1
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
