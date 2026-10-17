param([Parameter(Mandatory)][string]$CandidateRoot, [Parameter(Mandatory)][string]$CurrentDirectory, [Parameter(Mandatory)][string]$PreviousDirectory, [Parameter(Mandatory)][string]$OutputDirectory, [switch]$EnvironmentOnly)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'This provisioning script is restricted to disposable GitHub-hosted Windows runners' }
$administrator = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $administrator) { throw 'Runner controller needs to create the isolated standard account' }
$name = 'pr3599-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$password = 'V9!' + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
Write-Output "::add-mask::$password"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$account = New-LocalUser -Name $name -Password $secure -Description 'Disposable PR 3599 upgrade validation' -AccountNeverExpires
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
$root = Join-Path $env:RUNNER_TEMP $name
New-Item -ItemType Directory -Path $root,$OutputDirectory -Force | Out-Null
& icacls.exe $env:GITHUB_WORKSPACE /grant "*$($account.SID.Value):(OI)(CI)RX" /Q
if ($LASTEXITCODE) { throw 'Could not grant read access to isolated checkout' }
& icacls.exe $root /grant "*$($account.SID.Value):(OI)(CI)M" /Q
if ($LASTEXITCODE) { throw 'Could not grant write access to isolated test directory' }
$config = @{candidateRoot=$CandidateRoot;currentDirectory=$CurrentDirectory;previousDirectory=$PreviousDirectory;root=$root;node=(Get-Command node.exe).Source;environmentOnly=[bool]$EnvironmentOnly}
$config | ConvertTo-Json | Set-Content (Join-Path $root 'run-config.json')
$childScript = Join-Path $root 'run-validation.ps1'
New-Item -ItemType Directory -Path (Join-Path $root 'evidence') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'product-local-mcp.cjs') -Destination (Join-Path $root 'evidence/product-local-mcp.cjs')
@'
$ErrorActionPreference = 'Stop'
$configuration = Get-Content (Join-Path $PSScriptRoot 'run-config.json') -Raw | ConvertFrom-Json
$evidence = Join-Path $PSScriptRoot 'evidence'
New-Item -ItemType Directory -Path $evidence,(Join-Path $PSScriptRoot 'temp') -Force | Out-Null
$env:TEMP = Join-Path $PSScriptRoot 'temp'
$env:TMP = $env:TEMP
$admin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$inheritedProfile = $env:USERPROFILE
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class UpgradeUserEnvironment {
  [DllImport("userenv.dll", SetLastError=true)] public static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr block);
  [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
}
"@
$block = [IntPtr]::Zero
if (-not [UpgradeUserEnvironment]::CreateEnvironmentBlock([ref]$block,[Security.Principal.WindowsIdentity]::GetCurrent().Token,$false)) { throw "CreateEnvironmentBlock failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$accountEnvironment = @{}
try {
  $cursor = $block
  while ($true) {
    $entry = [Runtime.InteropServices.Marshal]::PtrToStringUni($cursor)
    if (-not $entry) { break }
    $separator = $entry.IndexOf('=')
    if ($separator -gt 0) { $accountEnvironment[$entry.Substring(0,$separator)] = $entry.Substring($separator+1) }
    $cursor = [IntPtr]::Add($cursor,($entry.Length+1)*2)
  }
} finally { [void][UpgradeUserEnvironment]::DestroyEnvironmentBlock($block) }
$environmentEvidence = @{}
foreach ($key in @('USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','USERNAME','USERDOMAIN')) {
  $environmentEvidence[$key] = @{inherited=[Environment]::GetEnvironmentVariable($key);account=$accountEnvironment[$key]}
  if ($accountEnvironment.ContainsKey($key)) { [Environment]::SetEnvironmentVariable($key,$accountEnvironment[$key]) }
}
$environmentEvidence | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $evidence ('account-environment-' + $env:PR3599_ACCOUNT_ENV_READY + '.json'))
# Windows shell folder APIs may cache inherited paths before the script runs. Start a fresh
# same-user process with the environment obtained from Windows, before querying those APIs.
if ($env:PR3599_ACCOUNT_ENV_READY -ne '1') {
  $env:PR3599_ACCOUNT_ENV_READY = '1'
  & "$PSHOME\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath
  exit $LASTEXITCODE
}
$env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
$env:HOME = $env:USERPROFILE
$env:HOMEDRIVE = [IO.Path]::GetPathRoot($env:USERPROFILE).TrimEnd('\')
$env:HOMEPATH = $env:USERPROFILE.Substring($env:HOMEDRIVE.Length)
$env:APPDATA = [Environment]::GetFolderPath('ApplicationData', [Environment+SpecialFolderOption]::Create)
$env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData', [Environment+SpecialFolderOption]::Create)
$folderEvidence = @{}
foreach ($folder in @(@('Roaming','3EB685DB-65F9-4CF6-A03A-E3EF65729F3D'),@('Local','F1B32785-6FBA-4FCF-9D55-7B8E7F157091'))) {
  $id = [guid]$folder[1]
  $folderPath = [IntPtr]::Zero
  $hr = [UpgradeUserEnvironment]::SHGetKnownFolderPath([ref]$id,0x8000,[IntPtr]::Zero,[ref]$folderPath)
  try { $folderEvidence[$folder[0]] = @{hresult=$hr;path=[Runtime.InteropServices.Marshal]::PtrToStringUni($folderPath)} }
  finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($folderPath) }
}
$folderEvidence['userShellFolders'] = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction SilentlyContinue | Select-Object AppData,'Local AppData'
$folderEvidence | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $evidence 'known-folders.json')
if (-not $env:APPDATA -or -not $env:LOCALAPPDATA) { throw 'The isolated Windows account has no usable AppData known folders' }
foreach ($known in @($env:APPDATA,$env:LOCALAPPDATA)) {
  if (-not $known.StartsWith($env:USERPROFILE + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Known folder escaped the isolated account profile' }
}
if (-not $env:USERPROFILE -or $env:USERPROFILE -ne $accountEnvironment['USERPROFILE']) { throw 'The isolated account profile was not loaded separately' }
@{identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;isAdministrator=$admin;profile=$env:USERPROFILE;inheritedProfile=$inheritedProfile;appData=$env:APPDATA;localAppData=$env:LOCALAPPDATA;started=(Get-Date -Format o)} | ConvertTo-Json | Set-Content (Join-Path $evidence 'identity.json')
if ($admin) { throw 'Upgrade acceptance must run as an ordinary user' }
Add-Type -AssemblyName System.Security
$probeBytes = [Text.Encoding]::UTF8.GetBytes('pr3599-synthetic-dpapi-probe')
$encrypted = [Security.Cryptography.ProtectedData]::Protect($probeBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if ([Convert]::ToBase64String($decrypted) -ne [Convert]::ToBase64String($probeBytes)) { throw 'Ordinary-user DPAPI round trip failed' }
@{dpapiCurrentUserRoundTrip=$true;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json | Set-Content (Join-Path $evidence 'credential-environment.json')
if ($configuration.environmentOnly) { Write-Output 'Isolated ordinary-user known folders and DPAPI verified.'; exit 0 }
Set-Location $configuration.candidateRoot
$env:PR3599_EVIDENCE_DIR = $evidence
$env:TEMP = Join-Path $PSScriptRoot 'temp'
$env:TMP = $env:TEMP
$env:RUNNER_TEMP = $env:TEMP
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:ALL_PROXY = ''
$env:PSExecutionPolicyPreference = 'Bypass'
Remove-Item Env:NODE_OPTIONS,Env:ELECTRON_RUN_AS_NODE,Env:OPEN_SCIENCE_E2E_STORAGE_ROOT,Env:OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH,Env:GH_TOKEN,Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$arguments = @('scripts/pr3599-upgrade-certification.mjs','--current-dir',$configuration.currentDirectory,'--previous-dir',$configuration.previousDirectory,'--output',(Join-Path $evidence 'updater-observation.json'))
@{program=$configuration.node;arguments=$arguments;cwd=(Get-Location).Path;started=(Get-Date -Format o)} | ConvertTo-Json | Set-Content (Join-Path $evidence 'command.json')
$ErrorActionPreference = 'Continue'
& $configuration.node @arguments *> (Join-Path $evidence 'upgrade.log')
$result = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Set-Content (Join-Path $evidence 'upgrade.exit') $result
exit $result
'@ | Set-Content -LiteralPath $childScript
$credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
$process = $null
try {
  $process = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Credential $credential -LoadUserProfile -WorkingDirectory $root -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$childScript+'"')) -RedirectStandardOutput (Join-Path $root 'child.stdout.log') -RedirectStandardError (Join-Path $root 'child.stderr.log') -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddMinutes(30)
  $lastLine = ''
  while (-not $process.WaitForExit(5000)) {
    $log = Join-Path $root 'evidence/upgrade.log'
    if (Test-Path -LiteralPath $log) {
      $line = Get-Content -LiteralPath $log -Tail 1
      if ($line -and $line -ne $lastLine) { Write-Output ($line -replace '([?&]token=)[^\s&#]+','$1<redacted>'); $lastLine = $line }
    }
    if ((Get-Date) -gt $deadline) { throw 'Ordinary-user upgrade test exceeded its 30 minute deadline; do not count as normal exit' }
  }
  $process.Refresh()
  @{pid=$process.Id;exit=$process.ExitCode;ended=(Get-Date -Format o)} | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'controller-result.json')
  if ($process.ExitCode -ne 0) { throw "Upgrade validation failed with exit $($process.ExitCode)" }
} finally {
  $owned = @(Get-CimInstance Win32_Process | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
    if ($owner.User -eq $name) { @{pid=$_.ProcessId;parent=$_.ParentProcessId;path=$_.ExecutablePath;created=$_.CreationDate} }
  })
  @{account=$name;processes=$owned;forcedByController=$false;root=$root} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $OutputDirectory 'final-account-processes.json')
  $evidence = Join-Path $root 'evidence'
  if (Test-Path -LiteralPath $evidence) { Copy-Item -LiteralPath $evidence -Destination $OutputDirectory -Recurse }
  $logs = Join-Path $OutputDirectory 'product-logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.log' | ForEach-Object {
    $relative = $_.FullName.Substring($root.Length).TrimStart('\').Replace('\','__')
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $logs $relative)
  }
  Get-ChildItem -LiteralPath $root -Recurse -File | Select-Object FullName,Length,LastWriteTime | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $OutputDirectory 'retained-file-inventory.json')
  $accountProfile = Get-CimInstance Win32_UserProfile | Where-Object SID -eq $account.SID.Value
  if ($accountProfile -and (Test-Path -LiteralPath $accountProfile.LocalPath)) {
    $aclEvidence = foreach ($relative in @('','AppData','AppData\Local','AppData\Roaming')) {
      $target = if ($relative) { Join-Path $accountProfile.LocalPath $relative } else { $accountProfile.LocalPath }
      if (Test-Path -LiteralPath $target) { $acl = Get-Acl -LiteralPath $target; @{path=$target;owner=$acl.Owner;sddl=$acl.Sddl} }
    }
    $aclEvidence | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $OutputDirectory 'account-folder-permissions.json')
    Get-ChildItem -LiteralPath $accountProfile.LocalPath -Recurse -File -Force -Filter '*.log' -ErrorAction Continue | ForEach-Object {
      $relative = $_.FullName.Substring($accountProfile.LocalPath.Length).TrimStart('\').Replace('\','__')
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $logs ('account__' + $relative))
    }
    @{sid=$account.SID.Value;path=$accountProfile.LocalPath;loaded=$accountProfile.Loaded} | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'account-profile.json')
  }
  if ($owned.Count -eq 0) { Remove-LocalUser -Name $name }
  else { Write-Error "The isolated account still owns $($owned.Count) processes; evidence retained and VM recycling is forced cleanup, not acceptance" }
}
