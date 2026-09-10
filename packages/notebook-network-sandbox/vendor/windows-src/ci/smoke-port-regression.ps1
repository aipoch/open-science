<# Run only on an elevated, ephemeral Windows test host. #>
param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'Stop'
$env:SMOKE_REAL_HOST = (Resolve-Path $Exe).Path
$wrapper = Join-Path $env:TEMP "smoke-host-wrapper-$PID.ps1"
$env:SMOKE_RESERVED_PORT_FILE = Join-Path $env:TEMP "smoke-reserved-port-$PID.txt"
@'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NativeArguments)
$output = & $env:SMOKE_REAL_HOST @NativeArguments
$code = $LASTEXITCODE
if ($code -ne 0) { throw "Native host exited $code" }
if ($NativeArguments[0] -eq 'status' -and -not (Test-Path $env:SMOKE_RESERVED_PORT_FILE)) {
  $status = $output | ConvertFrom-Json
  $port = [int]$status.gatewayPort
  if ($port -lt 1) { throw 'Native setup did not allocate a TCP gateway port.' }
  $result = & netsh.exe interface ipv4 add excludedportrange protocol=udp startport=$port numberofports=1 store=active
  if ($LASTEXITCODE -ne 0) { throw "Could not reserve UDP port ${port}: $result" }
  Set-Content -LiteralPath $env:SMOKE_RESERVED_PORT_FILE -Value $port
  Write-Host "[regression] reserved UDP port $port; TCP gateway remains available"
}
$output
'@ | Set-Content -LiteralPath $wrapper -Encoding UTF8
$failures = 0
try {
  foreach ($attempt in 1..2) {
    try {
      & "$PSScriptRoot/smoke.ps1" -Exe $wrapper
    } catch {
      $failures++
      Write-Host "[regression] failure: $($_.Exception.ToString())"
      Write-Host $_.ScriptStackTrace
      & netsh.exe interface ipv4 show excludedportrange protocol=udp
    } finally {
      if (Test-Path $env:SMOKE_RESERVED_PORT_FILE) {
        $port = [int](Get-Content -LiteralPath $env:SMOKE_RESERVED_PORT_FILE)
        & netsh.exe interface ipv4 delete excludedportrange protocol=udp startport=$port numberofports=1 store=active
        if ($LASTEXITCODE -ne 0) { throw "Could not remove test-owned UDP exclusion $port" }
        Remove-Item -LiteralPath $env:SMOKE_RESERVED_PORT_FILE
      }
    }
  }
  if ($failures) { throw "Smoke test failed $failures times with a TCP-only gateway port" }
} finally {
  Remove-Item -LiteralPath $wrapper -ErrorAction SilentlyContinue
  Remove-Item Env:SMOKE_REAL_HOST, Env:SMOKE_RESERVED_PORT_FILE
}
