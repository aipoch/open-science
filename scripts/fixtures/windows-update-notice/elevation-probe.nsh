# Test-only replacement for the external secure-desktop request. Keep NSIS's actual
# mode selection, initialization and cancellation handling; do not grant privileges.
!ifndef BUILD_UNINSTALLER
!include "UAC.nsh"
!macroundef UAC_RunElevated
!macro UAC_RunElevated
  FileOpen $R9 "$TEMP\elevation-requested" w
  FileWrite $R9 "requested"
  ${if} ${FileExists} "$INSTDIR\OpenScience\sentinel.txt"
    FileWrite $R9 " data-in-place"
  ${endif}
  FileClose $R9
  StrCpy $0 1223
  SetErrorLevel 1223
!macroend
!endif
