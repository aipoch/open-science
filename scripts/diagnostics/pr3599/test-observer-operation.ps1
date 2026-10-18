param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'observe-handoff.ps1'))
$match = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $match.Success) { throw 'Observer source missing' }
Add-Type -TypeDefinition $match.Groups[1].Value -ReferencedAssemblies 'System.Web.Extensions'
$operation = 'd4b596b1-9356-498c-a1a0-b4c906117c82'
$root = 'C:\synthetic\UpdateHandoffs'
$helper = Join-Path $root "$operation\helper.exe"
$application = 'C:\synthetic\app\open-science.exe'
$installer = 'C:\synthetic\pending\setup.exe'
$request = @{schema=1;operationId=$operation;parentPid=100;helperPid=101;applicationPath=$application;installerPath=$installer}
$records = @()
function Check([string]$Name, [bool]$Expected, [hashtable]$Value, [string]$Path=$helper) {
  $actual = [HandoffObserver]::MatchesOperation(($Value | ConvertTo-Json -Compress),$Path,$root,100,101,$application,$installer)
  if ($actual -ne $Expected) { throw "Unexpected identity result: $Name" }
  $script:records += @{name=$Name;matched=$actual;expected=$Expected}
}
Check 'exact operation identity' $true $request
foreach ($entry in @(@('operationId',[guid]::NewGuid().ToString()),@('parentPid',99),@('helperPid',102),@('applicationPath','C:\other\open-science.exe'),@('installerPath','C:\other\setup.exe'),@('schema',2))) {
  $wrong = $request.Clone(); $wrong[$entry[0]] = $entry[1]
  Check ("reject wrong " + $entry[0]) $false $wrong
}
$pending = $request.Clone(); $pending.Remove('helperPid')
Check 'await helper acknowledgement' $false $pending
Check 'reject unmanaged helper path' $false $request "C:\other\$operation\helper.exe"
Check 'reject old basename' $false $request (Join-Path $root "$operation\open-science-update-progress.exe")
$malformedRejected = $false
try { [HandoffObserver]::MatchesOperation('{',$helper,$root,100,101,$application,$installer) | Out-Null }
catch { $malformedRejected = $true }
if (-not $malformedRejected) { throw 'Malformed request was silently accepted' }
@{status='PASS';records=$records;malformedRejected=$true} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output
