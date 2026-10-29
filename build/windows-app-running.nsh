!ifndef BUILD_UNINSTALLER
!include x64.nsh
# Defining the hook makes electron-builder skip these declarations. Its unchanged
# _CHECK_APP_RUNNING macro still needs them, including the PID used by its fallback.
!include getProcessInfo.nsh
Var pid

!macro customCheckAppRunning
  # CHECK_APP_RUNNING has already selected its default host. Avoid WOW64 redirection
  # on native AMD64 only; keep that default on other architectures or a missing alias.
  ${If} ${IsNativeAMD64}
    IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
      StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
!endif
