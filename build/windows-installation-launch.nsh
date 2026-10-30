# The ordinary shortcut reuses a versioned copy of this signed NSIS package outside the
# replaceable installation. Its early branch never enters installer initialization or registers
# another product. The existing NSIS install path remains the only package writer.
Var persistentLaunchRoot
Var persistentLaunchApp
Var persistentLaunchSetup
Var persistentLaunchArguments
Var persistentLaunchOperation
Var persistentLaunchInstaller
Var persistentLaunchRequest
Var persistentLaunchDigest
Var persistentLaunchRequestDigest
Var persistentLaunchHandle
Var persistentLaunchWaitStarted
Var persistentLaunchUrl
Var persistentLaunchSha256
Var persistentLaunchDownload
Var persistentLaunchRecoveryMutex
Var persistentLaunchDownloadAttempted
Var persistentLaunchDownloadStarted

# nsExec decodes console bytes using the system codepage. Return only an ASCII selector/hash;
# construct Unicode known-folder paths inside NSIS so non-ASCII Windows usernames survive.
!macro readPersistentLaunchDirectory ROOT
  nsExec::ExecToStack /TIMEOUT=10000 '"$PLUGINSDIR\windows-installation-processes.exe" recovery-location "${ROOT}" "$APPDATA"'
  Pop $R0
  Pop $R1
  ${If} $R0 == "0"
    StrLen $R3 $R1
    ${If} $R3 != 66
      StrCpy $R0 "invalid-location"
    ${Else}
      StrCpy $R3 $R1 2
      StrCpy $R1 $R1 "" 2
      ${If} $R3 == "0|"
        StrCpy $R1 "$APPDATA\Open-Science\UpdateHandoffs\Installations\$R1"
      ${ElseIf} $R3 == "1|"
        StrCpy $R1 "$APPDATA\Open-Science-UpdateHandoffs\Installations\$R1"
      ${Else}
        StrCpy $R0 "invalid-location"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro preInit
  ${GetParameters} $persistentLaunchArguments
  StrLen $R0 "--open-science-launch"
  StrCpy $R1 $persistentLaunchArguments $R0
  ${If} $R1 == "--open-science-launch"
    StrCpy $R1 $persistentLaunchArguments 1 $R0
    ${If} $R1 == ""
    ${OrIf} $R1 == " "
      # Mutable recovery authorization belongs to the current user's token. Never turn an
      # elevated invocation of the ordinary shortcut into an elevated metadata interpreter.
      System::Call 'shell32::IsUserAnAdmin() i.R0'
      ${If} $R0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Start Open-Science from your normal Windows session, without Run as administrator."
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrLen $R0 "--open-science-launch"
      StrCpy $persistentLaunchArguments $persistentLaunchArguments "" $R0
      Call openSciencePersistentLaunch
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro definePersistentLaunchFunctions
Function openSciencePersistentLaunch
  SetSilent silent
  System::Call 'kernel32::GetTickCount() i.R0'
  StrCpy $persistentLaunchWaitStarted $R0
  SetShellVarContext current
  StrCpy $persistentLaunchRoot "$EXEDIR"
  StrCpy $persistentLaunchRecoveryMutex 0
  StrCpy $persistentLaunchDownloadAttempted 0
  ReadINIStr $persistentLaunchApp "$persistentLaunchRoot\launch.ini" "installation" "applicationPath"
  StrCmp $persistentLaunchApp "" persistentLaunch_invalid
  ${GetParent} "$persistentLaunchApp" $R2
  ${GetFileName} "$persistentLaunchApp" $R3
  StrCmp $R3 "${APP_EXECUTABLE_FILENAME}" 0 persistentLaunch_invalid
  !insertmacro extractInstallationProcessHelper
  !insertmacro readPersistentLaunchDirectory $R2
  StrCmp $R0 "0" 0 persistentLaunch_invalid
  StrCmp $R1 $persistentLaunchRoot 0 persistentLaunch_invalid
  IfFileExists "$persistentLaunchRoot\update.ini" persistentLaunch_recover persistentLaunch_normal

  persistentLaunch_recover:
    ReadINIStr $R0 "$persistentLaunchRoot\update.ini" "update" "applicationPath"
    StrCmp $R0 $persistentLaunchApp 0 persistentLaunch_invalid
    ReadINIStr $persistentLaunchOperation "$persistentLaunchRoot\update.ini" "update" "operationId"
    StrLen $R0 $persistentLaunchOperation
    StrCmp $R0 36 0 persistentLaunch_invalid
    StrCpy $R0 0
    persistentLaunch_uuid:
      StrCpy $R1 $persistentLaunchOperation 1 $R0
      ${If} $R0 == 8
      ${OrIf} $R0 == 13
      ${OrIf} $R0 == 18
      ${OrIf} $R0 == 23
        StrCmp $R1 "-" persistentLaunch_uuidNext persistentLaunch_invalid
      ${EndIf}
      StrCpy $R2 0
      persistentLaunch_hex:
        StrCpy $R3 "0123456789abcdef" 1 $R2
        StrCmp $R1 $R3 persistentLaunch_uuidNext
        IntOp $R2 $R2 + 1
        IntCmp $R2 16 persistentLaunch_invalid persistentLaunch_hex persistentLaunch_invalid
      persistentLaunch_uuidNext:
        IntOp $R0 $R0 + 1
        IntCmp $R0 36 persistentLaunch_uuidDone persistentLaunch_uuid persistentLaunch_invalid
    persistentLaunch_uuidDone:
    # Serialize ordinary recovery entries for this operation. The early branch quits immediately
    # after this function, so Windows releases the retained mutex on every return/error path.
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "OpenScienceRecovery-$persistentLaunchOperation") p.r0'
    StrCpy $persistentLaunchRecoveryMutex $0
    StrCmp $persistentLaunchRecoveryMutex 0 persistentLaunch_invalid
    System::Call 'kernel32::GetTickCount() i.R0'
    IntOp $R0 $R0 - $persistentLaunchWaitStarted
    IntOp $R0 120000 - $R0
    ${If} $R0 <= 0
      Goto persistentLaunch_writerTimeout
    ${EndIf}
    System::Call 'kernel32::WaitForSingleObject(p $persistentLaunchRecoveryMutex, i R0) i.R0'
    ${If} $R0 != 0
    ${AndIf} $R0 != 128
      Goto persistentLaunch_writerTimeout
    ${EndIf}
    # The preceding entry may have completed or admitted another operation while this one
    # waited. Do not interpret its new index against the operation observed before the wait.
    IfFileExists "$persistentLaunchRoot\update.ini" 0 persistentLaunch_normal
    ReadINIStr $R0 "$persistentLaunchRoot\update.ini" "update" "operationId"
    StrCmp $R0 $persistentLaunchOperation persistentLaunch_mutexCurrent
    System::Call 'kernel32::ReleaseMutex(p $persistentLaunchRecoveryMutex)'
    System::Call 'kernel32::CloseHandle(p $persistentLaunchRecoveryMutex)'
    StrCpy $persistentLaunchDownloadAttempted 0
    Goto persistentLaunch_recover
    persistentLaunch_mutexCurrent:
    ReadINIStr $persistentLaunchInstaller "$persistentLaunchRoot\update.ini" "update" "installerPath"
    ReadINIStr $persistentLaunchRequest "$persistentLaunchRoot\update.ini" "update" "requestPath"
    ReadINIStr $persistentLaunchDigest "$persistentLaunchRoot\update.ini" "update" "sha512Hex"
    ReadINIStr $persistentLaunchRequestDigest "$persistentLaunchRoot\update.ini" "update" "requestSha256"
    # Restrict recovery to the original operation's two fixed files, outside the installation.
    # GetFullPathName can return empty for a missing leaf. Derive from the already verified
    # persistent directory so deleted cache bytes remain eligible for authorized re-download.
    ${GetParent} "$persistentLaunchRoot" $R2
    ${GetParent} "$R2" $R2
    StrCpy $R2 "$R2\$persistentLaunchOperation\installer.exe"
    StrCmp $persistentLaunchInstaller $R2 0 persistentLaunch_invalid
    ${GetParent} "$persistentLaunchRoot" $R2
    ${GetParent} "$R2" $R2
    StrCpy $R2 "$R2\$persistentLaunchOperation\bound-request.json"
    StrCmp $persistentLaunchRequest $R2 0 persistentLaunch_invalid
    StrLen $R0 $persistentLaunchDigest
    StrCmp $R0 128 0 persistentLaunch_invalid
    StrLen $R0 $persistentLaunchRequestDigest
    StrCmp $R0 64 0 persistentLaunch_invalid
    ${StdUtils.HashFile} $R0 "SHA2-256" "$persistentLaunchRequest"
    StrCmp $R0 $persistentLaunchRequestDigest 0 persistentLaunch_invalid
    StrCpy $persistentLaunchHandle 0
    persistentLaunch_waitWriter:
    System::Call 'kernel32::GetTickCount() i.R0'
    IntOp $R0 $R0 - $persistentLaunchWaitStarted
    IntOp $R0 120000 - $R0
    ${If} $R0 <= 0
      Goto persistentLaunch_writerTimeout
    ${EndIf}
    ${If} $R0 > 10000
      StrCpy $R0 10000
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=$R0 '"$PLUGINSDIR\windows-installation-processes.exe" writer-active "${APP_GUID}"'
    Pop $R0
    Pop $R1
    StrCmp $R0 "0" 0 persistentLaunch_closeInvalid
    StrCpy $R2 $R1 15
    StrCmp $R2 '{"active":true}' persistentLaunch_existingWriter
    StrCpy $R2 $R1 16
    StrCmp $R2 '{"active":false}' 0 persistentLaunch_closeInvalid
    # Another operation may have completed or replaced this one while a different installation
    # held the product-wide installer mutex. Never resume the stale snapshot over a newer target.
    IfFileExists "$persistentLaunchRoot\update.ini" 0 persistentLaunch_operationCompleted
    ReadINIStr $R0 "$persistentLaunchRoot\update.ini" "update" "operationId"
    StrCmp $R0 $persistentLaunchOperation persistentLaunch_writerReleased
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    System::Call 'kernel32::ReleaseMutex(p $persistentLaunchRecoveryMutex)'
    System::Call 'kernel32::CloseHandle(p $persistentLaunchRecoveryMutex)'
    StrCpy $persistentLaunchDownloadAttempted 0
    Goto persistentLaunch_recover
    persistentLaunch_writerReleased:
    ${GetParent} "$persistentLaunchRequest" $R2
    # Ready permits package cleanup. A failed index deletion must not reinstall a completed target.
    nsExec::ExecToStack /TIMEOUT=10000 '"$PLUGINSDIR\windows-installation-processes.exe" successor-ready "$R2" "$persistentLaunchApp"'
    Pop $R0
    Pop $R1
    StrCmp $R0 "0" 0 persistentLaunch_invalid
    StrCmp $R1 '{"active":true}' persistentLaunch_normal
    StrCmp $R1 '{"active":false}' 0 persistentLaunch_invalid
    nsExec::ExecToStack /TIMEOUT=10000 '"$PLUGINSDIR\windows-installation-processes.exe" successor-active "$R2" "$persistentLaunchApp"'
    Pop $R0
    Pop $R1
    StrCmp $R0 "0" 0 persistentLaunch_closeInvalid
    StrCmp $R1 '{"active":true}' persistentLaunch_joinSuccessor
    StrCmp $R1 '{"active":false}' 0 persistentLaunch_closeInvalid
    # A live successor is joined before requiring its cache; only an actual repair needs bytes.
    System::Call 'kernel32::CreateFileW(w "$persistentLaunchInstaller", i 0x80000000, i 1, p 0, i 3, i 0x80, p 0) p.r0'
    StrCpy $persistentLaunchHandle $0
    StrCmp $persistentLaunchHandle -1 persistentLaunch_download
    ${StdUtils.HashFile} $R0 "SHA2-512" "$persistentLaunchInstaller"
    StrCmp $R0 $persistentLaunchDigest persistentLaunch_execute
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    persistentLaunch_download:
    StrCpy $persistentLaunchHandle 0
    StrCmp $persistentLaunchDownloadAttempted 1 persistentLaunch_invalid
    StrCpy $persistentLaunchDownloadAttempted 1
    # Only the original bound HTTP(S) URL may initiate a request. INI hashes alone do not bind
    # its fields to the immutable JSON; the adapter checks the raw hash and field equality.
    nsExec::ExecToStack /TIMEOUT=10000 '"$PLUGINSDIR\windows-installation-processes.exe" recovery-request "$persistentLaunchRequest" "$persistentLaunchRoot\update.ini"'
    Pop $R0
    Pop $R1
    StrCmp $R0 "0" 0 persistentLaunch_invalid
    ReadINIStr $persistentLaunchUrl "$persistentLaunchRoot\update.ini" "update" "installerUrl"
    ReadINIStr $persistentLaunchSha256 "$persistentLaunchRoot\update.ini" "update" "installerSha256"
    ${GetParent} "$persistentLaunchInstaller" $R2
    StrCpy $persistentLaunchDownload "$R2\installer-recovery.exe"
    # One bounded attempt, with normal TLS verification and redirect support from INetC.
    System::Call 'kernel32::GetTickCount() i.R0'
    StrCpy $persistentLaunchDownloadStarted $R0
    inetc::get /SILENT /NOCOOKIES /CONNECTTIMEOUT 30 /RECEIVETIMEOUT 30 "$persistentLaunchUrl" "$persistentLaunchDownload" /END
    Pop $R0
    StrCmp $R0 "OK" 0 persistentLaunch_invalid
    System::Call 'kernel32::GetTickCount() i.R0'
    IntOp $R0 $R0 - $persistentLaunchDownloadStarted
    IntOp $persistentLaunchWaitStarted $persistentLaunchWaitStarted + $R0
    ${StdUtils.HashFile} $R0 "SHA2-256" "$persistentLaunchDownload"
    StrCmp $R0 $persistentLaunchSha256 0 persistentLaunch_invalid
    ${StdUtils.HashFile} $R0 "SHA2-512" "$persistentLaunchDownload"
    StrCmp $R0 $persistentLaunchDigest 0 persistentLaunch_invalid
    System::Call 'kernel32::MoveFileExW(w "$persistentLaunchDownload", w "$persistentLaunchInstaller", i 9) i.r0'
    StrCmp $0 0 persistentLaunch_invalid
    # Download may outlive another writer or operation. Re-observe before opening the final
    # verified package without write/delete sharing; never install the pre-download snapshot.
    Goto persistentLaunch_waitWriter
    persistentLaunch_execute:
    ClearErrors
    # NSIS re-acquires its own mutex, closing the observation-to-launch race without a second writer.
    ${GetParent} "$persistentLaunchApp" $R2
    # NSIS /D must be the final, unquoted argument; it consumes the remaining path verbatim.
    # Registry discovery may point at another installation and must not choose this operation's target.
    ExecWait '"$persistentLaunchInstaller" /S --updated --force-run --open-science-update-operation=$persistentLaunchOperation /D=$R2' $R0
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    ${If} ${Errors}
      Goto persistentLaunch_invalid
    ${EndIf}
    SetErrorLevel $R0
    Return
  persistentLaunch_joinSuccessor:
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    Exec '"$persistentLaunchApp" --updated --open-science-update-operation=$persistentLaunchOperation $persistentLaunchArguments'
    ${If} ${Errors}
      Goto persistentLaunch_invalid
    ${EndIf}
    Return
  persistentLaunch_existingWriter:
    Sleep 250
    Goto persistentLaunch_waitWriter
  persistentLaunch_writerTimeout:
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    MessageBox MB_OK|MB_ICONSTOP "Another Open-Science installation is still updating. Wait for that update to finish, then start Open-Science again."
    SetErrorLevel 2
    Return
  persistentLaunch_operationCompleted:
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    Goto persistentLaunch_normal
  persistentLaunch_closeInvalid:
    System::Call 'kernel32::CloseHandle(p $persistentLaunchHandle)'
    Goto persistentLaunch_invalid
  persistentLaunch_normal:
    ClearErrors
    Exec '"$persistentLaunchApp" $persistentLaunchArguments'
    ${IfNot} ${Errors}
      Return
    ${EndIf}
  persistentLaunch_invalid:
    MessageBox MB_OK|MB_ICONSTOP "Open-Science could not start or resume its update. The verified installation or update files are unavailable or changed."
    SetErrorLevel 2
