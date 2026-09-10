<# Run only on an elevated, ephemeral Windows test host. #>
param([Parameter(Mandatory = $true)][string]$Exe)
$ErrorActionPreference = 'Stop'
$reservation = @{ listener = $null }
$failures = 0
try {
  foreach ($attempt in 1..2) {
    try {
      & "$PSScriptRoot/smoke.ps1" -Exe $Exe -AfterSetup {
        param([int]$Port)
        $reservation.listener = [Net.Sockets.UdpClient]::new()
        $reservation.listener.ExclusiveAddressUse = $true
        $reservation.listener.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, $Port))
        Write-Host "[regression] exclusively bound UDP port $Port; TCP gateway remains available"
      }
    } catch {
      $failures++
      Write-Host "[regression] failure: $($_.Exception.ToString())"
      Write-Host $_.ScriptStackTrace
      & netsh.exe interface ipv4 show excludedportrange protocol=udp
    } finally {
      if ($reservation.listener) { $reservation.listener.Dispose(); $reservation.listener = $null }
    }
  }
  if ($failures) { throw "Smoke test failed $failures times with a TCP-only gateway port" }
} finally {
  if ($reservation.listener) { $reservation.listener.Dispose() }
}
