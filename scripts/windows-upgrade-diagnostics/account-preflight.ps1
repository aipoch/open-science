param([Parameter(Mandatory)][string]$EvidenceDirectory,[ValidateSet('basic','wininet')][string]$Probe='basic',[Parameter(Mandatory)][string]$Node)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Probe must be an ordinary user' }
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
function Save-Phase([string]$Phase) {
  $processes=@(Get-CimInstance Win32_Process -Filter "Name='dllhost.exe'" | ForEach-Object {
    $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($owner.Sid -eq $identity.User.Value) { @{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate;path=$_.ExecutablePath;commandLine=$_.CommandLine} }
  })
  @{phase=$Phase;at=[DateTime]::UtcNow.ToString('o');processes=$processes} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $EvidenceDirectory ($Phase+'.json'))
}
Save-Phase 'before-known-folders'
$profile=[Environment]::GetFolderPath('UserProfile')
$folders=@{}
foreach ($key in @('ApplicationData','LocalApplicationData')) {
  $path=[Environment]::GetFolderPath($key,[Environment+SpecialFolderOption]::Create)
  if (-not $path.StartsWith($profile+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Known folder escaped isolated account' }
  $folders[$key]=$path
}
if ($profile -ne $env:USERPROFILE) { throw 'Profile environment and actual Windows profile disagree' }
@{identity=$identity.Name;sid=$identity.User.Value;profile=$profile;folders=$folders;administrator=$false;inheritedInventory=$env:OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $EvidenceDirectory 'identity.json')
if ($env:OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH) { throw 'Inherited credential inventory reached isolated process' }
Save-Phase 'after-known-folders'
$signature=Get-AuthenticodeSignature -LiteralPath $Node
if ($signature.Status -ne 'Valid') { throw 'Ordinary account cannot verify Node signature' }
Save-Phase 'after-signature'
Add-Type -AssemblyName System.Security
$bytes=[Text.Encoding]::UTF8.GetBytes('synthetic-upgrade-preflight')
$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if ([Convert]::ToBase64String($plain) -ne [Convert]::ToBase64String($bytes)) { throw 'DPAPI round trip failed' }
Save-Phase 'after-dpapi'
if ($Probe -eq 'wininet') {
  # Query-only reproduction. No proxy, certificate, service, or security mutation.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinInetProbe {
  [DllImport("wininet.dll", SetLastError=true)] static extern bool InternetQueryOptionW(IntPtr handle,uint option,IntPtr buffer,ref uint length);
  public static void Query() {
    uint length=0;
    if(InternetQueryOptionW(IntPtr.Zero,38,IntPtr.Zero,ref length) || Marshal.GetLastWin32Error()!=122) throw new Exception("Unexpected proxy query size result");
    var buffer=Marshal.AllocHGlobal((int)length);
    try { if(!InternetQueryOptionW(IntPtr.Zero,38,buffer,ref length)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
  [WinInetProbe]::Query()
  Save-Phase 'after-wininet'
}
@{status='PASS';dpapi=$true;signature=$signature.Status.ToString();probe=$Probe} | ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory 'result.json')
