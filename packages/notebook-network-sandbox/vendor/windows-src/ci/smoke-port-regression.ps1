<# Run only on an elevated, ephemeral Windows test host. #>
param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'Stop'
$reservation = Join-Path $env:TEMP "smoke-reserved-port-$PID.txt"
$failures = 0
try {
  foreach ($attempt in 1..2) {
    try {
      & "$PSScriptRoot/smoke.ps1" -Exe $Exe -AfterSetup {
        param([int]$Port)
        $result = & netsh.exe interface ipv4 add excludedportrange protocol=udp startport=$Port numberofports=1 store=active
        if ($LASTEXITCODE -ne 0) { throw "Could not reserve UDP port ${Port}: $result" }
        Set-Content -LiteralPath $reservation -Value $Port
        Write-Host "[regression] reserved UDP port $Port; TCP gateway remains available"
      }
    } catch {
      $failures++
      Write-Host "[regression] failure: $($_.Exception.ToString())"
      Write-Host $_.ScriptStackTrace
      & netsh.exe interface ipv4 show excludedportrange protocol=udp
    } finally {
      if (Test-Path $reservation) {
        $port = [int](Get-Content -LiteralPath $reservation)
        & netsh.exe interface ipv4 delete excludedportrange protocol=udp startport=$port numberofports=1 store=active
        if ($LASTEXITCODE -ne 0) { throw "Could not remove test-owned UDP exclusion $port" }
        Remove-Item -LiteralPath $reservation
      }
    }
  }
  if ($failures) { throw "Smoke test failed $failures times with a TCP-only gateway port" }
} finally {
  Remove-Item -LiteralPath $reservation -ErrorAction SilentlyContinue
}
