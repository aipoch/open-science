# Exercise elevated target selection without granting OS privileges. Redirect only
# this fixture process's HKLM reads to its dedicated HKCU test hive before initMultiUser.
!ifndef BUILD_UNINSTALLER
!include "UAC.nsh"
!undef UAC_IsAdmin
!define UAC_IsAdmin `1 == 1`
!macro preInit
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "Software\11f7eae6-e7e3-4c1c-931f-2a9b1df095ea-machine-hive", i 0, i 0x20119, *p .R8) i .R0'
  ${if} $R0 != 0
    IntOp $R0 $R0 + 1000
    SetErrorLevel $R0
    Quit
  ${endif}
  System::Call 'advapi32::RegOverridePredefKey(p 0x80000002, p R8) i .R0'
  System::Call 'advapi32::RegCloseKey(p R8)'
  ${if} $R0 != 0
    IntOp $R0 $R0 + 2000
    SetErrorLevel $R0
    Quit
  ${endif}
!macroend
!endif
