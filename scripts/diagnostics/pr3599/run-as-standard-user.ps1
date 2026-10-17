param([Parameter(Mandatory)][string]$CandidateRoot, [Parameter(Mandatory)][string]$CurrentDirectory, [Parameter(Mandatory)][string]$PreviousDirectory, [Parameter(Mandatory)][string]$OutputDirectory)
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
$config = @{candidateRoot=$CandidateRoot;currentDirectory=$CurrentDirectory;previousDirectory=$PreviousDirectory;root=$root;node=(Get-Command node.exe).Source}
$config | ConvertTo-Json | Set-Content (Join-Path $root 'run-config.json')
$childScript = Join-Path $root 'run-validation.ps1'
New-Item -ItemType Directory -Path (Join-Path $root 'evidence') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'product-local-mcp.cjs') -Destination (Join-Path $root 'evidence/product-local-mcp.cjs')
@'
$ErrorActionPreference = 'Stop'
$configuration = Get-Content (Join-Path $PSScriptRoot 'run-config.json') -Raw | ConvertFrom-Json
$evidence = Join-Path $PSScriptRoot 'evidence'
New-Item -ItemType Directory -Path $evidence,(Join-Path $PSScriptRoot 'temp') -Force | Out-Null
$admin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
@{identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;isAdministrator=$admin;profile=$env:USERPROFILE;started=(Get-Date -Format o)} | ConvertTo-Json | Set-Content (Join-Path $evidence 'identity.json')
if ($admin) { throw 'Upgrade acceptance must run as an ordinary user' }
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
Remove-Item Env:NODE_OPTIONS,Env:ELECTRON_RUN_AS_NODE,Env:OPEN_SCIENCE_E2E_STORAGE_ROOT,Env:GH_TOKEN,Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$arguments = @('scripts/pr3599-upgrade-certification.mjs','--current-dir',$configuration.currentDirectory,'--previous-dir',$configuration.previousDirectory,'--output',(Join-Path $evidence 'updater-observation.json'))
@{program=$configuration.node;arguments=$arguments;cwd=(Get-Location).Path;started=(Get-Date -Format o)} | ConvertTo-Json | Set-Content (Join-Path $evidence 'command.json')
& $configuration.node @arguments *> (Join-Path $evidence 'upgrade.log')
$result = $LASTEXITCODE
Set-Content (Join-Path $evidence 'upgrade.exit') $result
exit $result
'@ | Set-Content -LiteralPath $childScript
$credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
$process = $null
try {
  $process = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Credential $credential -LoadUserProfile -WorkingDirectory $root -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$childScript+'"')) -PassThru -WindowStyle Hidden
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
  if ($owned.Count -eq 0) { Remove-LocalUser -Name $name }
  else { Write-Error "The isolated account still owns $($owned.Count) processes; evidence retained and VM recycling is forced cleanup, not acceptance" }
}