FunctionEnd

Function installPersistentLaunch
  SetShellVarContext current
  !insertmacro extractInstallationProcessHelper
  !insertmacro readPersistentLaunchDirectory $INSTDIR
  StrCpy $persistentLaunchRoot $R1
  StrCmp $R0 "0" 0 installPersistentLaunch_failed
  CreateDirectory "$persistentLaunchRoot"
  ${StdUtils.HashFile} $R0 "SHA2-256" "$EXEPATH"
  StrLen $R1 $R0
  StrCmp $R1 64 0 installPersistentLaunch_failed
  StrCpy $persistentLaunchSetup "$persistentLaunchRoot\setup-$R0.exe"
  StrCmp $EXEPATH $persistentLaunchSetup installPersistentLaunch_copied
  IfFileExists "$persistentLaunchSetup" 0 installPersistentLaunch_copy
  ${StdUtils.HashFile} $R1 "SHA2-256" "$persistentLaunchSetup"
  StrCmp $R0 $R1 installPersistentLaunch_copied
  installPersistentLaunch_copy:
  ClearErrors
  CopyFiles /SILENT "$EXEPATH" "$persistentLaunchSetup"
  ${If} ${Errors}
    Goto installPersistentLaunch_failed
  ${EndIf}
  installPersistentLaunch_copied:
  ClearErrors
  # Win32 INI APIs require UTF-16LE BOM for non-ASCII profile and installation paths.
  FileOpen $R0 "$persistentLaunchRoot\launch.ini.tmp" w
  FileWriteWord $R0 0xFEFF
  FileWriteUTF16LE $R0 "[installation]$\r$\napplicationPath=$INSTDIR\${APP_EXECUTABLE_FILENAME}$\r$\nlauncherPath=$persistentLaunchSetup$\r$\n"
  System::Call 'kernel32::FlushFileBuffers(p R0)'
  FileClose $R0
  ${If} ${Errors}
    Goto installPersistentLaunch_failed
  ${EndIf}
  System::Call 'kernel32::MoveFileExW(w "$persistentLaunchRoot\launch.ini.tmp", w "$persistentLaunchRoot\launch.ini", i 9) i.r0'
  StrCmp $0 0 installPersistentLaunch_failed
  # Preserve the user's shortcut choices. The current installation's automatic launch stays
  # direct, so its pending update is not recursively reinstalled before the app acknowledges ready.
  ${If} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$persistentLaunchSetup" "--open-science-launch" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ${EndIf}
  ${If} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$persistentLaunchSetup" "--open-science-launch" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ${EndIf}
  StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  Return
  installPersistentLaunch_failed:
    DetailPrint "Could not preserve the verified ordinary launch entry."
    !insertmacro quitFailedUpdate
FunctionEnd
!macroend
